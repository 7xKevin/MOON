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

function normalizeBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  return value === true;
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
    debugTranscripts: input.debugTranscripts === true || input.showTranscriptionsInChat === true,
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

function normalizeGlobalAdminSettings(input = {}, defaults = {}) {
  const groqEnabled = normalizeBoolean(input.groqEnabled, defaults.groqEnabled === true);
  const deepgramEnabled = normalizeBoolean(input.deepgramEnabled, defaults.deepgramEnabled === true);
  const assemblyAiEnabled = normalizeBoolean(input.assemblyAiEnabled, defaults.assemblyAiEnabled === true);
  const localWhisperEnabled = normalizeBoolean(input.localWhisperEnabled, defaults.localWhisperEnabled === true);
  const enabledProviders = [
    groqEnabled ? "groq" : null,
    deepgramEnabled ? "deepgram" : null,
    assemblyAiEnabled ? "assemblyai" : null,
    localWhisperEnabled ? "local" : null,
  ].filter(Boolean);
  const preferredCandidate =
    String(input.preferredSttProvider ?? defaults.preferredSttProvider ?? enabledProviders[0] ?? "groq")
      .trim()
      .toLowerCase() || "groq";

  return {
    globalBotEnabled: normalizeBoolean(input.globalBotEnabled, defaults.globalBotEnabled !== false),
    userDashboardEnabled: normalizeBoolean(
      input.userDashboardEnabled,
      defaults.userDashboardEnabled !== false
    ),
    groqEnabled,
    deepgramEnabled,
    assemblyAiEnabled,
    localWhisperEnabled,
    preferredSttProvider: enabledProviders.includes(preferredCandidate)
      ? preferredCandidate
      : enabledProviders[0] ?? "groq",
    groqSttModel:
      String(input.groqSttModel ?? defaults.groqSttModel ?? "whisper-large-v3").trim() || "whisper-large-v3",
    deepgramSttModel:
      String(input.deepgramSttModel ?? defaults.deepgramSttModel ?? "nova-3").trim() || "nova-3",
    assemblyAiSttModel:
      String(input.assemblyAiSttModel ?? defaults.assemblyAiSttModel ?? "universal-3-pro").trim() || "universal-3-pro",
    defaultWakeWord:
      String(input.defaultWakeWord ?? defaults.defaultWakeWord ?? "moon").trim() || "moon",
    defaultRequireWakeWord: normalizeBoolean(
      input.defaultRequireWakeWord,
      defaults.defaultRequireWakeWord !== false
    ),
    defaultTranscriptionSilenceMs: normalizePositiveInteger(
      input.defaultTranscriptionSilenceMs,
      defaults.defaultTranscriptionSilenceMs ?? 550
    ),
    defaultCommandCooldownMs: normalizePositiveInteger(
      input.defaultCommandCooldownMs,
      defaults.defaultCommandCooldownMs ?? 250
    ),
    updatedAt: input.updatedAt ? new Date(input.updatedAt).toISOString() : new Date().toISOString(),
  };
}

function createDefaultGlobalAdminSettings(defaults = {}) {
  return normalizeGlobalAdminSettings({}, defaults);
}

function normalizeSettingsFileShape(raw) {
  if (raw && typeof raw === "object" && raw.sharedGuilds && raw.userGuildSettings) {
    return {
      sharedGuilds: raw.sharedGuilds,
      userGuildSettings: raw.userGuildSettings,
      globalAdminSettings: raw.globalAdminSettings ?? {},
      legacyGuildSettings: raw.legacyGuildSettings ?? {},
      commandTelemetry: Array.isArray(raw.commandTelemetry) ? raw.commandTelemetry : [],
    };
  }

  const legacyGuildSettings = raw && typeof raw === "object" ? raw : {};
  const sharedGuilds = {};

  for (const [guildId, settings] of Object.entries(legacyGuildSettings)) {
    sharedGuilds[guildId] = {
      guildId,
      guildName: settings.guildName ?? "Unknown Server",
      botPresent: settings.botPresent === true,
      botLastSeenAt: settings.botLastSeenAt ? new Date(settings.botLastSeenAt).toISOString() : null,
    };
  }

  return {
    sharedGuilds,
    userGuildSettings: {},
    globalAdminSettings: {},
    legacyGuildSettings,
    commandTelemetry: [],
  };
}

