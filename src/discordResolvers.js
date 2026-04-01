const { ChannelType } = require("discord.js");
const { compactText, normalizeText, phoneticKey, similarityScore } = require("./commandParser");

function softenSpokenName(input) {
  return normalizeText(input)
    .replace(/([aeiou])\1+/g, "$1")
    .replace(/(.)\1{2,}/g, "$1");
}

function scoreSimpleText(left, right) {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  const softenedLeft = softenSpokenName(normalizedLeft);
  const softenedRight = softenSpokenName(normalizedRight);

  if (!normalizedLeft || !normalizedRight) {
    return -1;
  }

  if (
    normalizedLeft === normalizedRight ||
    softenedLeft === softenedRight ||
    compactText(normalizedLeft) === compactText(normalizedRight) ||
    compactText(softenedLeft) === compactText(softenedRight)
  ) {
    return 1;
  }

  return Math.max(
    similarityScore(normalizedLeft, normalizedRight),
    similarityScore(softenedLeft, softenedRight)
  );
}

function scoreMemberName(candidate, lookup) {
  const normalizedCandidate = normalizeText(candidate);
  const normalizedLookup = normalizeText(lookup);

  if (!normalizedCandidate || !normalizedLookup) {
    return -1;
  }

  const compactCandidate = compactText(normalizedCandidate);
  const compactLookup = compactText(normalizedLookup);
  const softenedCandidate = softenSpokenName(normalizedCandidate);
  const softenedLookup = softenSpokenName(normalizedLookup);
  const softenedCompactCandidate = compactText(softenedCandidate);
  const softenedCompactLookup = compactText(softenedLookup);

  if (
    normalizedCandidate === normalizedLookup ||
    compactCandidate === compactLookup ||
    softenedCandidate === softenedLookup ||
    softenedCompactCandidate === softenedCompactLookup
  ) {
    return 1;
  }

  const candidatePhonetic = phoneticKey(normalizedCandidate);
  const lookupPhonetic = phoneticKey(normalizedLookup);
  if (candidatePhonetic && lookupPhonetic && candidatePhonetic === lookupPhonetic) {
    return 0.95;
  }

  const candidateTokens = normalizedCandidate.split(" ").filter(Boolean);
  const lookupTokens = normalizedLookup.split(" ").filter(Boolean);
  const softenedCandidateTokens = softenedCandidate.split(" ").filter(Boolean);
  const softenedLookupTokens = softenedLookup.split(" ").filter(Boolean);

  if (
    lookupTokens.every((token) => candidateTokens.includes(token)) ||
    softenedLookupTokens.every((token) => softenedCandidateTokens.includes(token))
  ) {
    return 0.96;
  }

  if (
    compactCandidate.startsWith(compactLookup) ||
    compactLookup.startsWith(compactCandidate) ||
    softenedCompactCandidate.startsWith(softenedCompactLookup) ||
    softenedCompactLookup.startsWith(softenedCompactCandidate)
  ) {
    return 0.93;
  }

  if (
    compactCandidate.includes(compactLookup) ||
    compactLookup.includes(compactCandidate) ||
    softenedCompactCandidate.includes(softenedCompactLookup) ||
    softenedCompactLookup.includes(softenedCompactCandidate)
  ) {
    return 0.88;
  }

  const tokenScores = lookupTokens.map((token, index) => {
    const directScore = scoreSimpleText(normalizedCandidate, token);
    const softenedDirectScore = scoreSimpleText(softenedCandidate, softenedLookupTokens[index] ?? token);
    const tokenMatches = candidateTokens.map((candidateToken) => scoreSimpleText(candidateToken, token));
    const softenedTokenMatches = softenedCandidateTokens.map((candidateToken) =>
      scoreSimpleText(candidateToken, softenedLookupTokens[index] ?? token)
    );
    return Math.max(directScore, softenedDirectScore, ...tokenMatches, ...softenedTokenMatches);
  });

  return tokenScores.reduce((sum, score) => sum + score, 0) / tokenScores.length;
}

function collectMemberScores(members, lookup, scoreMap) {
  for (const member of members.values()) {
    let bestCandidateScore = -1;
    const candidates = [
      member.displayName,
      member.user.username,
      member.nickname,
      member.user.globalName,
    ].filter(Boolean);

    for (const candidate of candidates) {
      const score = scoreMemberName(candidate, lookup);
      if (score > bestCandidateScore) {
        bestCandidateScore = score;
      }
    }

    if (bestCandidateScore < 0) {
      continue;
    }

    const existing = scoreMap.get(member.id);
    if (!existing || bestCandidateScore > existing.score) {
      scoreMap.set(member.id, { member, score: bestCandidateScore });
    }
  }
}

