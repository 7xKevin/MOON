const GLOBAL_VOICE_COMMANDS = [
  { syntax: 'lock vc', description: 'Lock your current voice channel', family: 'lock' },
  { syntax: 'unlock vc', description: 'Unlock your current voice channel', family: 'unlock' },
  { syntax: 'mute me', description: 'Server-mute yourself', family: 'mute' },
  { syntax: 'mute <user>', description: 'Server-mute one user', family: 'mute' },
  { syntax: 'unmute me', description: 'Server-unmute yourself', family: 'unmute' },
  { syntax: 'unmute <user>', description: 'Server-unmute one user', family: 'unmute' },
  { syntax: 'disconnect me', description: 'Disconnect yourself from voice', family: 'kick' },
  { syntax: 'disconnect <user>', description: 'Disconnect one user from voice', family: 'kick' },
  { syntax: 'disconnect all', description: 'Disconnect everyone from the current source channel', family: 'kick' },
  { syntax: 'drag me here', description: 'Move yourself to the session owner channel', family: 'drag' },
  { syntax: 'drag me to <vc>', description: 'Move yourself to a named voice channel', family: 'drag' },
  { syntax: 'drag <user> here', description: 'Move one user to the session owner channel', family: 'drag' },
  { syntax: 'drag <user> to <vc>', description: 'Move one user to a named voice channel', family: 'drag' },
  { syntax: 'drag all here', description: 'Move everyone from the current source channel to here', family: 'drag' },
  { syntax: 'drag all to <vc>', description: 'Move everyone from the current source channel to a named VC', family: 'drag' },
  { syntax: 'drag all from <vc> here', description: 'Move everyone from one VC to here', family: 'drag' },
  { syntax: 'drag all from <vc> to <vc>', description: 'Move everyone from one VC to another VC', family: 'drag' },
  { syntax: 'role add <user> role <role>', description: 'Give one role to one user', family: 'role-add' },
  { syntax: 'role remove <user> role <role>', description: 'Remove one role from one user', family: 'role-remove' },
  { syntax: 'say in <text-channel> text <message>', description: 'Send one plain message in a text channel', family: 'say' },
  { syntax: 'mention <user> in <text-channel>', description: 'Mention one user in a text channel', family: 'mention' },
  { syntax: 'spam <count> in <text-channel> text <message>', description: 'Send a short message up to 5 times in a text channel', family: 'spam' },
  { syntax: 'stop spam', description: 'Stop the active spam job for this server', family: 'spam-stop' },
];

function normalizeText(input) {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactText(input) {
  return normalizeText(input).replace(/\s+/g, '');
}

function phoneticKey(input) {
  const compact = compactText(input);
  if (!compact) {
    return '';
  }

  const first = compact[0];
  const remainder = compact
    .slice(1)
    .replace(/[aeiou]/g, '')
    .replace(/(.)\1+/g, '$1')
    .replace(/h/g, '');

  return `${first}${remainder}`;
}

function levenshteinDistance(left, right) {
  const a = left ?? '';
  const b = right ?? '';
  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));

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

function tokenSimilarity(token, expected) {
  const normalizedToken = normalizeText(token);
  const normalizedExpected = normalizeText(expected);

  if (!normalizedToken || !normalizedExpected) {
    return -1;
  }

  if (normalizedToken === normalizedExpected || compactText(normalizedToken) === compactText(normalizedExpected)) {
    return 1;
  }

  if (
    compactText(normalizedToken).startsWith(compactText(normalizedExpected)) ||
    compactText(normalizedExpected).startsWith(compactText(normalizedToken))
  ) {
    return 0.9;
  }

  if (phoneticKey(normalizedToken) === phoneticKey(normalizedExpected)) {
    return 0.88;
  }

  return similarityScore(normalizedToken, normalizedExpected);
}

function bestKeywordMatch(token, expectedWords, threshold = 0.7) {
  let best = null;

  for (const expected of expectedWords) {
    const score = tokenSimilarity(token, expected);
    if (!best || score > best.score) {
      best = { candidate: expected, score };
    }
  }

  return best && best.score >= threshold ? best : null;
}

function average(scores) {
  if (!scores.length) {
    return 0;
  }

  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
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
        current = '';
        changed = true;
        break;
      }
    }
  }

  return current;
}

function cleanCommandText(input) {
  const leadingPhrases = ['please', 'just', 'uh', 'um', 'hey'];
  const trailingPhrases = ['please', 'now', 'thanks', 'thank you'];
  return stripPhrases(stripPhrases(normalizeText(input), leadingPhrases, true), trailingPhrases, false);
}

