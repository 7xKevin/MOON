# MOON

MOON is a Discord voice-command bot with an admin dashboard.

The repo now supports two runtime modes from the same codebase:

- `bot`: Discord bot worker with voice capture and speech transcription
- `web`: admin dashboard with Discord OAuth login and shared guild settings

## Recommended stack

For the hosted version, the best practical stack is:

- `discord.js`
- `@discordjs/voice`
- `Node.js`
- hosted speech-to-text with `Groq` as the primary provider
- optional local/offline fallback with `whisper.cpp`
- `Railway` or `Render` for hosting
- `Postgres` for shared dashboard and bot settings

## Features

### Bot

- `!join`, `!leave`, `!help`, `!dashboard`
- Groq speech-to-text as the primary path
- optional local `whisper.cpp` fallback
- voice commands:
  - `drag <name> here`
  - `drag <name> to general`
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
  - voice decoding enabled or disabled
  - transcript debugging
  - wake word and speech timing
  - voice command user IDs
  - voice command role IDs
  - preferred text channel ID
  - enable or disable drag, mute, kick, and lock commands

## Environment variables

Copy `.env.example` to `.env`.

Key variables:

- `SERVICE_MODE=bot|web|all`
- `HOST` defaults to `::` for Railway-compatible binding
- `WAKE_WORD` defaults to `moon`
- `REQUIRE_WAKE_WORD=true` makes commands require phrases like `moon lock the vc`
- `DISCORD_TOKEN` for bot mode
- `DISCORD_CLIENT_ID` for dashboard mode
- `DISCORD_CLIENT_SECRET` for dashboard mode
- `SESSION_SECRET` for dashboard mode
- `DATABASE_URL` for shared Postgres
- `GROQ_API_KEY` for Groq speech-to-text
- `GROQ_STT_MODEL` defaults to `whisper-large-v3`
- `GROQ_STT_URL` defaults to `https://api.groq.com/openai/v1/audio/transcriptions`
- `WHISPER_CPP_PATH` and `WHISPER_MODEL_PATH` are optional local fallback settings
- `WHISPER_LANGUAGE` defaults to `en`
- `WHISPER_PROMPT` seeds the transcription model with Discord command context

## Railway deployment

For the bot service, set at minimum:

- `DISCORD_TOKEN`
- `APP_BASE_URL`
- `DATABASE_URL`
- `GROQ_API_KEY`
- `SERVICE_MODE=bot`

For the web service, set:

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `SESSION_SECRET`
- `APP_BASE_URL`
- `DATABASE_URL`
- `SERVICE_MODE=web`

If `GROQ_API_KEY` is present, MOON uses Groq first and only falls back to local `whisper.cpp` if Groq fails and local Whisper is available.

## Notes

- Groq STT uses the OpenAI-compatible transcription endpoint.
- The bot still converts incoming Discord audio to `16kHz` mono WAV before transcription.
- Local `whisper.cpp` is still supported as a fallback path, but it is no longer required when Groq is configured.
- The dashboard exposes `GET /healthz` for a simple health check.


