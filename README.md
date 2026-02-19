# Fluxer Desktop Client

A universal Electron desktop client for **any** [Fluxer](https://fluxer.app) server — the free and open source Discord alternative.

> **All credit for the Fluxer platform goes to the Fluxer team.**
> This desktop client is a community wrapper. The core Fluxer application, server software, web app, and all associated intellectual property belong to the original Fluxer developers.
> Official project: [github.com/fluxerapp/fluxer](https://github.com/fluxerapp/fluxer)

---

## Works with any Fluxer server

This client is **not tied to any specific server**. On first launch you enter the URL of whichever Fluxer instance you want to connect to — your own self-hosted server, a friend's server, or any public Fluxer community. You can switch servers at any time.

**Examples of server URLs this client works with:**
```
https://chat.example.com
https://fluxer.myfamily.net
http://192.168.1.10:3000
http://localhost:3000
```

Any Fluxer server, any domain, any port — if Fluxer runs there, this client connects to it.

---

## What this adds over the browser

Fluxer already works great in a browser. This client wraps it in a native desktop window and adds:

- **System tray** — minimize to tray, keep running in the background
- **Global push-to-talk (PTT)** — PTT keybind works even when the window is unfocused or minimized
- **Custom keybinds** — assign global hotkeys for any Fluxer action
- **Screen sharing** — full desktop/window capture support including LAN connections
- **Desktop notifications** — native OS notifications
- **Configurable server** — switch between any Fluxer server from the tray menu
- **Zoom controls** — Ctrl+`+` / Ctrl+`-` / Ctrl+`0`
- **Spellcheck** — built-in spell checking
- **Auto-start on login** — optional, configured from within Fluxer's settings

---

## Getting started

### Step 1 — Download

Get the latest release from the [Releases page](https://github.com/shadowflee3/fluxer-client/releases):

| Platform | File |
|----------|------|
| Windows 10/11 (x64) | `Fluxer Setup x.x.x.exe` |
| Linux (x64) portable | `Fluxer-x.x.x.AppImage` |
| Linux Debian/Ubuntu (x64) | `fluxer_x.x.x_amd64.deb` |

### Step 2 — Connect to your server

On first launch a setup screen will appear asking for your Fluxer server URL:

```
Enter server URL: https://your-fluxer-server.com
```

Type in the address of any Fluxer server and click **Connect**. That's it — the app opens and you're in.

### Step 3 — Changing servers later

You can switch to a different Fluxer server at any time:
- Right-click the **system tray icon** → **Change Server URL…**

Your chosen server is saved locally on your machine and never shared anywhere.

---

## Building from source

```bash
git clone https://github.com/shadowflee3/fluxer-client
cd fluxer-client
npm install

# Run in development (prompts for server URL on first run)
npm start

# Build Linux packages (AppImage + deb)
npx electron-builder --linux --x64

# Build Windows installer (requires Wine on Linux, or run natively on Windows)
npx electron-builder --win --x64
```

---

## Credits

- **Fluxer** — the application, web client, server, and all platform code
  - Website: [fluxer.app](https://fluxer.app)
  - GitHub: [github.com/fluxerapp/fluxer](https://github.com/fluxerapp/fluxer)
  - License: GNU AGPL v3

- **This desktop wrapper** is maintained by [shadowflee](https://github.com/shadowflee3) and is not affiliated with or endorsed by the official Fluxer project.

---

## License

This wrapper is provided as-is for personal use. The Fluxer platform itself is licensed under the [GNU Affero General Public License v3](https://www.gnu.org/licenses/agpl-3.0.html). Please respect the original project's license when self-hosting or distributing.
