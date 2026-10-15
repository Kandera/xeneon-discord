import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PORT } from "./constants.ts";
import { configFile, loadConfig } from "./config.ts";
import { DemoBridge } from "./demo.ts";
import { createApp } from "./http.ts";
import { Session } from "./session.ts";

const demo = process.argv.includes("--demo");
const widgetRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "widget");
const bridge = demo ? new DemoBridge() : new Session(loadConfig());
const server = createApp(bridge, widgetRoot);

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error("Port 47331 is already in use. Retrying.");
    setTimeout(() => server.listen(PORT, "127.0.0.1"), 2000);
    return;
  }
  throw error;
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Discord Edge listening on 127.0.0.1:${PORT}${demo ? " (demo)" : ""}`);
  if (demo) console.log(`Preview: http://127.0.0.1:${PORT}/preview/`);
  else console.log(`Credentials: ${configFile()}`);
});

if (bridge instanceof Session) bridge.start();

function shutdown(): void {
  if (bridge instanceof DemoBridge) bridge.stop();
  if (bridge instanceof Session) bridge.stop();
  server.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