function getTopMemberMatches(scoreMap) {
  return [...scoreMap.values()].sort((left, right) => right.score - left.score);
}

async function findMemberByName(guild, rawName) {
  const lookup = normalizeText(rawName);
  const scoreMap = new Map();

  collectMemberScores(guild.members.cache, lookup, scoreMap);

  const searchedMembers = await guild.members
    .search({ query: rawName.slice(0, 32), limit: 25, cache: true })
    .catch(() => null);
  if (searchedMembers?.size) {
    collectMemberScores(searchedMembers, lookup, scoreMap);
  }

  let ranked = getTopMemberMatches(scoreMap);
  if ((!ranked.length || ranked[0].score < 0.85) && guild.memberCount <= 500) {
    const fetchedMembers = await guild.members.fetch().catch(() => null);
    if (fetchedMembers?.size) {
      collectMemberScores(fetchedMembers, lookup, scoreMap);
      ranked = getTopMemberMatches(scoreMap);
    }
  }

  const [best, second] = ranked;
  if (!best || best.score < 0.76) {
    return {
      member: null,
      score: best?.score ?? -1,
      ambiguous: false,
      secondMember: second?.member ?? null,
    };
  }

  const ambiguous = Boolean(second && best.score - second.score < 0.05);
  return {
    member: best.member,
    score: best.score,
    ambiguous,
    secondMember: second?.member ?? null,
  };
}

