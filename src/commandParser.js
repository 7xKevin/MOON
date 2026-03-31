function normalizeText(input) {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(input) {
  return normalizeText(input).replace(/\s+/g, "");
}

function phoneticKey(input) {
  const compact = compactText(input);
  if (!compact) {
    return "";
  }

  const first = compact[0];
  const remainder = compact
    .slice(1)
    .replace(/[aeiou]/g, "")
    .replace(/(.)\1+/g, "$1")
    .replace(/h/g, "");

  return `${first}${remainder}`;
}

function levenshteinDistance(left, right) {
  const a = left ?? "";
  const b = right ?? "";

  const matrix = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );

  for (let row = 0; row <= a.length; row += 1) {
    matrix[row][0] = row;
  }

  for (let col = 0; col <= b.length; col += 1) {
    matrix[0][col] = col;
  }

  for (let row = 1; row <= a.length; row += 1) {
    for (let col = 1; col <= b.length; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;

      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

function similarityScore(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);

  if (!a && !b) {
    return 1;
  }

  const maxLength = Math.max(a.length, b.length);
  if (!maxLength) {
    return 1;
  }

  return 1 - levenshteinDistance(a, b) / maxLength;
}

function bestMatch(input, candidates, threshold) {
  let best = null;

  for (const candidate of candidates) {
    const score = similarityScore(input, candidate);
    if (!best || score > best.score) {
      best = { candidate, score };
    }
  }

  return best && best.score >= threshold ? best : null;
}

function stripPhrases(input, phrases, fromStart) {
  let current = input.trim();
  let changed = true;

  while (changed && current) {
    changed = false;

    for (const phrase of phrases) {
      if (fromStart && current.startsWith(`${phrase} `)) {
        current = current.slice(phrase.length).trim();
        changed = true;
        break;
      }

      if (!fromStart && current.endsWith(` ${phrase}`)) {
        current = current.slice(0, -phrase.length).trim();
        changed = true;
        break;
      }

      if (current === phrase) {
        current = "";
        changed = true;
        break;
      }
    }
  }

  return current;
}

function cleanCommandText(input) {
  const leadingPhrases = [
    "please",
    "just",
    "can you",
    "could you",
    "would you",
    "will you",
    "uh",
    "um",
    "bro",
    "anna",
    "ra",
    "hey",
  ];
  const trailingPhrases = [
    "please",
    "right now",
    "now",
    "for me",
    "thanks",
    "thank you",
    "bro",
    "anna",
    "ra",
  ];

  return stripPhrases(stripPhrases(input, leadingPhrases, true), trailingPhrases, false);
}

function stripWakeWordPrefix(normalized, wakeWord, requireWakeWord) {
  const normalizedWakeWord = normalizeText(wakeWord);

  if (!normalizedWakeWord) {
    return normalized;
  }

  const tokens = normalized.split(" ");
  if (!tokens.length) {
    return null;
  }

  const conversationalPrefixes = new Set(["hey", "ok", "okay"]);
  let wakeIndex = 0;

  if (conversationalPrefixes.has(tokens[0])) {
    wakeIndex = 1;
  }

  const wakeCandidate = tokens[wakeIndex];
  if (!wakeCandidate) {
    return requireWakeWord ? null : cleanCommandText(normalized);
  }

  const wakeMatch = bestMatch(wakeCandidate, [normalizedWakeWord], 0.55);
  if (wakeMatch) {
    return cleanCommandText(tokens.slice(wakeIndex + 1).join(" ").trim());
  }

  return requireWakeWord ? null : cleanCommandText(normalized);
}

function hasKeywordMatch(commandText, keywords, threshold) {
  const tokens = commandText.split(" ").filter(Boolean);
  return tokens.some((token) => bestMatch(token, keywords, threshold));
}

function getFixedCommands() {
  return [
    {
      type: "lock",
      aliases: [
        "lock the vc",
        "lock vc",
        "lock the voice channel",
        "close the vc",
        "lock channel",
        "lock the channel",
      ],
      verbs: ["lock", "locked", "locking", "close", "closed", "closing"],
      blockers: ["unlock", "unlocked", "unlocking", "open", "opened", "opening"],
    },
    {
      type: "unlock",
      aliases: [
        "unlock the vc",
        "unlock vc",
        "unlock the voice channel",
        "open the vc",
        "unlock channel",
        "unlock the channel",
      ],
      verbs: ["unlock", "unlocked", "unlocking", "open", "opened", "opening"],
      blockers: ["lock", "locked", "locking", "close", "closed", "closing"],
    },
  ];
}

function parseFixedCommand(commandText, rawTranscript) {
  const channelTerms = ["vc", "bc", "voice", "channel", "room", "call"];
  const commands = getFixedCommands();
  const tokens = commandText.split(" ").filter(Boolean);

  for (const command of commands) {
    if (command.aliases.includes(commandText)) {
      return {
        type: command.type,
        transcript: commandText,
        rawTranscript,
        confidence: 1,
        matchType: "exact-alias",
      };
    }
  }

  let best = null;

  for (const command of commands) {
    const aliasMatch = bestMatch(commandText, command.aliases, 0.82);
    if (aliasMatch && (!best || aliasMatch.score > best.confidence)) {
      best = {
        type: command.type,
        transcript: commandText,
        rawTranscript,
        confidence: aliasMatch.score,
        matchType: "alias",
      };
    }

    const hasVerb = tokens.some((token) => command.verbs.includes(token));
    const hasBlocker = tokens.some((token) => command.blockers.includes(token));
    const hasChannel = hasKeywordMatch(commandText, channelTerms, 0.72);

    if (hasVerb && !hasBlocker && hasChannel && (!best || 0.92 > best.confidence)) {
      best = {
        type: command.type,
        transcript: commandText,
        rawTranscript,
        confidence: 0.92,
        matchType: "keyword",
      };
    }
  }

  return best;
}

function parseDragDestination(remainder, commandText, rawTranscript, confidence) {
  if (remainder.endsWith(" here")) {
    const targetName = cleanCommandText(remainder.slice(0, -5));
    if (!targetName) {
      return null;
    }

    return {
      type: "drag",
      targetName,
      destinationType: "here",
      destinationName: null,
      transcript: commandText,
      rawTranscript,
      confidence,
    };
  }

  const destinationPatterns = [
    /^(.*?)\s+to\s+(.*)$/,
    /^(.*?)\s+into\s+(.*)$/,
    /^(.*?)\s+in\s+(.*)$/,
  ];

  for (const pattern of destinationPatterns) {
    const match = remainder.match(pattern);
    if (!match) {
      continue;
    }

    const targetName = cleanCommandText(match[1]);
    const destinationName = cleanCommandText(match[2]);
    if (!targetName || !destinationName) {
      return null;
    }

    return {
      type: "drag",
      targetName,
      destinationType: "named",
      destinationName,
      transcript: commandText,
      rawTranscript,
      confidence,
    };
  }

  return null;
}

function parseTargetCommand(commandText, rawTranscript) {
  const tokens = cleanCommandText(commandText).split(" ").filter(Boolean);
  if (tokens.length < 2) {
    return null;
  }

  const firstWord = tokens[0];
  const remainder = cleanCommandText(tokens.slice(1).join(" ").trim());

  const actionGroups = [
    { type: "unmute", verbs: ["unmute", "unmuted", "unmuting"] },
    { type: "mute", verbs: ["mute", "muted", "muting"] },
    { type: "kick", verbs: ["kick", "kicked", "disconnect", "disconnected", "remove", "removed"] },
    { type: "drag", verbs: ["drag", "dragged", "move", "moved", "shift", "shifted", "bring", "brought", "send", "sent"] },
  ];

  let bestAction = null;

  for (const action of actionGroups) {
    if (action.verbs.includes(firstWord)) {
      bestAction = {
        type: action.type,
        confidence: 1,
      };
      break;
    }

    const match = bestMatch(firstWord, action.verbs, 0.64);
    if (match && (!bestAction || match.score > bestAction.confidence)) {
      bestAction = {
        type: action.type,
        confidence: match.score,
      };
    }
  }

  if (!bestAction) {
    return null;
  }

  if (bestAction.type === "drag") {
    return parseDragDestination(remainder, commandText, rawTranscript, bestAction.confidence);
  }

  if (!remainder) {
    return null;
  }

  return {
    type: bestAction.type,
    targetName: remainder,
    transcript: commandText,
    rawTranscript,
    confidence: bestAction.confidence,
  };
}

function parseVoiceCommand(transcript, options = {}) {
  const normalized = normalizeText(transcript);

  if (!normalized || normalized.includes("blank audio")) {
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

  return parseFixedCommand(commandText, normalized) || parseTargetCommand(commandText, normalized);
}

module.exports = {
  compactText,
  normalizeText,
  parseVoiceCommand,
  phoneticKey,
  similarityScore,
  stripWakeWordPrefix,
};
