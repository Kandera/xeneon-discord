# Discord Edge

Voice board for the CORSAIR XENEON EDGE. The bridge talks to Discord Desktop over the local RPC pipe. The iCUE widget only talks to `127.0.0.1:47331`. No user token, no marketplace purchase.

Soundboard, camera, and screen share are not in the public RPC list, so they are not included.

## Start

```
cd xeneon-discord
npm start
```

That opens Discord Edge in the system tray. No console window. It also starts with Windows the first time. Right-click the tray icon to turn that off, or to quit.

Log: `%LOCALAPPDATA%\XeneonDiscord\bridge.log`

Client ID, client secret, and tokens live only in `%LOCALAPPDATA%\XeneonDiscord\config.json`. That file is not part of this repo. Do not commit it, and do not paste a secret or token into an issue.

The dock button switches between two microphones. Tap the mark on that button to choose them. The choice stays in the local config, not in this repo.

Preview without Discord: `npm run demo`, then http://127.0.0.1:47331/preview/

## Discord app

1. https://discord.com/developers/applications → New Application. The app is yours. Your own account does not need partner approval.
2. OAuth2 → Redirects → exactly `http://127.0.0.1:47331/oauth/callback` → Save Changes.
3. Paste the client ID and client secret into the widget. Discord then shows a permission window. If it does not: tap **Browser login** in the widget.

Scopes: `identify`, `rpc`, `rpc.voice.read`, `rpc.voice.write`, `rpc.notifications.read`, `messages.read`, `guilds`.

## iCUE

```
npm install -g icuewidget-cli
icuewidget package widget
```

Import the `.icuewidget` in iCUE and place it on the XENEON EDGE. On first start, allow the URL permission for `127.0.0.1:47331`.
