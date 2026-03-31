const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function parseStringList(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    if (trimmed.startsWith("[")) {
      try {
        return uniqueStrings(JSON.parse(trimmed));
      } catch {
        return uniqueStrings(trimmed.split(/[,\n]/g));
      }
    }

    return uniqueStrings(trimmed.split(/[\n,]/g));
  }

  return [];
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeGuildSettings(input = {}, defaults = {}) {
  return {
    guildId: String(input.guildId ?? "").trim(),
    guildName: String(input.guildName ?? "Unknown Server").trim() || "Unknown Server",
    botEnabled: input.botEnabled !== false,
    adminUserIds: parseStringList(input.adminUserIds),
    commandUserIds: parseStringList(input.commandUserIds),
    allowedRoleIds: parseStringList(input.allowedRoleIds),
    preferredTextChannelId: input.preferredTextChannelId ? String(input.preferredTextChannelId).trim() : "",
    preferredVoiceChannelId: input.preferredVoiceChannelId ? String(input.preferredVoiceChannelId).trim() : "",
    botPresent: input.botPresent === true,
    botLastSeenAt: input.botLastSeenAt ? new Date(input.botLastSeenAt).toISOString() : null,
    debugTranscripts: input.debugTranscripts === true,
    transcriptionEnabled: input.transcriptionEnabled !== false,
    wakeWord: String(input.wakeWord ?? defaults.wakeWord ?? "moon").trim() || "moon",
    requireWakeWord:
      input.requireWakeWord === undefined
        ? defaults.requireWakeWord !== false
        : input.requireWakeWord === true,
    transcriptionSilenceMs: normalizePositiveInteger(
      input.transcriptionSilenceMs,
      defaults.transcriptionSilenceMs ?? 1200
    ),
    commandCooldownMs: normalizePositiveInteger(
      input.commandCooldownMs,
      defaults.commandCooldownMs ?? 900
    ),
    commandDragEnabled: input.commandDragEnabled !== false,
    commandMuteEnabled: input.commandMuteEnabled !== false,
    commandKickEnabled: input.commandKickEnabled !== false,
    commandLockEnabled: input.commandLockEnabled !== false,
    updatedAt: input.updatedAt ? new Date(input.updatedAt).toISOString() : new Date().toISOString(),
  };
}

function createDefaultGuildSettings(guildId, guildName, defaults = {}) {
  return normalizeGuildSettings(
    {
      guildId,
      guildName,
    },
    defaults
  );
}

class FileSettingsStore {
  constructor(config) {
    this.filePath = path.join(config.DATA_DIR, "guild-settings.json");
    this.defaults = {
      wakeWord: config.WAKE_WORD,
      requireWakeWord: config.REQUIRE_WAKE_WORD,
      transcriptionSilenceMs: config.TRANSCRIPTION_SILENCE_MS,
      commandCooldownMs: config.COMMAND_COOLDOWN_MS,
    };
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify({}, null, 2));
    }
  }

  async readAll() {
    const raw = await fs.readFile(this.filePath, "utf8");
    return JSON.parse(raw);
  }

  async writeAll(data) {
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
  }

  async getGuildSettings(guildId, guildName = "Unknown Server") {
    const all = await this.readAll();
    return normalizeGuildSettings(
      all[guildId] ?? createDefaultGuildSettings(guildId, guildName, this.defaults),
      this.defaults
    );
  }

  async saveGuildSettings(settings) {
    const normalized = normalizeGuildSettings(settings, this.defaults);
    const all = await this.readAll();
    all[normalized.guildId] = normalized;
    await this.writeAll(all);
    return normalized;
  }

  async resetBotPresence() {
    const all = await this.readAll();

    for (const guildId of Object.keys(all)) {
      all[guildId] = {
        ...all[guildId],
        botPresent: false,
      };
    }

    await this.writeAll(all);
  }

  async updateBotPresence(guildId, guildName, botPresent) {
    const current = await this.getGuildSettings(guildId, guildName);
    return this.saveGuildSettings({
      ...current,
      guildId,
      guildName,
      botPresent,
      botLastSeenAt: botPresent ? new Date().toISOString() : current.botLastSeenAt,
    });
  }
}