function normalizeChannelLookup(input) {
  return normalizeText(input)
    .replace(/\b(?:voice|vc|bc|room|channel|call)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreChannelName(candidate, lookup) {
  const normalizedCandidate = normalizeChannelLookup(candidate);
  const normalizedLookup = normalizeChannelLookup(lookup);

  if (!normalizedCandidate || !normalizedLookup) {
    return -1;
  }

  if (normalizedCandidate === normalizedLookup) {
    return 1;
  }

  const compactCandidate = compactText(normalizedCandidate);
  const compactLookup = compactText(normalizedLookup);

  if (compactCandidate === compactLookup) {
    return 1;
  }

  const candidateTokens = normalizedCandidate.split(" ").filter(Boolean);
  const lookupTokens = normalizedLookup.split(" ").filter(Boolean);

  if (lookupTokens.length && lookupTokens.every((token) => candidateTokens.includes(token))) {
    return 0.97;
  }

  if (candidateTokens.length && candidateTokens.every((token) => lookupTokens.includes(token))) {
    return 0.91;
  }

  if (
    compactCandidate.startsWith(compactLookup) ||
    compactLookup.startsWith(compactCandidate)
  ) {
    return 0.93;
  }

  if (
    compactCandidate.includes(compactLookup) ||
    compactLookup.includes(compactCandidate)
  ) {
    return 0.87;
  }

  const candidatePhonetic = phoneticKey(normalizedCandidate);
  const lookupPhonetic = phoneticKey(normalizedLookup);
  if (candidatePhonetic && lookupPhonetic && candidatePhonetic === lookupPhonetic) {
    return 0.92;
  }

  return similarityScore(normalizedCandidate, normalizedLookup);
}

function isVoiceLikeChannel(channel) {
  if (!channel) {
    return false;
  }

  return channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
}

function isTextLikeChannel(channel) {
  if (!channel) {
    return false;
  }

  return channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;
}

function rankVoiceChannelMatches(channels, rawName) {
  let best = null;
  let second = null;

  for (const channel of channels.values()) {
    if (!isVoiceLikeChannel(channel)) {
      continue;
    }

    const score = scoreChannelName(channel.name, rawName);
    if (score < 0) {
      continue;
    }

    const candidate = { channel, score };
    if (!best || score > best.score) {
      second = best;
      best = candidate;
    } else if (!second || score > second.score) {
      second = candidate;
    }
  }

  return { best, second };
}

async function findVoiceChannelByName(guild, rawName) {
  let { best, second } = rankVoiceChannelMatches(guild.channels.cache, rawName);

  if (!best || best.score < 0.9) {
    const fetchedChannels = await guild.channels.fetch().catch(() => null);
    if (fetchedChannels?.size) {
      ({ best, second } = rankVoiceChannelMatches(fetchedChannels, rawName));
    }
  }

  if (!best || best.score < 0.76) {
    return { channel: null, score: best?.score ?? -1, ambiguous: false, secondChannel: second?.channel ?? null };
  }

  return {
    channel: best.channel,
    score: best.score,
    ambiguous: Boolean(second && best.score - second.score < 0.05),
    secondChannel: second?.channel ?? null,
  };
}

function rankTextChannelMatches(channels, rawName) {
  let best = null;
  let second = null;

  for (const channel of channels.values()) {
    if (!isTextLikeChannel(channel)) {
      continue;
    }

    const score = scoreChannelName(channel.name, rawName);
    if (score < 0) {
      continue;
    }

    const candidate = { channel, score };
    if (!best || score > best.score) {
      second = best;
      best = candidate;
    } else if (!second || score > second.score) {
      second = candidate;
    }
  }

  return { best, second };
}

async function findTextChannelByName(guild, rawName) {
  let { best, second } = rankTextChannelMatches(guild.channels.cache, rawName);

  if (!best || best.score < 0.9) {
    const fetchedChannels = await guild.channels.fetch().catch(() => null);
    if (fetchedChannels?.size) {
      ({ best, second } = rankTextChannelMatches(fetchedChannels, rawName));
    }
  }

  if (!best || best.score < 0.76) {
    return { channel: null, score: best?.score ?? -1, ambiguous: false, secondChannel: second?.channel ?? null };
  }

  return {
    channel: best.channel,
    score: best.score,
    ambiguous: Boolean(second && best.score - second.score < 0.05),
    secondChannel: second?.channel ?? null,
  };
}

function normalizeRoleLookup(input) {
  return normalizeText(input)
    .replace(/\brole\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreRoleName(candidate, lookup) {
  const normalizedCandidate = normalizeRoleLookup(candidate);
  const normalizedLookup = normalizeRoleLookup(lookup);

  if (!normalizedCandidate || !normalizedLookup) {
    return -1;
  }

  if (normalizedCandidate === normalizedLookup) {
    return 1;
  }

  const compactCandidate = compactText(normalizedCandidate);
  const compactLookup = compactText(normalizedLookup);

  if (compactCandidate === compactLookup) {
    return 1;
  }

  if (
    compactCandidate.startsWith(compactLookup) ||
    compactLookup.startsWith(compactCandidate)
  ) {
    return 0.94;
  }

  if (
    compactCandidate.includes(compactLookup) ||
    compactLookup.includes(compactCandidate)
  ) {
    return 0.88;
  }

  const candidatePhonetic = phoneticKey(normalizedCandidate);
  const lookupPhonetic = phoneticKey(normalizedLookup);
  if (candidatePhonetic && lookupPhonetic && candidatePhonetic === lookupPhonetic) {
    return 0.93;
  }

  return similarityScore(normalizedCandidate, normalizedLookup);
}

async function findRoleByName(guild, rawName) {
  const roles = guild.roles.cache.filter((role) => role.id !== guild.id);

  let best = null;
  let second = null;

  for (const role of roles.values()) {
    const score = scoreRoleName(role.name, rawName);
    if (score < 0) {
      continue;
    }

    const candidate = { role, score };
    if (!best || score > best.score) {
      second = best;
      best = candidate;
    } else if (!second || score > second.score) {
      second = candidate;
    }
  }

  if (!best || best.score < 0.76) {
    return { role: null, score: best?.score ?? -1, ambiguous: false, secondRole: second?.role ?? null };
  }

  return {
    role: best.role,
    score: best.score,
    ambiguous: Boolean(second && best.score - second.score < 0.05),
    secondRole: second?.role ?? null,
  };
}

function resolveCommandTarget(guild, speaker, targetName) {
  const normalizedTarget = normalizeText(targetName);
  if (!normalizedTarget) {
    return null;
  }

  if (["me", "myself", "self"].includes(normalizedTarget)) {
    return { member: speaker, score: 1, ambiguous: false, special: true };
  }

  if (["bot", "moon", "nova", "the bot", "the moon", "assistant"].includes(normalizedTarget)) {
    const botMember = guild.members.me;
    return botMember ? { member: botMember, score: 1, ambiguous: false, special: true } : null;
  }

  return null;
}

function uniqueMembers(members) {
  const seen = new Set();
  const result = [];

  for (const member of members) {
    if (!member || seen.has(member.id)) {
      continue;
    }

    seen.add(member.id);
    result.push(member);
  }

  return result;
}

function getChannelTargetMembers(guild, channel) {
  if (!channel) {
    return [];
  }

  return uniqueMembers(
    [...channel.members.values()].filter((member) => member.id !== guild.members.me?.id)
  );
}

function formatMemberList(members) {
  const names = uniqueMembers(members).map((member) => `**${member.displayName}**`);
  if (!names.length) {
    return "nobody";
  }

  if (names.length === 1) {
    return names[0];
  }

  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }

  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function formatResolutionFailures(transcript, failures) {
  if (!failures.length) {
    return null;
  }

  const first = failures[0];
  if (first.reason === "no-channel") {
    return "I couldn't tell which voice channel members you meant.";
  }

  if (first.reason === "source-channel-missing") {
    return `I couldn't find a voice channel named **${first.label}**.`;
  }

  if (first.reason === "source-channel-ambiguous") {
    return first.secondary
      ? `I found multiple channels close to **${first.label}**: **${first.primary}** and **${first.secondary}**.`
      : `I found multiple channels close to **${first.label}**.`;
  }

  if (first.reason === "empty-source-channel") {
    return first.label
      ? `No one is in the requested voice channel (**${first.label}**).`
      : "No one is in the requested voice channel.";
  }

  if (first.reason === "ambiguous") {
    return first.secondary
      ? `I heard \`${transcript}\`, but **${first.label}** looks ambiguous between **${first.primary}** and **${first.secondary}**.`
      : `I heard \`${transcript}\`, but **${first.label}** looks ambiguous.`;
  }

  if (first.reason === "low-confidence") {
    return `I heard \`${transcript}\`, but I am not confident enough that **${first.primary}** is the right target for **${first.label}**.`;
  }

  const labels = failures.slice(0, 3).map((failure) => `**${failure.label}**`);
  const joined = labels.length === 1
    ? labels[0]
    : labels.length === 2
      ? `${labels[0]} and ${labels[1]}`
      : `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
  return `I heard \`${transcript}\`, but I couldn't confidently find ${joined}.`;
}

async function resolveCommandTargets(guild, speaker, controller, command, getTargetConfidenceFloor) {
  const targetSpec = command.targetSpec ?? {
    kind: command.targetName ? "single" : "unknown",
    source: command.targetName ?? "",
    names: command.targetName ? [command.targetName] : [],
  };

  if (targetSpec.kind === "channel") {
    let sourceChannel = speaker.voice.channel ?? controller.voice.channel;

    if (command.sourceChannelName) {
      const sourceMatch = await findVoiceChannelByName(guild, command.sourceChannelName);
      if (!sourceMatch.channel) {
        return {
          members: [],
          failures: [{ label: command.sourceChannelName, reason: "source-channel-missing" }],
        };
      }

      if (sourceMatch.ambiguous) {
        return {
          members: [],
          failures: [{
            label: command.sourceChannelName,
            reason: "source-channel-ambiguous",
            primary: sourceMatch.channel.name,
            secondary: sourceMatch.secondChannel?.name || null,
          }],
        };
      }

      sourceChannel = sourceMatch.channel;
    }

    if (!sourceChannel) {
      return {
        members: [],
        failures: [{ label: targetSpec.source || "everyone", reason: "no-channel" }],
      };
    }

    const members = getChannelTargetMembers(guild, sourceChannel);
    if (!members.length) {
      return {
        members: [],
        failures: [{ label: sourceChannel.name, reason: "empty-source-channel" }],
      };
    }

    return {
      members,
      failures: [],
    };
  }

  const resolved = [];
  const failures = [];

  for (const name of targetSpec.names) {
    const specialTarget = resolveCommandTarget(guild, speaker, name);
    const targetMatch = specialTarget ?? (await findMemberByName(guild, name));

    if (!targetMatch?.member) {
      failures.push({ label: name, reason: "missing" });
      continue;
    }

    if (targetMatch.ambiguous) {
      failures.push({
        label: name,
        reason: "ambiguous",
        primary: targetMatch.member.displayName,
        secondary: targetMatch.secondMember?.displayName || targetMatch.secondMember?.user?.username || null,
      });
      continue;
    }

    if ((targetMatch.score ?? 1) < getTargetConfidenceFloor(command.type)) {
      failures.push({
        label: name,
        reason: "low-confidence",
        primary: targetMatch.member.displayName,
      });
      continue;
    }

    resolved.push(targetMatch.member);
  }

  const members = uniqueMembers(resolved);
  if (!members.length && failures.length) {
    return { members, failures };
  }

  const channelScopedFailures = failures.filter((failure) => failure.reason !== "no-channel");
  return {
    members,
    failures: channelScopedFailures,
  };
}

module.exports = {
  findMemberByName,
  findRoleByName,
  findTextChannelByName,
  findVoiceChannelByName,
  formatMemberList,
  formatResolutionFailures,
  resolveCommandTarget,
  resolveCommandTargets,
  uniqueMembers,
};

