import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  micA: string;
  micB: string;
}
export function configFile(): string {
  const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(base, "XeneonDiscord", "config.json");
}

export function emptyConfig(): Config {
  return { clientId: "", clientSecret: "", accessToken: "", refreshToken: "", expiresAt: 0, micA: "", micB: "" };
}

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(readFileSync(configFile(), "utf8")) as Partial<Config>;
    return {
      clientId: typeof raw.clientId === "string" ? raw.clientId : "",
      clientSecret: typeof raw.clientSecret === "string" ? raw.clientSecret : "",
      accessToken: typeof raw.accessToken === "string" ? raw.accessToken : "",
      refreshToken: typeof raw.refreshToken === "string" ? raw.refreshToken : "",
      expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : 0,
      micA: typeof raw.micA === "string" ? raw.micA : "",
      micB: typeof raw.micB === "string" ? raw.micB : "",
    };
  } catch {
    return emptyConfig();
  }
}

export function saveConfig(config: Config): void {
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
}
