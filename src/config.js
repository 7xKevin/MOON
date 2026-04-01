const path = require("node:path");
const dotenv = require("dotenv");
const { z } = require("zod");

dotenv.config();

const booleanFromEnv = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const optionalString = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return value;
}, z.string().min(1).optional());

const optionalCsv = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}, z.array(z.string()).default([]));

const schema = z.object({
  SERVICE_MODE: z.enum(["bot", "web", "all"]).default("bot"),
  HOST: z.string().default("::"),
  PORT: z.coerce.number().int().positive().default(3000),
  PREFIX: z.string().default("!"),
  WAKE_WORD: z.string().default("moon"),
  REQUIRE_WAKE_WORD: booleanFromEnv.default(true),
  DISCORD_TOKEN: optionalString,
  DISCORD_CLIENT_ID: optionalString,
  DISCORD_CLIENT_SECRET: optionalString,
  APP_BASE_URL: optionalString,
  SESSION_SECRET: optionalString,
  DASHBOARD_SUPER_ADMIN_IDS: optionalCsv,
  DATABASE_URL: optionalString,
  DATA_DIR: z.string().default(path.join(process.cwd(), "data")),
  CONTROLLER_USER_ID: optionalString,
  GROQ_API_KEY: optionalString,
  GROQ_STT_MODEL: z.string().default("whisper-large-v3"),
  GROQ_STT_URL: z.string().default("https://api.groq.com/openai/v1/audio/transcriptions"),
  WHISPER_CPP_PATH: optionalString,
  WHISPER_MODEL_PATH: optionalString,
  WHISPER_SERVER_PATH: optionalString,
  WHISPER_SERVER_URL: optionalString,
  WHISPER_SERVER_PORT: z.coerce.number().int().positive().default(8081),
  WHISPER_LANGUAGE: z.string().default("en"),
  WHISPER_PROMPT: z
    .string()
    .default("Short deterministic Discord voice commands only. Examples: lock vc, unlock vc, mute me, mute aditya, unmute aditya, disconnect me, disconnect aditya, disconnect all, drag me here, drag me to general, drag aditya to waiting room, drag all from general to admin, role add aditya role moderator, role remove aditya role moderator. Ignore unrelated conversation."),
  WHISPER_BEAM_SIZE: z.coerce.number().int().positive().default(5),
  WHISPER_BEST_OF: z.coerce.number().int().positive().default(5),
  WHISPER_TEMPERATURE: z.coerce.number().min(0).max(1).default(0),
  TEMP_DIR: z.string().default(path.join(process.cwd(), "tmp")),
  TRANSCRIPTION_SILENCE_MS: z.coerce.number().int().positive().default(550),
  COMMAND_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(250),
  DEBUG_TRANSCRIPTS: booleanFromEnv.default(false),
  MIN_COMMAND_AUDIO_MS: z.coerce.number().int().positive().default(320),
  MAX_QUEUED_COMMAND_AGE_MS: z.coerce.number().int().positive().default(4500),
  DASHBOARD_GUILD_CACHE_MS: z.coerce.number().int().positive().default(120000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `- ${issue.message}`)
    .join("\n");

  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const config = parsed.data;

function requireSetting(key, when) {
  if (!config[key]) {
    throw new Error(`${key} is required when ${when}.`);
  }
}

if (config.SERVICE_MODE === "bot" || config.SERVICE_MODE === "all") {
  requireSetting("DISCORD_TOKEN", "running the bot");

  const hasGroq = Boolean(config.GROQ_API_KEY);
  const hasLocalWhisper = Boolean(config.WHISPER_CPP_PATH && config.WHISPER_MODEL_PATH);

  if (!hasGroq && !hasLocalWhisper) {
    throw new Error(
      "You must configure GROQ_API_KEY or both WHISPER_CPP_PATH and WHISPER_MODEL_PATH when running the bot."
    );
  }

  if (process.env.NODE_ENV === "production") {
    requireSetting("DATABASE_URL", "running the bot in production with dashboard-managed settings");
  }
}

if (config.SERVICE_MODE === "web" || config.SERVICE_MODE === "all") {
  requireSetting("DISCORD_CLIENT_ID", "running the dashboard");
  requireSetting("DISCORD_CLIENT_SECRET", "running the dashboard");
  requireSetting("SESSION_SECRET", "running the dashboard");

  if (process.env.NODE_ENV === "production") {
    requireSetting("DATABASE_URL", "running the dashboard in production");
  }
}

const appBaseUrl = config.APP_BASE_URL ?? `http://localhost:${config.PORT}`;
const whisperServerUrl = config.WHISPER_SERVER_URL ?? `http://127.0.0.1:${config.WHISPER_SERVER_PORT}/v1/audio/transcriptions`;

module.exports = {
  config: {
    ...config,
    appBaseUrl,
    oauthRedirectUri: `${appBaseUrl}/auth/discord/callback`,
    whisperServerUrl,
    hasGroqStt: Boolean(config.GROQ_API_KEY),
    hasLocalWhisper: Boolean(config.WHISPER_CPP_PATH && config.WHISPER_MODEL_PATH),
    isProduction: process.env.NODE_ENV === "production",
  },
};




