const { normalizeText } = require("./commandParser");

function shouldPostTranscripts(guildSettings) {
  return guildSettings?.debugTranscripts === true;
}

function isIgnorableTranscript(transcript) {
  const normalized = normalizeText(transcript);

  if (!normalized) {
    return true;
  }

  const exactNoisePhrases = new Set([
    "blank audio",
    "beep",
    "explosion",
    "gunshot",
    "music",
    "applause",
    "laughter",
    "thank you",
    "thanks",
    "okay",
    "ok",
    "bye",
    "a moment",
    "one minute",
  ]);

  if (exactNoisePhrases.has(normalized)) {
    return true;
  }

  const embeddedNoisePatterns = [
    "blank audio",
    "beep",
    "explosion",
    "gunshot",
    "radio station",
  ];

  return embeddedNoisePatterns.some((pattern) => normalized.includes(pattern));
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
    transcriptionSilenceMs: Math.max(300, transcriptionSilenceMs),
    commandCooldownMs: Math.max(150, commandCooldownMs),
    transcriptionEnabled:
      guildSettings.transcriptionEnabled === undefined ? true : guildSettings.transcriptionEnabled,
    minCommandAudioMs: Math.max(120, config.MIN_COMMAND_AUDIO_MS),
    maxQueuedCommandAgeMs: Math.max(1500, config.MAX_QUEUED_COMMAND_AGE_MS),
  };
}

function getPcmDurationMs(pcmBuffer, sampleRate = 48000, channels = 2, bytesPerSample = 2) {
  if (!pcmBuffer?.length) {
    return 0;
  }

  const bytesPerSecond = sampleRate * channels * bytesPerSample;
  return Math.round((pcmBuffer.length / bytesPerSecond) * 1000);
}

function shouldDiscardPcmBuffer(pcmBuffer, runtimeVoiceSettings) {
  return getPcmDurationMs(pcmBuffer) < runtimeVoiceSettings.minCommandAudioMs;
}

module.exports = {
  getCommandConfidenceFloor,
  getPcmDurationMs,
  getRuntimeVoiceSettings,
  getTargetConfidenceFloor,
  isIgnorableTranscript,
  shouldDiscardPcmBuffer,
  shouldPostTranscripts,
};

