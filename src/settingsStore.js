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

function normalizeGuildSettings(input = {}) {
  return {
    guildId: String(input.guildId ?? "").trim(),
    guildName: String(input.guildName ?? "Unknown Server").trim() || "Unknown Server",
    botEnabled: input.botEnabled !== false,
    adminUserIds: parseStringList(input.adminUserIds),
    commandUserIds: parseStringList(input.commandUserIds),
    allowedRoleIds: parseStringList(input.allowedRoleIds),
    preferredTextChannelId: input.preferredTextChannelId ? String(input.preferredTextChannelId).trim() : "",
    preferredVoiceChannelId: input.preferredVoiceChannelId ? String(input.preferredVoiceChannelId).trim() : "",
    debugTranscripts: input.debugTranscripts === true,
    commandDragEnabled: input.commandDragEnabled !== false,
    commandMuteEnabled: input.commandMuteEnabled !== false,
    commandKickEnabled: input.commandKickEnabled !== false,
    commandLockEnabled: input.commandLockEnabled !== false,
    updatedAt: input.updatedAt ? new Date(input.updatedAt).toISOString() : new Date().toISOString(),
  };
}

function createDefaultGuildSettings(guildId, guildName) {
  return normalizeGuildSettings({
    guildId,
    guildName,
  });
}

class FileSettingsStore {
  constructor(config) {
    this.filePath = path.join(config.DATA_DIR, "guild-settings.json");
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
    return normalizeGuildSettings(all[guildId] ?? createDefaultGuildSettings(guildId, guildName));
  }

  async saveGuildSettings(settings) {
    const normalized = normalizeGuildSettings(settings);
    const all = await this.readAll();
    all[normalized.guildId] = normalized;
    await this.writeAll(all);
    return normalized;
  }
}

class PostgresSettingsStore {
  constructor(config) {
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      ssl: config.isProduction ? { rejectUnauthorized: false } : false,
    });
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
        debug_transcripts BOOLEAN NOT NULL DEFAULT FALSE,
        command_drag_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        command_mute_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        command_kick_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        command_lock_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async getGuildSettings(guildId, guildName = "Unknown Server") {
    const result = await this.pool.query(
      `SELECT * FROM guild_settings WHERE guild_id = $1`,
      [guildId]
    );

    if (!result.rowCount) {
      return createDefaultGuildSettings(guildId, guildName);
    }

    const row = result.rows[0];
    return normalizeGuildSettings({
      guildId: row.guild_id,
      guildName: row.guild_name,
      botEnabled: row.bot_enabled,
      adminUserIds: row.admin_user_ids,
      commandUserIds: row.command_user_ids,
      allowedRoleIds: row.allowed_role_ids,
      preferredTextChannelId: row.preferred_text_channel_id,
      preferredVoiceChannelId: row.preferred_voice_channel_id,
      debugTranscripts: row.debug_transcripts,
      commandDragEnabled: row.command_drag_enabled,
      commandMuteEnabled: row.command_mute_enabled,
      commandKickEnabled: row.command_kick_enabled,
      commandLockEnabled: row.command_lock_enabled,
      updatedAt: row.updated_at,
    });
  }

  async saveGuildSettings(settings) {
    const normalized = normalizeGuildSettings(settings);

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
          debug_transcripts,
          command_drag_enabled,
          command_mute_enabled,
          command_kick_enabled,
          command_lock_enabled,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, NOW()
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
          debug_transcripts = EXCLUDED.debug_transcripts,
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
        normalized.debugTranscripts,
        normalized.commandDragEnabled,
        normalized.commandMuteEnabled,
        normalized.commandKickEnabled,
        normalized.commandLockEnabled,
      ]
    );

    return this.getGuildSettings(normalized.guildId, normalized.guildName);
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
