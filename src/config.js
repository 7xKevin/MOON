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
  WHISPER_CPP_PATH: optionalString,
  WHISPER_MODEL_PATH: optionalString,
  WHISPER_LANGUAGE: z.string().default("en"),
  WHISPER_PROMPT: z
    .string()
    .default("Discord voice commands like lock, unlock, mute, unmute, kick, and drag users here."),
  WHISPER_BEAM_SIZE: z.coerce.number().int().positive().default(5),
  WHISPER_BEST_OF: z.coerce.number().int().positive().default(5),
  WHISPER_TEMPERATURE: z.coerce.number().min(0).max(1).default(0),
  TEMP_DIR: z.string().default(path.join(process.cwd(), "tmp")),
  TRANSCRIPTION_SILENCE_MS: z.coerce.number().int().positive().default(1200),
  COMMAND_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(2500),
  DEBUG_TRANSCRIPTS: booleanFromEnv.default(false),
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
  requireSetting("WHISPER_CPP_PATH", "running the bot");
  requireSetting("WHISPER_MODEL_PATH", "running the bot");
}

if (config.SERVICE_MODE === "web" || config.SERVICE_MODE === "all") {
  requireSetting("DISCORD_CLIENT_ID", "running the dashboard");
  requireSetting("DISCORD_CLIENT_SECRET", "running the dashboard");
  requireSetting("SESSION_SECRET", "running the dashboard");
}

const appBaseUrl = config.APP_BASE_URL ?? `http://localhost:${config.PORT}`;

module.exports = {
  config: {
    ...config,
    appBaseUrl,
    oauthRedirectUri: `${appBaseUrl}/auth/discord/callback`,
    isProduction: process.env.NODE_ENV === "production",
  },
};