class PostgresSettingsStore {
  constructor(config) {
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      ssl: config.isProduction ? { rejectUnauthorized: false } : false,
    });
    this.defaults = {
      wakeWord: config.WAKE_WORD,
      requireWakeWord: config.REQUIRE_WAKE_WORD,
      transcriptionSilenceMs: config.TRANSCRIPTION_SILENCE_MS,
      commandCooldownMs: config.COMMAND_COOLDOWN_MS,
    };
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        guild_name TEXT NOT NULL,
        bot_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        admin_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        command_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        allowed_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        preferred_text_channel_id TEXT,
        preferred_voice_channel_id TEXT,
        bot_present BOOLEAN NOT NULL DEFAULT FALSE,
        bot_last_seen_at TIMESTAMPTZ,
        debug_transcripts BOOLEAN NOT NULL DEFAULT FALSE,
        transcription_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        wake_word TEXT NOT NULL DEFAULT 'moon',
        require_wake_word BOOLEAN NOT NULL DEFAULT TRUE,
        transcription_silence_ms INTEGER NOT NULL DEFAULT 1200,
        command_cooldown_ms INTEGER NOT NULL DEFAULT 900,
        command_drag_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        command_mute_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        command_kick_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        command_lock_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      ALTER TABLE guild_settings
      ADD COLUMN IF NOT EXISTS bot_present BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS bot_last_seen_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS wake_word TEXT NOT NULL DEFAULT 'moon',
      ADD COLUMN IF NOT EXISTS require_wake_word BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS transcription_silence_ms INTEGER NOT NULL DEFAULT 1200,
      ADD COLUMN IF NOT EXISTS command_cooldown_ms INTEGER NOT NULL DEFAULT 900,
      ADD COLUMN IF NOT EXISTS transcription_enabled BOOLEAN NOT NULL DEFAULT TRUE
    `);
  }

  async getGuildSettings(guildId, guildName = "Unknown Server") {
    const result = await this.pool.query(
      `SELECT * FROM guild_settings WHERE guild_id = $1`,
      [guildId]
    );

    if (!result.rowCount) {
      return createDefaultGuildSettings(guildId, guildName, this.defaults);
    }

    const row = result.rows[0];
    return normalizeGuildSettings(
      {
        guildId: row.guild_id,
        guildName: row.guild_name,
        botEnabled: row.bot_enabled,
        adminUserIds: row.admin_user_ids,
        commandUserIds: row.command_user_ids,
        allowedRoleIds: row.allowed_role_ids,
        preferredTextChannelId: row.preferred_text_channel_id,
        preferredVoiceChannelId: row.preferred_voice_channel_id,
        botPresent: row.bot_present,
        botLastSeenAt: row.bot_last_seen_at,
        debugTranscripts: row.debug_transcripts,
        transcriptionEnabled: row.transcription_enabled,
        wakeWord: row.wake_word,
        requireWakeWord: row.require_wake_word,
        transcriptionSilenceMs: row.transcription_silence_ms,
        commandCooldownMs: row.command_cooldown_ms,
        commandDragEnabled: row.command_drag_enabled,
        commandMuteEnabled: row.command_mute_enabled,
        commandKickEnabled: row.command_kick_enabled,
        commandLockEnabled: row.command_lock_enabled,
        updatedAt: row.updated_at,
      },
      this.defaults
    );
  }

  async saveGuildSettings(settings) {
    const normalized = normalizeGuildSettings(settings, this.defaults);

    await this.pool.query(
      `
        INSERT INTO guild_settings (
          guild_id,
          guild_name,
          bot_enabled,
          admin_user_ids,
          command_user_ids,
          allowed_role_ids,
          preferred_text_channel_id,
          preferred_voice_channel_id,
          bot_present,
          bot_last_seen_at,
          debug_transcripts,
          transcription_enabled,
          wake_word,
          require_wake_word,
          transcription_silence_ms,
          command_cooldown_ms,
          command_drag_enabled,
          command_mute_enabled,
          command_kick_enabled,
          command_lock_enabled,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW()
        )
        ON CONFLICT (guild_id)
        DO UPDATE SET
          guild_name = EXCLUDED.guild_name,
          bot_enabled = EXCLUDED.bot_enabled,
          admin_user_ids = EXCLUDED.admin_user_ids,
          command_user_ids = EXCLUDED.command_user_ids,
          allowed_role_ids = EXCLUDED.allowed_role_ids,
          preferred_text_channel_id = EXCLUDED.preferred_text_channel_id,
          preferred_voice_channel_id = EXCLUDED.preferred_voice_channel_id,
          bot_present = EXCLUDED.bot_present,
          bot_last_seen_at = EXCLUDED.bot_last_seen_at,
          debug_transcripts = EXCLUDED.debug_transcripts,
          transcription_enabled = EXCLUDED.transcription_enabled,
          wake_word = EXCLUDED.wake_word,
          require_wake_word = EXCLUDED.require_wake_word,
          transcription_silence_ms = EXCLUDED.transcription_silence_ms,
          command_cooldown_ms = EXCLUDED.command_cooldown_ms,
          command_drag_enabled = EXCLUDED.command_drag_enabled,
          command_mute_enabled = EXCLUDED.command_mute_enabled,
          command_kick_enabled = EXCLUDED.command_kick_enabled,
          command_lock_enabled = EXCLUDED.command_lock_enabled,
          updated_at = NOW()
      `,
      [
        normalized.guildId,
        normalized.guildName,
        normalized.botEnabled,
        JSON.stringify(normalized.adminUserIds),
        JSON.stringify(normalized.commandUserIds),
        JSON.stringify(normalized.allowedRoleIds),
        normalized.preferredTextChannelId || null,
        normalized.preferredVoiceChannelId || null,
        normalized.botPresent,
        normalized.botLastSeenAt ? new Date(normalized.botLastSeenAt) : null,
        normalized.debugTranscripts,
        normalized.transcriptionEnabled,
        normalized.wakeWord,
        normalized.requireWakeWord,
        normalized.transcriptionSilenceMs,
        normalized.commandCooldownMs,
        normalized.commandDragEnabled,
        normalized.commandMuteEnabled,
        normalized.commandKickEnabled,
        normalized.commandLockEnabled,
      ]
    );

    return this.getGuildSettings(normalized.guildId, normalized.guildName);
  }

  async resetBotPresence() {
    await this.pool.query(`UPDATE guild_settings SET bot_present = FALSE`);
  }

  async updateBotPresence(guildId, guildName, botPresent) {
    const current = await this.getGuildSettings(guildId, guildName);
    return this.saveGuildSettings({
      ...current,
      guildId,
      guildName,
      botPresent,
      botLastSeenAt: botPresent ? new Date().toISOString() : current.botLastSeenAt,
    });
  }
}

function createSettingsStore(config) {
  if (config.DATABASE_URL) {
    return new PostgresSettingsStore(config);
  }

  return new FileSettingsStore(config);
}

module.exports = {
  createDefaultGuildSettings,
  createSettingsStore,
  normalizeGuildSettings,
  parseStringList,
};

