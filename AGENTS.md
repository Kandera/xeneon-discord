## Where this repo lives

Source: `omarchy-lenovo:~/Projects/xeneon-discord` (since 2026-11-18). Edit, commit and push there.

Windows test copy: `E:\Projects\xeneon-discord` on the desktop `kanderapc`, no `.git`. Never edit it; the next sync overwrites it. To test on Windows, run `pc-sync xeneon-discord` on `omarchy-lenovo`, then test on the desktop. `hc exec --on kanderapc '<cmd>'` runs a command there. Windows paths in this repo (`C:\Users\max\...`, `E:\...`) are on the desktop; reach them with `ssh kanderapc`. Details: `machine-setup` README section Repos.

It runs from the test copy (Startup shortcut `Discord Edge.lnk`, `bin\DiscordEdge.exe` plus `node src\index.ts`). Restart it after `pc-sync`. `bin\` is built on the desktop; `pc-sync` leaves it alone.
