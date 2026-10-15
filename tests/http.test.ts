import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import test from "node:test";
import { HEADER } from "../src/constants.ts";
import { createApp, type Bridge } from "../src/http.ts";
import { blankModel, snapshot, type Snapshot } from "../src/state.ts";

function bridge(): Bridge & { actions: unknown[] } {
  const model = blankModel();
  model.phase = "ready";
  const listeners = new Set<(snap: Snapshot) => void>();
  return {
    actions: [],
    snapshot: () => snapshot(model, 0),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async setup(input) {
      assert.equal(input.clientSecret, "secret-value");
      return { ok: true };
    },
    async action(body) {
      this.actions.push(body);
      return { ok: true };
    },
    async avatar() {
      return null;
    },
  };
}

async function listen(app: Server): Promise<number> {
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const address = app.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

test("state requires the widget header and hides nothing it does not have", async () => {
  const app = createApp(bridge(), ".");
  const port = await listen(app);
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/v1/state`);
    assert.equal(denied.status, 403);
    const allowed = await fetch(`http://127.0.0.1:${port}/v1/state`, { headers: { [HEADER]: "1" } });
    assert.equal(allowed.status, 200);
    const body = await allowed.json() as Snapshot;
    assert.equal(body.phase, "ready");
    assert.equal("clientSecret" in body, false);
    assert.equal("accessToken" in body, false);
  } finally {
    app.close();
  }
});

test("a website origin cannot post an action", async () => {
  const fake = bridge();
  const app = createApp(fake, ".");
  const port = await listen(app);
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/v1/action`, {
      method: "POST",
      headers: { [HEADER]: "1", Origin: "https://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ type: "mute" }),
    });
    assert.equal(denied.status, 403);
    assert.equal(fake.actions.length, 0);
    const allowed = await fetch(`http://127.0.0.1:${port}/v1/action`, {
      method: "POST",
      headers: { [HEADER]: "1", Origin: "null", "Content-Type": "application/json" },
      body: JSON.stringify({ type: "mute" }),
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(fake.actions, [{ type: "mute" }]);
  } finally {
    app.close();
  }
});

test("events push the current snapshot", async () => {
  const app = createApp(bridge(), ".");
  const port = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/events`, { headers: { [HEADER]: "1" } });
    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    assert.match(text, /"phase":"ready"/);
    await reader.cancel();
  } finally {
    app.close();
  }
});