function normalizeTelemetryEvent(input = {}) {
  return {
    id: String(input.id ?? "").trim() || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    guildId: String(input.guildId ?? "").trim(),
    guildName: String(input.guildName ?? "Unknown Server").trim() || "Unknown Server",
    speakerId: input.speakerId ? String(input.speakerId).trim() : "",
    speakerTag: String(input.speakerTag ?? "unknown").trim() || "unknown",
    wakeWord: String(input.wakeWord ?? "").trim(),
    transcript: String(input.transcript ?? "").trim(),
    status: String(input.status ?? "unknown").trim() || "unknown",
    reason: input.reason ? String(input.reason).trim() : "",
    commandType: input.commandType ? String(input.commandType).trim() : "",
    provider: input.provider ? String(input.provider).trim() : "",
    model: input.model ? String(input.model).trim() : "",
    sttLatencyMs: Number.isFinite(Number(input.sttLatencyMs)) ? Math.round(Number(input.sttLatencyMs)) : null,
    totalLatencyMs: Number.isFinite(Number(input.totalLatencyMs)) ? Math.round(Number(input.totalLatencyMs)) : null,
    createdAt: input.createdAt ? new Date(input.createdAt).toISOString() : new Date().toISOString(),
  };
}

function summarizeTelemetry(events) {
  const summary = {
    totalEvents: events.length,
    commandAttempts: 0,
    ignored: 0,
    ignoredNoise: 0,
    parserMisses: 0,
    success: 0,
    failed: 0,
    statuses: {},
    reasons: {},
    providers: {},
    commands: {},
    averageSttLatencyMs: null,
    averageTotalLatencyMs: null,
  };

  let sttLatencyTotal = 0;
  let sttLatencyCount = 0;
  let totalLatencyTotal = 0;
  let totalLatencyCount = 0;

  for (const rawEvent of events) {
    const event = normalizeTelemetryEvent(rawEvent);
    summary.statuses[event.status] = (summary.statuses[event.status] ?? 0) + 1;
    if (event.status === "ignored") {
      summary.ignored += 1;
      if (event.reason === "ignorable-transcript") {
        summary.ignoredNoise += 1;
      } else if (event.reason === "parse-failed") {
        summary.parserMisses += 1;
      }
    } else if (event.status === "success") {
      summary.commandAttempts += 1;
      summary.success += 1;
    } else {
      summary.commandAttempts += 1;
      summary.failed += 1;
    }

    if (event.reason && event.status !== "success") {
      summary.reasons[event.reason] = (summary.reasons[event.reason] ?? 0) + 1;
    }

    if (event.provider) {
      summary.providers[event.provider] ??= {
        totalEvents: 0,
        commandAttempts: 0,
        ignored: 0,
        ignoredNoise: 0,
        parserMisses: 0,
        success: 0,
        failed: 0,
        avgSttLatencyMs: null,
      };
      const provider = summary.providers[event.provider];
      provider.totalEvents += 1;
      if (event.status === "ignored") {
        provider.ignored += 1;
        if (event.reason === "ignorable-transcript") {
          provider.ignoredNoise += 1;
        } else if (event.reason === "parse-failed") {
          provider.parserMisses += 1;
        }
      } else if (event.status === "success") {
        provider.commandAttempts += 1;
        provider.success += 1;
      } else {
        provider.commandAttempts += 1;
        provider.failed += 1;
      }

      if (event.sttLatencyMs !== null) {
        provider._sttLatencyTotal = (provider._sttLatencyTotal ?? 0) + event.sttLatencyMs;
        provider._sttLatencyCount = (provider._sttLatencyCount ?? 0) + 1;
      }
    }

    if (event.commandType) {
      summary.commands[event.commandType] = (summary.commands[event.commandType] ?? 0) + 1;
    }

    if (event.sttLatencyMs !== null) {
      sttLatencyTotal += event.sttLatencyMs;
      sttLatencyCount += 1;
    }

    if (event.totalLatencyMs !== null) {
      totalLatencyTotal += event.totalLatencyMs;
      totalLatencyCount += 1;
    }
  }

  summary.averageSttLatencyMs = sttLatencyCount ? Math.round(sttLatencyTotal / sttLatencyCount) : null;
  summary.averageTotalLatencyMs = totalLatencyCount ? Math.round(totalLatencyTotal / totalLatencyCount) : null;

  for (const provider of Object.values(summary.providers)) {
    provider.avgSttLatencyMs = provider._sttLatencyCount
      ? Math.round(provider._sttLatencyTotal / provider._sttLatencyCount)
      : null;
    delete provider._sttLatencyTotal;
    delete provider._sttLatencyCount;
  }

  return summary;
}

