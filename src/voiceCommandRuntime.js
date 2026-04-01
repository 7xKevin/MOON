const { normalizeText } = require("./commandParser");

function shouldPostTranscripts(guildSettings) {
  return guildSettings?.debugTranscripts === true;
}

function isIgnorableTranscript(transcript) {
  const normalized = normalizeText(transcript);

  if (!normalized) {
    return true;
  }

  const noiseOnlyPatterns = [
    "blank audio",
    "beep",
    "explosion",
    "gunshot",
    "music",
    "applause",
    "laughter",
  ];

  return noiseOnlyPatterns.some((pattern) => normalized === pattern || normalized.includes(pattern));
}

function getCommandConfidenceFloor(commandType) {
  if (commandType === "kick" || commandType === "drag") {
    return 0.82;
  }

  if (commandType === "role-add" || commandType === "role-remove") {
    return 0.8;
  }

  if (commandType === "mute" || commandType === "unmute") {
    return 0.76;
  }

  return 0.74;
}

function getTargetConfidenceFloor(commandType) {
  if (commandType === "kick" || commandType === "drag") {
    return 0.84;
  }

  if (commandType === "role-add" || commandType === "role-remove") {
    return 0.8;
  }

  return 0.78;
}

function getRuntimeVoiceSettings(guildSettings, config) {
  const configuredCooldownMs = guildSettings.commandCooldownMs || config.COMMAND_COOLDOWN_MS;
  const configuredSilenceMs = guildSettings.transcriptionSilenceMs || config.TRANSCRIPTION_SILENCE_MS;
  const commandCooldownMs = configuredCooldownMs === 2500 || configuredCooldownMs === 900
    ? config.COMMAND_COOLDOWN_MS
    : configuredCooldownMs;
  const transcriptionSilenceMs = configuredSilenceMs === 1200
    ? config.TRANSCRIPTION_SILENCE_MS
    : configuredSilenceMs;

  return {
    wakeWord: guildSettings.wakeWord || config.WAKE_WORD,
    requireWakeWord:
      guildSettings.requireWakeWord === undefined
        ? config.REQUIRE_WAKE_WORD
        : guildSettings.requireWakeWord,
    transcriptionSilenceMs: Math.max(350, transcriptionSilenceMs),
    commandCooldownMs: Math.max(250, commandCooldownMs),
    transcriptionEnabled:
      guildSettings.transcriptionEnabled === undefined ? true : guildSettings.transcriptionEnabled,
  };
}

module.exports = {
  getCommandConfidenceFloor,
  getRuntimeVoiceSettings,
  getTargetConfidenceFloor,
  isIgnorableTranscript,
  shouldPostTranscripts,
};