function buildWakeWordCandidates(wakeWord) {
  const normalizedWakeWord = normalizeText(wakeWord);
  const compactWakeWord = compactText(normalizedWakeWord);
  const candidates = new Set([normalizedWakeWord, compactWakeWord]);

  if (compactWakeWord === 'nova') {
    ['no more', 'noma', 'nora', 'never', 'no va'].forEach((variant) => candidates.add(variant));
  }

  if (compactWakeWord === 'moon') {
    ['mune', 'mon', 'moone'].forEach((variant) => candidates.add(variant));
  }

  return Array.from(candidates).filter(Boolean);
}

function stripWakeWordPrefix(normalized, wakeWord, requireWakeWord) {
  const tokens = normalized.split(' ').filter(Boolean);

  if (!tokens.length) {
    return null;
  }

  let wakeIndex = 0;
  if (['hey', 'ok', 'okay'].includes(tokens[0])) {
    wakeIndex = 1;
  }

  const wakeCandidates = buildWakeWordCandidates(wakeWord);
  const phraseCandidates = [
    { text: tokens.slice(wakeIndex, wakeIndex + 2).join(' '), consumed: 2 },
    { text: tokens[wakeIndex], consumed: 1 },
  ].filter((entry) => entry.text);

  for (const phrase of phraseCandidates) {
    if (phrase.consumed > 1) {
      const normalizedPhrase = normalizeText(phrase.text);
      const compactPhrase = compactText(phrase.text);
      const exactWakeAlias = wakeCandidates.some((candidate) => {
        return normalizeText(candidate) === normalizedPhrase || compactText(candidate) === compactPhrase;
      });

      if (exactWakeAlias) {
        return cleanCommandText(tokens.slice(wakeIndex + phrase.consumed).join(' '));
      }

      continue;
    }

    const wakeMatch = wakeCandidates.length ? bestKeywordMatch(phrase.text, wakeCandidates, 0.55) : null;
    if (wakeMatch) {
      return cleanCommandText(tokens.slice(wakeIndex + phrase.consumed).join(' '));
    }
  }

  return requireWakeWord ? null : cleanCommandText(normalized);
}

function parseNameList(segment) {
  const normalized = cleanCommandText(segment);
  if (!normalized) {
    return null;
  }

  const pieces = normalized
    .split(/\s*(?:,| and )\s*/g)
    .map((piece) => cleanCommandText(piece))
    .filter(Boolean);

  if (!pieces.length) {
    return null;
  }

  return {
    kind: pieces.length > 1 ? 'list' : 'single',
    source: pieces.join(' and '),
    names: pieces,
  };
}

function parseTargetToken(segment) {
  const normalized = cleanCommandText(segment);
  if (!normalized) {
    return null;
  }

  if (bestKeywordMatch(normalized, ['me', 'myself', 'self'], 0.72)) {
    return { kind: 'single', source: 'me', names: ['me'] };
  }

  if (bestKeywordMatch(normalized, ['all', 'everyone', 'everybody'], 0.72)) {
    return { kind: 'channel', source: 'all', names: [] };
  }

  if (bestKeywordMatch(normalized, ['us', 'we'], 0.72)) {
    return { kind: 'channel', source: 'us', names: [] };
  }

  return parseNameList(normalized);
}

function buildSimpleCommand(type, transcript, rawTranscript, confidence) {
  return {
    type,
    transcript,
    rawTranscript,
    confidence,
    matchType: 'deterministic',
  };
}

function buildTargetCommand(type, targetSpec, transcript, rawTranscript, confidence) {
  return {
    type,
    targetSpec,
    targetName: targetSpec.names[0] ?? targetSpec.source,
    transcript,
    rawTranscript,
    confidence,
    matchType: 'deterministic',
  };
}

function buildDragCommand(targetSpec, transcript, rawTranscript, confidence, destinationType, destinationName, sourceChannelName = null) {
  return {
    type: 'drag',
    targetSpec,
    targetName: targetSpec.names[0] ?? targetSpec.source,
    destinationType,
    destinationName,
    sourceChannelName,
    transcript,
    rawTranscript,
    confidence,
    matchType: 'deterministic',
  };
}

function buildRoleCommand(type, targetSpec, roleName, transcript, rawTranscript, confidence) {
  return {
    type,
    targetSpec,
    targetName: targetSpec.names[0] ?? targetSpec.source,
    roleName,
    transcript,
    rawTranscript,
    confidence,
    matchType: 'deterministic',
  };
}

function buildTextCommand(type, transcript, rawTranscript, confidence, extra = {}) {
  return {
    type,
    transcript,
    rawTranscript,
    confidence,
    matchType: 'deterministic',
    ...extra,
  };
}

