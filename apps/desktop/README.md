# MOON Desktop

This is the companion app workspace for MOON.

## Why it lives here

The desktop app is intentionally separated from the live bot and website so we can:
- keep the current Discord bot stable
- keep the Railway website stable
- build the companion app without disturbing production services

## Current scope

This first scaffold provides:
- a lightweight Electron shell
- a Discord-like desktop layout
- a dedicated dashboard window that opens the existing MOON website
- a safe starting point for future local wake word and command capture work

## Structure

- `main.js` - Electron main process
- `preload.js` - safe bridge between renderer and Electron APIs
- `renderer/index.html` - desktop shell layout
- `renderer/styles.css` - Discord-like UI styling
- `renderer/app.js` - section switching and dashboard launch actions

## Planned next steps

1. Add device linking with the existing MOON website.
2. Add local wake-word and push-to-talk command capture.
3. Add a real desktop settings surface mirroring the website.
4. Move more dashboard actions into native desktop panels over time.

## Run locally

```powershell
cd apps\desktop
npm install
npm start
```

## Environment

You can point the desktop shell at a different MOON website with:

```powershell
$env:MOON_WEB_URL = "https://moon-production-c740.up.railway.app"
npm start
```
