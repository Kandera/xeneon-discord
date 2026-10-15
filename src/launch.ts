import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = join(root, "bin", "DiscordEdge.exe");

if (!existsSync(exe)) {
  console.error("Missing bin/DiscordEdge.exe. Run npm run build:tray first.");
  process.exit(1);
}

spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