function matchLockCommand(tokens, commandText, rawTranscript) {
  if (!tokens.length) {
    return null;
  }

  const actionCandidates = [
    { type: 'lock', words: ['lock'] },
    { type: 'unlock', words: ['unlock'] },
  ];

  const scored = actionCandidates
    .map((candidate) => ({ candidate, score: tokenSimilarity(tokens[0], candidate.words[0]) }))
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  const second = scored[1];
  if (!best || best.score < 0.72 || (second && best.score - second.score < 0.08)) {
    return null;
  }

  const remainder = tokens.slice(1).filter((token) => token !== 'the');
  if (!remainder.length) {
    return null;
  }

  const vcMatch = remainder.some((token) => bestKeywordMatch(token, ['vc', 'voice', 'channel', 'room', 'bc'], 0.58));
  if (!vcMatch) {
    return null;
  }

  return buildSimpleCommand(best.candidate.type, commandText, rawTranscript, average([best.score, 1]));
}

function detectAction(tokens, actionWords, threshold = 0.72) {
  const scored = actionWords
    .map((entry) => ({ ...entry, score: tokenSimilarity(tokens[0], entry.word) }))
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  const second = scored[1];
  if (!best || best.score < threshold || (second && best.score - second.score < 0.08)) {
    return null;
  }

  return best;
}

function parseTargetActionCommand(tokens, commandText, rawTranscript) {
  const action = detectAction(tokens, [
    { type: 'mute', word: 'mute' },
    { type: 'unmute', word: 'unmute' },
    { type: 'kick', word: 'disconnect' },
    { type: 'kick', word: 'kick' },
  ]);

  if (!action) {
    return null;
  }

  const targetText = cleanCommandText(tokens.slice(1).join(' '));
  const targetSpec = parseTargetToken(targetText);
  if (!targetSpec) {
    return null;
  }

  if ((action.type === 'mute' || action.type === 'unmute') && targetSpec.kind === 'channel') {
    return null;
  }

  return buildTargetCommand(action.type, targetSpec, commandText, rawTranscript, action.score);
}

function parseDragCommand(tokens, commandText, rawTranscript) {
  const dragAction = detectAction(tokens, [{ type: 'drag', word: 'drag' }], 0.62);
  if (!dragAction) {
    return null;
  }

  const remainder = cleanCommandText(tokens.slice(1).join(' '));
  if (!remainder) {
    return null;
  }

  const fromToHere = remainder.match(/^(.*?) from (.*?) to here$/);
  if (fromToHere) {
    const targetSpec = parseTargetToken(fromToHere[1]);
    const sourceChannelName = cleanCommandText(fromToHere[2]);
    if (!targetSpec || !sourceChannelName) {
      return null;
    }
    return buildDragCommand(targetSpec, commandText, rawTranscript, dragAction.score, 'here', null, sourceChannelName);
  }

  const fromToNamed = remainder.match(/^(.*?) from (.*?) to (.+)$/);
  if (fromToNamed) {
    const targetSpec = parseTargetToken(fromToNamed[1]);
    const sourceChannelName = cleanCommandText(fromToNamed[2]);
    const destinationName = cleanCommandText(fromToNamed[3]);
    if (!targetSpec || !sourceChannelName || !destinationName) {
      return null;
    }
    return buildDragCommand(targetSpec, commandText, rawTranscript, dragAction.score, 'named', destinationName, sourceChannelName);
  }

  const toNamed = remainder.match(/^(.*?) to (.+)$/);
  if (toNamed) {
    const targetSpec = parseTargetToken(toNamed[1]);
    const destinationName = cleanCommandText(toNamed[2]);
    if (!targetSpec || !destinationName) {
      return null;
    }
    return buildDragCommand(targetSpec, commandText, rawTranscript, dragAction.score, 'named', destinationName);
  }

  const hereMatch = remainder.match(/^(.*?) here$/);
  if (hereMatch) {
    const targetSpec = parseTargetToken(hereMatch[1]);
    if (!targetSpec) {
      return null;
    }
    return buildDragCommand(targetSpec, commandText, rawTranscript, dragAction.score, 'here', null);
  }

  return null;
}

function parseRoleCommand(tokens, commandText, rawTranscript) {
  const roleHead = bestKeywordMatch(tokens[0], ['role'], 0.72);
  if (!roleHead) {
    return null;
  }

  const action = detectAction(tokens.slice(1), [
    { type: 'role-add', word: 'add' },
    { type: 'role-remove', word: 'remove' },
  ], 0.72);

  if (!action) {
    return null;
  }

  const remainder = cleanCommandText(tokens.slice(2).join(' '));
  const match = remainder.match(/^(.*?) role (.+)$/);
  if (!match) {
    return null;
  }

  const targetSpec = parseTargetToken(match[1]);
  const roleName = cleanCommandText(match[2]);
  if (!targetSpec || targetSpec.kind === 'channel' || !roleName) {
    return null;
  }

  return buildRoleCommand(action.type, targetSpec, roleName, commandText, rawTranscript, average([roleHead.score, action.score]));
}

