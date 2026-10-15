/** Keep in sync with widget/manifest.json and widget/scripts/widget.js. */
export const PORT = 47331;
export const HEADER = "x-edge-discord";
export const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth/callback`;

export const SCOPES = [
  "identify",
  "rpc",
  "rpc.voice.read",
  "rpc.voice.write",
  "rpc.notifications.read",
  "messages.read",
  "guilds",
] as const;
