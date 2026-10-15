import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, normalize, resolve } from "node:path";
import { HEADER, PORT } from "./constants.ts";
import { asRecord, type Snapshot } from "./state.ts";

export interface Bridge {
  snapshot(): Snapshot;
  subscribe(listener: (snap: Snapshot) => void): () => void;
  setup(input: { clientId: string; clientSecret: string }): Promise<{ ok: boolean; detail?: string }>;
  action(body: unknown): Promise<Record<string, unknown>>;
  avatar(id: string): Promise<{ bytes: Buffer; type: string } | null>;
  completeOauth?(code: string, state: string): Promise<boolean>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
export function createApp(bridge: Bridge, widgetRoot: string): Server {
  return createServer((request, response) => {
    handle(bridge, widgetRoot, request, response).catch((error: unknown) => {
      if (response.headersSent) return;
      const detail = error instanceof Error ? error.message : "bad request";
      response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, detail }));
    });
  });
}

async function handle(bridge: Bridge, widgetRoot: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  const origin = request.headers.origin;
  if (!originAllowed(origin)) {
    send(response, 403, { ok: false, detail: "forbidden" }, origin);
    return;
  }
  if (request.method === "OPTIONS") {
    send(response, 204, null, origin);
    return;
  }
  if (request.method === "GET" && url.pathname === "/oauth/callback") {
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const accepted = bridge.completeOauth ? await bridge.completeOauth(code, state) : false;
    const page = accepted
      ? "<p>Discord is connected. You can close this window.</p>"
      : "<p>This link expired. Tap Browser login in the widget again.</p>";
    response.writeHead(accepted ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html lang="en"><body>${page}</body></html>`);
    return;
  }
  if (request.method === "GET" && (url.pathname === "/preview" || url.pathname.startsWith("/preview/"))) {
    serveWidget(widgetRoot, url.pathname, response);
    return;
  }
  const widgetRead = request.method === "GET" && (url.pathname === "/v1/events" || /^\/v1\/avatar\/\d{5,32}$/.test(url.pathname));
  if (!widgetRead && !clientAllowed(request)) {
    send(response, 403, { ok: false, detail: "forbidden" }, origin);
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/state") {
    send(response, 200, bridge.snapshot(), origin);
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/events") {
    stream(bridge, response, origin);
    return;
  }
  const avatarId = url.pathname.match(/^\/v1\/avatar\/(\d{5,32})$/)?.[1];
  if (request.method === "GET" && avatarId) {
    const image = await bridge.avatar(avatarId);
    if (!image) {
      send(response, 404, { ok: false, detail: "no avatar" }, origin);
      return;
    }
    response.writeHead(200, {
      "Content-Type": image.type,
      "Cache-Control": "no-cache",
      ...cors(origin),
    });
    response.end(image.bytes);
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/setup") {
    const body = asRecord(await readBody(request));
    const clientId = typeof body?.clientId === "string" ? body.clientId : "";
    const clientSecret = typeof body?.clientSecret === "string" ? body.clientSecret : "";
    send(response, 200, await bridge.setup({ clientId, clientSecret }), origin);
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/action") {
    send(response, 200, await bridge.action(await readBody(request)), origin);
    return;
  }
  send(response, 404, { ok: false, detail: "not found" }, origin);
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  const value = origin.toLowerCase();
  if (value === "null" || value.startsWith("file:") || value.startsWith("qrc:")) return true;
  if (value.startsWith(`http://127.0.0.1:${PORT}`) || value.startsWith(`http://localhost:${PORT}`)) return true;
  return value.includes("icue") || value.includes("corsair") || value.includes("elgato");
}

function clientAllowed(request: IncomingMessage): boolean {
  return request.headers[HEADER] === "1";
}

function cors(origin: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": `Content-Type, ${HEADER}`,
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function send(response: ServerResponse, status: number, body: unknown, origin: string | undefined): void {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors(origin) };
  if (body === null) {
    response.writeHead(status, headers);
    response.end();
    return;
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

function stream(bridge: Bridge, response: ServerResponse, origin: string | undefined): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...cors(origin),
  });
  const write = (snap: Snapshot): void => {
    response.write(`data: ${JSON.stringify(snap)}\n\n`);
  };
  write(bridge.snapshot());
  const unsubscribe = bridge.subscribe(write);
  const beat = setInterval(() => response.write(": ping\n\n"), 15_000);
  response.on("close", () => {
    clearInterval(beat);
    unsubscribe();
  });
}

function serveWidget(root: string, pathname: string, response: ServerResponse): void {
  const relative = decodeURIComponent(pathname.replace(/^\/preview\/?/, "") || "index.html");
  const target = resolve(root, normalize(relative));
  const base = resolve(root);
  if (target !== base && !target.startsWith(`${base}\\`) && !target.startsWith(`${base}/`)) {
    response.writeHead(403);
    response.end();
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { "Content-Type": TYPES[extname(target)] ?? "application/octet-stream" });
  createReadStream(target).pipe(response);
}

function readBody(request: IncomingMessage): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const chunks: Buffer[] = [];
  let size = 0;
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 65_536) {
      reject(new Error("body too large"));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) {
      resolve({});
      return;
    }
    try {
      resolve(JSON.parse(text) as unknown);
    } catch (error) {
      reject(error);
    }
  });
  request.on("error", reject);
  return promise;
}
