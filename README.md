# Fluxer Desktop Client

An unofficial Electron desktop wrapper for [Fluxer](https://fluxer.app) — a free and open source Discord alternative.

> **All credit for the Fluxer platform goes to the Fluxer team.**
> This desktop client is a community wrapper. The core Fluxer application, server software, web app, and all associated intellectual property belong to the original Fluxer developers.
> Official project: [github.com/fluxerapp/fluxer](https://github.com/fluxerapp/fluxer)

---

## What this is

Fluxer is a web-based chat platform. This client wraps it in an Electron window so you get:

- Native system tray with minimize-to-tray
- Global push-to-talk (PTT) keybind that works even when the window is unfocused
- Screen sharing support
- Desktop notifications
- Configurable server URL — connect to any self-hosted Fluxer instance
- Zoom controls (Ctrl+`+` / Ctrl+`-` / Ctrl+`0`)
- Spellcheck integration
- Auto-start on login (optional)
- Custom keybind support

## Downloads

Get the latest release from the [Releases page](https://github.com/shadowflee3/fluxer-client/releases):

| Platform | File |
|----------|------|
| Windows 10/11 (x64) | `Fluxer Setup x.x.x.exe` |
| Linux (x64) portable | `Fluxer-x.x.x.AppImage` |
| Linux Debian/Ubuntu (x64) | `fluxer_x.x.x_amd64.deb` |

## First Run

On first launch you will be asked for your Fluxer server URL (e.g. `https://chat.shadowflee.com`). This is saved locally and can be changed any time from the system tray icon → **Change Server URL…**

## Building from source

```bash
git clone https://github.com/shadowflee3/fluxer-client
cd fluxer-client
npm install

# Run in development
npm start

# Build Linux packages (AppImage + deb)
npx electron-builder --linux --x64

# Build Windows installer (requires Wine on Linux)
npx electron-builder --win --x64
```

## Credits

- **Fluxer** — the application, web client, server, and all platform code
  - Website: [fluxer.app](https://fluxer.app)
  - GitHub: [github.com/fluxerapp/fluxer](https://github.com/fluxerapp/fluxer)
  - License: GNU AGPL v3

- **This desktop wrapper** is maintained by [shadowflee](https://github.com/shadowflee3) and is not affiliated with or endorsed by the official Fluxer project.

## License

This wrapper is provided as-is for personal use. The Fluxer platform itself is licensed under the [GNU Affero General Public License v3](https://www.gnu.org/licenses/agpl-3.0.html). Please respect the original project's license when self-hosting or distributing.