function parseTextCommand(tokens, commandText, rawTranscript) {
  if (!tokens.length) {
    return null;
  }

  const stopMatch = detectAction(tokens, [{ type: 'spam-stop', word: 'stop' }], 0.72);
  if (stopMatch && tokens[1] && bestKeywordMatch(tokens[1], ['spam'], 0.72)) {
    return buildTextCommand('spam-stop', commandText, rawTranscript, average([stopMatch.score, 1]));
  }

  const sayMatch = detectAction(tokens, [{ type: 'say', word: 'say' }], 0.72);
  if (sayMatch) {
    const remainder = cleanCommandText(tokens.slice(1).join(' '));
    const match = remainder.match(/^in (.+?) text (.+)$/);
    if (!match) {
      return null;
    }

    const channelName = cleanCommandText(match[1]);
    const message = String(match[2] ?? '').trim();
    if (!channelName || !message) {
      return null;
    }

    return buildTextCommand('say', commandText, rawTranscript, sayMatch.score, {
      channelName,
      message,
    });
  }

  const mentionMatch = detectAction(tokens, [{ type: 'mention', word: 'mention' }, { type: 'mention', word: 'ping' }], 0.72);
  if (mentionMatch) {
    const remainder = cleanCommandText(tokens.slice(1).join(' '));
    const match = remainder.match(/^(.*?) in (.+)$/);
    if (!match) {
      return null;
    }

    const targetSpec = parseTargetToken(match[1]);
    const channelName = cleanCommandText(match[2]);
    if (!targetSpec || targetSpec.kind === 'channel' || !channelName) {
      return null;
    }

    return buildTextCommand('mention', commandText, rawTranscript, mentionMatch.score, {
      targetSpec,
      targetName: targetSpec.names[0] ?? targetSpec.source,
      channelName,
    });
  }

  const spamMatch = detectAction(tokens, [{ type: 'spam', word: 'spam' }], 0.72);
  if (spamMatch) {
    const remainder = cleanCommandText(tokens.slice(1).join(' '));
    const match = remainder.match(/^(\d{1,2}) in (.+?) text (.+)$/);
    if (!match) {
      return null;
    }

    const count = Number.parseInt(match[1], 10);
    const channelName = cleanCommandText(match[2]);
    const message = String(match[3] ?? '').trim();
    if (!Number.isInteger(count) || count <= 0 || !channelName || !message) {
      return null;
    }

    return buildTextCommand('spam', commandText, rawTranscript, spamMatch.score, {
      count,
      channelName,
      message,
    });
  }

  return null;
}

function parseVoiceCommand(transcript, options = {}) {
  const normalized = normalizeText(transcript);
  if (!normalized || normalized.includes('blank audio')) {
    return null;
  }

  const commandText = stripWakeWordPrefix(normalized, options.wakeWord ?? 'moon', options.requireWakeWord ?? true);
  if (!commandText) {
    return null;
  }

  const tokens = commandText.split(' ').filter(Boolean);
  if (!tokens.length) {
    return null;
  }

  return (
    matchLockCommand(tokens, commandText, normalized) ||
    parseRoleCommand(tokens, commandText, normalized) ||
    parseDragCommand(tokens, commandText, normalized) ||
    parseTextCommand(tokens, commandText, normalized) ||
    parseTargetActionCommand(tokens, commandText, normalized)
  );
}

function getGlobalVoiceCommandCatalog() {
  return GLOBAL_VOICE_COMMANDS.slice();
}

function getVoiceCommandGuide(runtimeVoiceSettings) {
  const wakePrefix = runtimeVoiceSettings.requireWakeWord ? `${runtimeVoiceSettings.wakeWord} ` : '';
  const lines = ['**Global Voice Commands**'];
  for (const command of GLOBAL_VOICE_COMMANDS) {
    lines.push(`\`${wakePrefix}${command.syntax}\` - ${command.description}`);
  }
  return lines.join('\n');
}

module.exports = {
  cleanCommandText,
  compactText,
  getGlobalVoiceCommandCatalog,
  getVoiceCommandGuide,
  normalizeText,
  parseVoiceCommand,
  phoneticKey,
  similarityScore,
  stripWakeWordPrefix,
};
