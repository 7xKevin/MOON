function normalizeText(input) {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseVoiceCommand(transcript) {
  const normalized = normalizeText(transcript);

  if (!normalized) {
    return null;
  }

  const dragMatch = normalized.match(/^(drag|move)\s+(.+?)\s+here$/);
  if (dragMatch) {
    return { type: "drag", targetName: dragMatch[2], transcript: normalized };
  }

  const muteMatch = normalized.match(/^mute\s+(.+)$/);
  if (muteMatch) {
    return { type: "mute", targetName: muteMatch[1], transcript: normalized };
  }

  const unmuteMatch = normalized.match(/^unmute\s+(.+)$/);
  if (unmuteMatch) {
    return { type: "unmute", targetName: unmuteMatch[1], transcript: normalized };
  }

  const kickMatch = normalized.match(/^(kick|disconnect)\s+(.+)$/);
  if (kickMatch) {
    return { type: "kick", targetName: kickMatch[2], transcript: normalized };
  }

  if (/^lock(?:\s+the)?\s+(vc|voice channel)$/.test(normalized)) {
    return { type: "lock", transcript: normalized };
  }

  if (/^unlock(?:\s+the)?\s+(vc|voice channel)$/.test(normalized)) {
    return { type: "unlock", transcript: normalized };
  }

  return null;
}

module.exports = {
  normalizeText,
  parseVoiceCommand,
};