function stripSharedGuildState(settings) {
  const normalized = normalizeGuildSettings(settings);
  return {
    guildId: normalized.guildId,
    guildName: normalized.guildName,
    botEnabled: normalized.botEnabled,
    adminUserIds: normalized.adminUserIds,
    commandUserIds: normalized.commandUserIds,
    allowedRoleIds: normalized.allowedRoleIds,
    preferredTextChannelId: normalized.preferredTextChannelId,
    preferredVoiceChannelId: normalized.preferredVoiceChannelId,
    debugTranscripts: normalized.debugTranscripts,
    transcriptionEnabled: normalized.transcriptionEnabled,
    wakeWord: normalized.wakeWord,
    requireWakeWord: normalized.requireWakeWord,
    transcriptionSilenceMs: normalized.transcriptionSilenceMs,
    commandCooldownMs: normalized.commandCooldownMs,
    commandDragEnabled: normalized.commandDragEnabled,
    commandMuteEnabled: normalized.commandMuteEnabled,
    commandKickEnabled: normalized.commandKickEnabled,
    commandLockEnabled: normalized.commandLockEnabled,
    updatedAt: normalized.updatedAt,
  };
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
    this.globalDefaults = {
      globalBotEnabled: true,
      userDashboardEnabled: true,
      groqEnabled: config.hasGroqStt,
      deepgramEnabled: config.hasDeepgramStt,
      assemblyAiEnabled: config.hasAssemblyAiStt,
      localWhisperEnabled: config.hasLocalWhisper,
      preferredSttProvider: config.hasGroqStt ? "groq" : config.hasDeepgramStt ? "deepgram" : config.hasAssemblyAiStt ? "assemblyai" : "local",
      groqSttModel: config.GROQ_STT_MODEL,
      deepgramSttModel: config.DEEPGRAM_STT_MODEL,
      assemblyAiSttModel: config.ASSEMBLYAI_STT_MODEL,
      defaultWakeWord: config.WAKE_WORD,
      defaultRequireWakeWord: config.REQUIRE_WAKE_WORD,
      defaultTranscriptionSilenceMs: config.TRANSCRIPTION_SILENCE_MS,
      defaultCommandCooldownMs: config.COMMAND_COOLDOWN_MS,
    };
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(
        this.filePath,
        JSON.stringify(
          {
            sharedGuilds: {},
            userGuildSettings: {},
            globalAdminSettings: createDefaultGlobalAdminSettings(this.globalDefaults),
            legacyGuildSettings: {},
            commandTelemetry: [],
          },
          null,
          2
        )
      );
    }
  }

  async readAll() {
    const raw = await fs.readFile(this.filePath, "utf8");
    return normalizeSettingsFileShape(JSON.parse(raw));
  }

  async writeAll(data) {
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
  }

  async getGlobalAdminSettings() {
    const all = await this.readAll();
    return normalizeGlobalAdminSettings(all.globalAdminSettings, this.globalDefaults);
  }

  async saveGlobalAdminSettings(settings) {
    const all = await this.readAll();
    all.globalAdminSettings = normalizeGlobalAdminSettings(settings, this.globalDefaults);
    await this.writeAll(all);
    return this.getGlobalAdminSettings();
  }

  async getRuntimeDefaults() {
    const globalSettings = await this.getGlobalAdminSettings();
    return {
      wakeWord: globalSettings.defaultWakeWord,
      requireWakeWord: globalSettings.defaultRequireWakeWord,
      transcriptionSilenceMs: globalSettings.defaultTranscriptionSilenceMs,
      commandCooldownMs: globalSettings.defaultCommandCooldownMs,
    };
  }

  async getGuildSettings(guildId, guildName = "Unknown Server", userId = null) {
    const runtimeDefaults = await this.getRuntimeDefaults();
    const all = await this.readAll();
    const shared = all.sharedGuilds[guildId] ?? {
      guildId,
      guildName,
      botPresent: false,
      botLastSeenAt: null,
    };
    const userSettings = userId ? all.userGuildSettings?.[guildId]?.[userId] : null;
    const legacySettings = all.legacyGuildSettings?.[guildId] ?? null;
    const base = userSettings ?? legacySettings ?? createDefaultGuildSettings(guildId, guildName, runtimeDefaults);

    return normalizeGuildSettings(
      {
        ...base,
        guildId,
        guildName: guildName || shared.guildName || base.guildName,
        botPresent: shared.botPresent,
        botLastSeenAt: shared.botLastSeenAt,
      },
      runtimeDefaults
    );
  }

  async saveGuildSettings(settings, userId) {
    const runtimeDefaults = await this.getRuntimeDefaults();
    const normalized = normalizeGuildSettings(settings, runtimeDefaults);
    const all = await this.readAll();
    const shared = all.sharedGuilds[normalized.guildId] ?? {
      guildId: normalized.guildId,
      guildName: normalized.guildName,
      botPresent: false,
      botLastSeenAt: null,
    };

    all.sharedGuilds[normalized.guildId] = {
      ...shared,
      guildId: normalized.guildId,
      guildName: normalized.guildName,
    };

    const effectiveUserId = userId || "global";
    all.userGuildSettings[normalized.guildId] ??= {};
    all.userGuildSettings[normalized.guildId][effectiveUserId] = stripSharedGuildState(normalized);

    await this.writeAll(all);
    return this.getGuildSettings(normalized.guildId, normalized.guildName, effectiveUserId);
  }

  async resetBotPresence() {
    const all = await this.readAll();

    for (const guildId of Object.keys(all.sharedGuilds)) {
      all.sharedGuilds[guildId] = {
        ...all.sharedGuilds[guildId],
        botPresent: false,
      };
    }

    await this.writeAll(all);
  }

  async updateBotPresence(guildId, guildName, botPresent) {
    const all = await this.readAll();
    const current = all.sharedGuilds[guildId] ?? {
      guildId,
      guildName,
      botPresent: false,
      botLastSeenAt: null,
    };

    all.sharedGuilds[guildId] = {
      ...current,
      guildId,
      guildName,
      botPresent,
      botLastSeenAt: botPresent ? new Date().toISOString() : current.botLastSeenAt,
    };

    await this.writeAll(all);
    return all.sharedGuilds[guildId];
  }

  async recordCommandTelemetry(event) {
    const all = await this.readAll();
    const normalized = normalizeTelemetryEvent(event);
    all.commandTelemetry = [normalized, ...(all.commandTelemetry ?? [])].slice(0, 400);
    await this.writeAll(all);
    return normalized;
  }

  async getCommandTelemetry(limit = 80) {
    const all = await this.readAll();
    return (all.commandTelemetry ?? []).slice(0, limit).map((event) => normalizeTelemetryEvent(event));
  }

  async getCommandTelemetrySummary(limit = 200) {
    const events = await this.getCommandTelemetry(limit);
    return summarizeTelemetry(events);
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
    this.globalDefaults = {
      globalBotEnabled: true,
      userDashboardEnabled: true,
      groqEnabled: config.hasGroqStt,
      deepgramEnabled: config.hasDeepgramStt,
      assemblyAiEnabled: config.hasAssemblyAiStt,
      localWhisperEnabled: config.hasLocalWhisper,
      preferredSttProvider: config.hasGroqStt ? "groq" : config.hasDeepgramStt ? "deepgram" : config.hasAssemblyAiStt ? "assemblyai" : "local",
      groqSttModel: config.GROQ_STT_MODEL,
      deepgramSttModel: config.DEEPGRAM_STT_MODEL,
      assemblyAiSttModel: config.ASSEMBLYAI_STT_MODEL,
      defaultWakeWord: config.WAKE_WORD,
      defaultRequireWakeWord: config.REQUIRE_WAKE_WORD,
      defaultTranscriptionSilenceMs: config.TRANSCRIPTION_SILENCE_MS,
      defaultCommandCooldownMs: config.COMMAND_COOLDOWN_MS,
    };
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS guild_presence (
        guild_id TEXT PRIMARY KEY,
        guild_name TEXT NOT NULL,
        bot_present BOOLEAN NOT NULL DEFAULT FALSE,
        bot_last_seen_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS guild_user_settings (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        guild_name TEXT NOT NULL,
        bot_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        admin_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        command_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        allowed_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        preferred_text_channel_id TEXT,
        preferred_voice_channel_id TEXT,
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
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (guild_id, user_id)
      )
    `);

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

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS global_admin_settings (
        settings_key TEXT PRIMARY KEY,
        global_bot_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        user_dashboard_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        groq_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        deepgram_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        assemblyai_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        local_whisper_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        preferred_stt_provider TEXT NOT NULL DEFAULT 'groq',
        groq_stt_model TEXT NOT NULL DEFAULT 'whisper-large-v3',
        deepgram_stt_model TEXT NOT NULL DEFAULT 'nova-3',
        assemblyai_stt_model TEXT NOT NULL DEFAULT 'universal-3-pro',
        default_wake_word TEXT NOT NULL DEFAULT 'moon',
        default_require_wake_word BOOLEAN NOT NULL DEFAULT TRUE,
        default_transcription_silence_ms INTEGER NOT NULL DEFAULT 550,
        default_command_cooldown_ms INTEGER NOT NULL DEFAULT 250,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      ALTER TABLE global_admin_settings
      ADD COLUMN IF NOT EXISTS groq_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS deepgram_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS assemblyai_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS local_whisper_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS assemblyai_stt_model TEXT NOT NULL DEFAULT 'universal-3-pro'
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS command_telemetry (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        guild_name TEXT NOT NULL,
        speaker_id TEXT,
        speaker_tag TEXT NOT NULL,
        wake_word TEXT,
        transcript TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        command_type TEXT,
        provider TEXT,
        model TEXT,
        stt_latency_ms INTEGER,
        total_latency_ms INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS command_telemetry_created_at_idx
      ON command_telemetry (created_at DESC)
    `);
  }

  async getGlobalAdminSettings() {
    const result = await this.pool.query(
      `SELECT * FROM global_admin_settings WHERE settings_key = 'global'`
    );

    if (!result.rowCount) {
      return createDefaultGlobalAdminSettings(this.globalDefaults);
    }

    const row = result.rows[0];
    return normalizeGlobalAdminSettings(
      {
        globalBotEnabled: row.global_bot_enabled,
        userDashboardEnabled: row.user_dashboard_enabled,
        groqEnabled: row.groq_enabled,
        deepgramEnabled: row.deepgram_enabled,
        assemblyAiEnabled: row.assemblyai_enabled,
        localWhisperEnabled: row.local_whisper_enabled,
        preferredSttProvider: row.preferred_stt_provider,
        groqSttModel: row.groq_stt_model,
        deepgramSttModel: row.deepgram_stt_model,
        assemblyAiSttModel: row.assemblyai_stt_model,
        defaultWakeWord: row.default_wake_word,
        defaultRequireWakeWord: row.default_require_wake_word,
        defaultTranscriptionSilenceMs: row.default_transcription_silence_ms,
        defaultCommandCooldownMs: row.default_command_cooldown_ms,
        updatedAt: row.updated_at,
      },
      this.globalDefaults
    );
  }

  async saveGlobalAdminSettings(settings) {
    const normalized = normalizeGlobalAdminSettings(settings, this.globalDefaults);
    await this.pool.query(
      `
        INSERT INTO global_admin_settings (
          settings_key,
          global_bot_enabled,
          user_dashboard_enabled,
          groq_enabled,
          deepgram_enabled,
          assemblyai_enabled,
          local_whisper_enabled,
          preferred_stt_provider,
          groq_stt_model,
          deepgram_stt_model,
          assemblyai_stt_model,
          default_wake_word,
          default_require_wake_word,
          default_transcription_silence_ms,
          default_command_cooldown_ms,
          updated_at
        ) VALUES (
          'global', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW()
        )
        ON CONFLICT (settings_key)
        DO UPDATE SET
          global_bot_enabled = EXCLUDED.global_bot_enabled,
          user_dashboard_enabled = EXCLUDED.user_dashboard_enabled,
          groq_enabled = EXCLUDED.groq_enabled,
          deepgram_enabled = EXCLUDED.deepgram_enabled,
          assemblyai_enabled = EXCLUDED.assemblyai_enabled,
          local_whisper_enabled = EXCLUDED.local_whisper_enabled,
          preferred_stt_provider = EXCLUDED.preferred_stt_provider,
          groq_stt_model = EXCLUDED.groq_stt_model,
          deepgram_stt_model = EXCLUDED.deepgram_stt_model,
          assemblyai_stt_model = EXCLUDED.assemblyai_stt_model,
          default_wake_word = EXCLUDED.default_wake_word,
          default_require_wake_word = EXCLUDED.default_require_wake_word,
          default_transcription_silence_ms = EXCLUDED.default_transcription_silence_ms,
          default_command_cooldown_ms = EXCLUDED.default_command_cooldown_ms,
          updated_at = NOW()
      `,
      [
        normalized.globalBotEnabled,
        normalized.userDashboardEnabled,
        normalized.groqEnabled,
        normalized.deepgramEnabled,
        normalized.assemblyAiEnabled,
        normalized.localWhisperEnabled,
        normalized.preferredSttProvider,
        normalized.groqSttModel,
        normalized.deepgramSttModel,
        normalized.assemblyAiSttModel,
        normalized.defaultWakeWord,
        normalized.defaultRequireWakeWord,
        normalized.defaultTranscriptionSilenceMs,
        normalized.defaultCommandCooldownMs,
      ]
    );

    return this.getGlobalAdminSettings();
  }

  async getRuntimeDefaults() {
    const globalSettings = await this.getGlobalAdminSettings();
    return {
      wakeWord: globalSettings.defaultWakeWord,
      requireWakeWord: globalSettings.defaultRequireWakeWord,
      transcriptionSilenceMs: globalSettings.defaultTranscriptionSilenceMs,
      commandCooldownMs: globalSettings.defaultCommandCooldownMs,
    };
  }

  async getSharedGuildState(guildId, guildName = "Unknown Server") {
    const result = await this.pool.query(
      `SELECT guild_id, guild_name, bot_present, bot_last_seen_at FROM guild_presence WHERE guild_id = $1`,
      [guildId]
    );

    if (result.rowCount) {
      const row = result.rows[0];
      return {
        guildId: row.guild_id,
        guildName: row.guild_name,
        botPresent: row.bot_present,
        botLastSeenAt: row.bot_last_seen_at ? new Date(row.bot_last_seen_at).toISOString() : null,
      };
    }

    const legacy = await this.pool.query(
      `SELECT guild_id, guild_name, bot_present, bot_last_seen_at FROM guild_settings WHERE guild_id = $1`,
      [guildId]
    );

    if (legacy.rowCount) {
      const row = legacy.rows[0];
      return {
        guildId: row.guild_id,
        guildName: row.guild_name,
        botPresent: row.bot_present,
        botLastSeenAt: row.bot_last_seen_at ? new Date(row.bot_last_seen_at).toISOString() : null,
      };
    }

    return {
      guildId,
      guildName,
      botPresent: false,
      botLastSeenAt: null,
    };
  }

  async getLegacyGuildSettings(guildId) {
    const result = await this.pool.query(
      `SELECT * FROM guild_settings WHERE guild_id = $1`,
      [guildId]
    );

    if (!result.rowCount) {
      return null;
    }

    const row = result.rows[0];
    return {
      guildId: row.guild_id,
      guildName: row.guild_name,
      botEnabled: row.bot_enabled,
      adminUserIds: row.admin_user_ids,
      commandUserIds: row.command_user_ids,
      allowedRoleIds: row.allowed_role_ids,
      preferredTextChannelId: row.preferred_text_channel_id,
      preferredVoiceChannelId: row.preferred_voice_channel_id,
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
      botPresent: row.bot_present,
      botLastSeenAt: row.bot_last_seen_at,
    };
  }

  async getGuildSettings(guildId, guildName = "Unknown Server", userId = null) {
    const runtimeDefaults = await this.getRuntimeDefaults();
    const shared = await this.getSharedGuildState(guildId, guildName);
    let base = null;

    if (userId) {
      const result = await this.pool.query(
        `SELECT * FROM guild_user_settings WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
      );

      if (result.rowCount) {
        const row = result.rows[0];
        base = {
          guildId: row.guild_id,
          guildName: row.guild_name,
          botEnabled: row.bot_enabled,
          adminUserIds: row.admin_user_ids,
          commandUserIds: row.command_user_ids,
          allowedRoleIds: row.allowed_role_ids,
          preferredTextChannelId: row.preferred_text_channel_id,
          preferredVoiceChannelId: row.preferred_voice_channel_id,
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
        };
      }
    }

    if (!base) {
      base = (await this.getLegacyGuildSettings(guildId)) ?? createDefaultGuildSettings(guildId, guildName, runtimeDefaults);
    }

    return normalizeGuildSettings(
      {
        ...base,
        guildId,
        guildName: guildName || shared.guildName || base.guildName,
        botPresent: shared.botPresent,
        botLastSeenAt: shared.botLastSeenAt,
      },
      runtimeDefaults
    );
  }

  async saveGuildSettings(settings, userId) {
    const runtimeDefaults = await this.getRuntimeDefaults();
    const normalized = normalizeGuildSettings(settings, runtimeDefaults);
    const effectiveUserId = userId || "global";
    const shared = await this.getSharedGuildState(normalized.guildId, normalized.guildName);

    await this.pool.query(
      `
        INSERT INTO guild_presence (
          guild_id,
          guild_name,
          bot_present,
          bot_last_seen_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (guild_id)
        DO UPDATE SET
          guild_name = EXCLUDED.guild_name,
          bot_present = EXCLUDED.bot_present,
          bot_last_seen_at = EXCLUDED.bot_last_seen_at,
          updated_at = NOW()
      `,
      [
        normalized.guildId,
        normalized.guildName,
        shared.botPresent,
        shared.botLastSeenAt ? new Date(shared.botLastSeenAt) : null,
      ]
    );

    await this.pool.query(
      `
        INSERT INTO guild_user_settings (
          guild_id,
          user_id,
          guild_name,
          bot_enabled,
          admin_user_ids,
          command_user_ids,
          allowed_role_ids,
          preferred_text_channel_id,
          preferred_voice_channel_id,
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
          $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW()
        )
        ON CONFLICT (guild_id, user_id)
        DO UPDATE SET
          guild_name = EXCLUDED.guild_name,
          bot_enabled = EXCLUDED.bot_enabled,
          admin_user_ids = EXCLUDED.admin_user_ids,
          command_user_ids = EXCLUDED.command_user_ids,
          allowed_role_ids = EXCLUDED.allowed_role_ids,
          preferred_text_channel_id = EXCLUDED.preferred_text_channel_id,
          preferred_voice_channel_id = EXCLUDED.preferred_voice_channel_id,
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
        effectiveUserId,
        normalized.guildName,
        normalized.botEnabled,
        JSON.stringify(normalized.adminUserIds),
        JSON.stringify(normalized.commandUserIds),
        JSON.stringify(normalized.allowedRoleIds),
        normalized.preferredTextChannelId || null,
        normalized.preferredVoiceChannelId || null,
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

    return this.getGuildSettings(normalized.guildId, normalized.guildName, effectiveUserId);
  }

  async resetBotPresence() {
    await this.pool.query(`UPDATE guild_presence SET bot_present = FALSE, updated_at = NOW()`);
  }

  async updateBotPresence(guildId, guildName, botPresent) {
    await this.pool.query(
      `
        INSERT INTO guild_presence (
          guild_id,
          guild_name,
          bot_present,
          bot_last_seen_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (guild_id)
        DO UPDATE SET
          guild_name = EXCLUDED.guild_name,
          bot_present = EXCLUDED.bot_present,
          bot_last_seen_at = EXCLUDED.bot_last_seen_at,
          updated_at = NOW()
      `,
      [guildId, guildName, botPresent, botPresent ? new Date() : null]
    );

    return this.getSharedGuildState(guildId, guildName);
  }

  async recordCommandTelemetry(event) {
    const normalized = normalizeTelemetryEvent(event);
    await this.pool.query(
      `
        INSERT INTO command_telemetry (
          id, guild_id, guild_name, speaker_id, speaker_tag, wake_word, transcript,
          status, reason, command_type, provider, model, stt_latency_ms, total_latency_ms, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14, $15
        )
      `,
      [
        normalized.id,
        normalized.guildId,
        normalized.guildName,
        normalized.speakerId || null,
        normalized.speakerTag,
        normalized.wakeWord || null,
        normalized.transcript || null,
        normalized.status,
        normalized.reason || null,
        normalized.commandType || null,
        normalized.provider || null,
        normalized.model || null,
        normalized.sttLatencyMs,
        normalized.totalLatencyMs,
        new Date(normalized.createdAt),
      ]
    );

    await this.pool.query(`
      DELETE FROM command_telemetry
      WHERE id IN (
        SELECT id FROM command_telemetry
        ORDER BY created_at DESC
        OFFSET 3000
      )
    `);

    return normalized;
  }

  async getCommandTelemetry(limit = 80) {
    const result = await this.pool.query(
      `
        SELECT * FROM command_telemetry
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows.map((row) =>
      normalizeTelemetryEvent({
        id: row.id,
        guildId: row.guild_id,
        guildName: row.guild_name,
        speakerId: row.speaker_id,
        speakerTag: row.speaker_tag,
        wakeWord: row.wake_word,
        transcript: row.transcript,
        status: row.status,
        reason: row.reason,
        commandType: row.command_type,
        provider: row.provider,
        model: row.model,
        sttLatencyMs: row.stt_latency_ms,
        totalLatencyMs: row.total_latency_ms,
        createdAt: row.created_at,
      })
    );
  }

  async getCommandTelemetrySummary(limit = 200) {
    const events = await this.getCommandTelemetry(limit);
    return summarizeTelemetry(events);
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
  createDefaultGlobalAdminSettings,
  createSettingsStore,
  normalizeTelemetryEvent,
  normalizeGlobalAdminSettings,
  normalizeGuildSettings,
  parseStringList,
  summarizeTelemetry,
};
