# MOON

MOON is a Discord voice-command bot with an admin dashboard.

The repo now supports two runtime modes from the same codebase:

- `bot`: Discord bot worker with voice capture and local Whisper transcription
- `web`: admin dashboard with Discord OAuth login and shared guild settings

## Correct stack

For your original idea, the stack is mostly right. The best practical version is:

- `discord.js`
- `@discordjs/voice`
- `Node.js`
- local/offline speech-to-text with `whisper.cpp`
- `Render` for hosting
- `Postgres` for shared dashboard and bot settings

`whisper.cpp` is the right local/offline Whisper path for a Node-based Discord bot.

## Architecture

Recommended Render setup:

- `moon-web`: Render web service for the admin dashboard
- `moon-bot`: Render background worker for the Discord bot
- `moon-db`: Render Postgres database for shared settings

The included `render.yaml`, `Dockerfile.web`, and `Dockerfile.bot` are set up for that model.

## Features

### Bot

- `!join`, `!leave`, `!help`, `!dashboard`
- local voice transcription with `whisper.cpp`
- voice commands:
  - `drag <name> here`
  - `mute <name>`
  - `unmute <name>`
  - `kick <name>`
  - `lock the vc`
  - `unlock the vc`
- session owner follow behavior
- server-level safety toggles from dashboard settings

### Dashboard

- Discord OAuth login
- Postgres-backed sessions in production
- lists guilds where the signed-in user has admin-level access
- per-guild settings for:
  - bot enabled or paused
  - dashboard admin user IDs
  - voice command user IDs
  - voice command role IDs
  - preferred text channel ID
  - transcript debugging
  - enable or disable drag, mute, kick, and lock commands

## Environment variables

Copy `.env.example` to `.env`.

Key variables:

- `SERVICE_MODE=bot|web|all`
- `DISCORD_TOKEN` for bot mode
- `DISCORD_CLIENT_ID` for dashboard mode
- `DISCORD_CLIENT_SECRET` for dashboard mode
- `SESSION_SECRET` for dashboard mode
- `DATABASE_URL` for shared Postgres on Render
- `WHISPER_CPP_PATH` for bot mode
- `WHISPER_MODEL_PATH` for bot mode

For Render:

- `moon-web` needs `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET`, and `APP_BASE_URL`
- `moon-bot` needs `DISCORD_TOKEN` and `APP_BASE_URL`
- both services should receive `DATABASE_URL`

## Local development

### Bot only

```powershell
npm.cmd start
```

Set:

```env
SERVICE_MODE=bot
```

### Dashboard only

```powershell
npm.cmd start
```

Set:

```env
SERVICE_MODE=web
PORT=3000
APP_BASE_URL=http://localhost:3000
DISCORD_CLIENT_ID=your_client_id
DISCORD_CLIENT_SECRET=your_client_secret
SESSION_SECRET=replace_this
```

For Discord OAuth, add this redirect URL in the Discord Developer Portal:

```text
http://localhost:3000/auth/discord/callback
```

### Both in one local process

```env
SERVICE_MODE=all
```

## Render deployment

1. Push this repo to GitHub.
2. In the Discord Developer Portal, add your Render dashboard callback URL:
   - `https://your-web-service.onrender.com/auth/discord/callback`
3. In Render, create from Blueprint using `render.yaml`, or create services manually.
4. Supply secret environment variables:
   - `moon-web`: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `APP_BASE_URL`
   - `moon-bot`: `DISCORD_TOKEN`, `APP_BASE_URL`
5. Deploy.
6. Set `APP_BASE_URL` to the full public dashboard URL for both services, for example:
   - `https://moon-web.onrender.com`

## Notes

- `Dockerfile.bot` installs `whisper.cpp` and downloads the `base.en` model during build.
- `Dockerfile.web` stays lightweight and does not build the speech stack.
- I am inferring that `base.en` is the best default starting point because it balances speed and accuracy for a hosted bot.
- If you want better accuracy and can afford higher CPU use, move up to a larger model later.
- The dashboard uses Postgres-backed sessions when `DATABASE_URL` is set.
- The dashboard exposes `GET /healthz` for a simple health check.
