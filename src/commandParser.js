function normalizeText(input) {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripWakeWordPrefix(normalized, wakeWord, requireWakeWord) {
  const normalizedWakeWord = normalizeText(wakeWord);

  if (!normalizedWakeWord) {
    return normalized;
  }

  const acceptedPrefixes = [
    `${normalizedWakeWord} `,
    `hey ${normalizedWakeWord} `,
    `ok ${normalizedWakeWord} `,
    `okay ${normalizedWakeWord} `,
  ];

  if (normalized === normalizedWakeWord) {
    return "";
  }

  for (const prefix of acceptedPrefixes) {
    if (normalized.startsWith(prefix)) {
      return normalized.slice(prefix.length).trim();
    }
  }

  return requireWakeWord ? null : normalized;
}

function parseVoiceCommand(transcript, options = {}) {
  const normalized = normalizeText(transcript);

  if (!normalized) {
    return null;
  }

  const commandText = stripWakeWordPrefix(
    normalized,
    options.wakeWord ?? "moon",
    options.requireWakeWord ?? true
  );

  if (!commandText) {
    return null;
  }

  const dragMatch = commandText.match(/^(drag|move)\s+(.+?)\s+here$/);
  if (dragMatch) {
    return {
      type: "drag",
      targetName: dragMatch[2],
      transcript: commandText,
      rawTranscript: normalized,
    };
  }

  const muteMatch = commandText.match(/^mute\s+(.+)$/);
  if (muteMatch) {
    return {
      type: "mute",
      targetName: muteMatch[1],
      transcript: commandText,
      rawTranscript: normalized,
    };
  }

  const unmuteMatch = commandText.match(/^unmute\s+(.+)$/);
  if (unmuteMatch) {
    return {
      type: "unmute",
      targetName: unmuteMatch[1],
      transcript: commandText,
      rawTranscript: normalized,
    };
  }

  const kickMatch = commandText.match(/^(kick|disconnect)\s+(.+)$/);
  if (kickMatch) {
    return {
      type: "kick",
      targetName: kickMatch[2],
      transcript: commandText,
      rawTranscript: normalized,
    };
  }

  if (/^lock(?:\s+the)?\s+(vc|voice channel)$/.test(commandText)) {
    return { type: "lock", transcript: commandText, rawTranscript: normalized };
  }

  if (/^unlock(?:\s+the)?\s+(vc|voice channel)$/.test(commandText)) {
    return { type: "unlock", transcript: commandText, rawTranscript: normalized };
  }

  return null;
}

module.exports = {
  normalizeText,
  parseVoiceCommand,
  stripWakeWordPrefix,
};
