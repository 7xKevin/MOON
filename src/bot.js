const { Client, GatewayIntentBits, PermissionsBitField, ChannelType } = require("discord.js");
const {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} = require("@discordjs/voice");
const prism = require("prism-media");
const { compactText, normalizeText, parseVoiceCommand, phoneticKey, similarityScore } = require("./commandParser");
const { transcribePcmBuffer } = require("./transcriber");

function createBot({ config, store }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.MessageContent,
    ],
  });

  const sessions = new Map();

  function log(message, extra) {
    if (extra) {
      console.log(`[MOON] ${message}`, extra);
      return;
    }

    console.log(`[MOON] ${message}`);
  }

  function createUserFacingError(message) {
    return Object.assign(new Error(message), {
      userFacingMessage: message,
    });
  }

  function formatUserFacingError(error, fallback) {
    if (error?.userFacingMessage) {
      return error.userFacingMessage;
    }

    return fallback;
  }

  function getSession(guildId) {
    return sessions.get(guildId);
  }

  function destroySession(guildId) {
    const session = getSession(guildId);
    if (!session) {
      return;
    }

    try {
      session.receiver?.speaking?.off("start", session.onSpeakingStart);
    } catch {
      // Listener cleanup is best-effort.
    }

    try {
      session.connection?.destroy();
    } catch {
      // Connection may already be destroyed; session cleanup should still continue.
    }

    sessions.delete(guildId);
  }

  async function sendStatusToChannel(guild, textChannelId, content) {
    const channel = guild.channels.cache.get(textChannelId) ?? (await guild.channels.fetch(textChannelId).catch(() => null));
    if (!channel || !channel.isTextBased()) {
      return;
    }

    await channel.send(content);
  }

  async function sendStatus(guild, content) {
    const session = getSession(guild.id);
    if (!session) {
      return;
    }

    await sendStatusToChannel(guild, session.textChannelId, content);
  }

  async function collectPcmBuffer(receiver, userId, silenceDurationMs) {
    return new Promise((resolve, reject) => {
      const opusStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: silenceDurationMs,
        },
      });

      const decoder = new prism.opus.Decoder({
        frameSize: 960,
        channels: 2,
        rate: 48000,
      });

      const chunks = [];
      let totalBytes = 0;
      let settled = false;
      const maxBytes = 48000 * 2 * 2 * 15;

      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(Buffer.concat(chunks, totalBytes));
      };

      const fail = (error) => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      };

      decoder.on("data", (chunk) => {
        if (totalBytes >= maxBytes) {
          return;
        }

        chunks.push(chunk);
        totalBytes += chunk.length;
      });

      opusStream.on("error", fail);
      decoder.on("error", fail);
      decoder.on("end", finish);
      opusStream.pipe(decoder);
    });
  }

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

  async function getGuildSettings(guild, userId = null) {
    return store.getGuildSettings(guild.id, guild.name, userId);
  }

  async function syncBotPresence(clientInstance) {
    if (typeof store.resetBotPresence === "function") {
      await store.resetBotPresence();
    }

    if (typeof store.updateBotPresence !== "function") {
      return;
    }

    await Promise.all(
      clientInstance.guilds.cache.map((guild) =>
        store.updateBotPresence(guild.id, guild.name, true)
      )
    );
  }

  function memberHasDashboardAdmin(member, guildSettings) {
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return true;
    }

    if (member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return true;
    }

    return guildSettings.adminUserIds.includes(member.id);
  }

  function memberCanUseVoiceCommands(member, session, guildSettings) {
    if (member.id === session.ownerUserId) {
      return true;
    }

    if (memberHasDashboardAdmin(member, guildSettings)) {
      return true;
    }

    if (guildSettings.commandUserIds.includes(member.id)) {
      return true;
    }

    return guildSettings.allowedRoleIds.some((roleId) => member.roles.cache.has(roleId));
  }

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

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  function getRuntimeVoiceSettings(guildSettings) {
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

  function normalizeChannelLookup(input) {
    return normalizeText(input)
      .replace(/\b(?:voice|vc|room|channel|call)\b/g, " ")
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

  async function findVoiceChannelByName(guild, rawName) {
    const channels = guild.channels.cache.filter(
      (channel) => channel.type === ChannelType.GuildVoice
    );

    let best = null;
    let second = null;

    for (const channel of channels.values()) {
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

  async function resolveCommandTargets(guild, speaker, controller, command, transcript) {
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

  function getSpeechJobPriority(session, job) {
    const focusActive = session.focusSpeakerId && session.focusUntil > Date.now();
    if (focusActive && job.userId === session.focusSpeakerId) {
      return 0;
    }

    if (job.userId === session.ownerUserId) {
      return 1;
    }

    return 2;
  }

  function sortSpeechQueue(session) {
    session.speechQueue.sort((left, right) => {
      const priorityDelta = getSpeechJobPriority(session, left) - getSpeechJobPriority(session, right);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return left.capturedAt - right.capturedAt;
    });
  }

  async function executeVoiceCommand(guild, session, command, transcript, guildSettings, controller, speaker) {
    const controllerChannel = controller.voice.channel;

    if (!controllerChannel) {
      throw createUserFacingError("The session owner is no longer in a voice channel.");
    }

    if (!guildSettings.botEnabled) {
      await sendStatus(guild, "This server has MOON paused in the dashboard.");
      return;
    }

    if ((command.confidence ?? 1) < getCommandConfidenceFloor(command.type)) {
      await sendStatus(guild, `I heard \`${transcript}\`, but I am not confident enough to run that command.`);
      return;
    }

    if (command.type === "drag" && !guildSettings.commandDragEnabled) {
      await sendStatus(guild, "Drag commands are disabled in the dashboard.");
      return;
    }

    if ((command.type === "mute" || command.type === "unmute") && !guildSettings.commandMuteEnabled) {
      await sendStatus(guild, "Mute commands are disabled in the dashboard.");
      return;
    }

    if (command.type === "kick" && !guildSettings.commandKickEnabled) {
      await sendStatus(guild, "Kick commands are disabled in the dashboard.");
      return;
    }

    if ((command.type === "lock" || command.type === "unlock") && !guildSettings.commandLockEnabled) {
      await sendStatus(guild, "Lock commands are disabled in the dashboard.");
      return;
    }

    if (command.type === "lock") {
      await controllerChannel.permissionOverwrites.edit(
        guild.roles.everyone,
        { Connect: false },
        { reason: `MOON voice command by ${controller.user.tag}` }
      );
      await sendStatus(guild, `Locked **${controllerChannel.name}**.`);
      return;
    }

    if (command.type === "unlock") {
      await controllerChannel.permissionOverwrites.edit(
        guild.roles.everyone,
        { Connect: null },
        { reason: `MOON voice command by ${controller.user.tag}` }
      );
      await sendStatus(guild, `Unlocked **${controllerChannel.name}**.`);
      return;
    }

    const targetResult = await resolveCommandTargets(guild, speaker, controller, command, transcript);
    if (!targetResult.members.length) {
      await sendStatus(
        guild,
        formatResolutionFailures(transcript, targetResult.failures) ?? `I heard \`${transcript}\`, but I couldn't confidently resolve the target.`
      );
      return;
    }

    if (command.type === "role-add" || command.type === "role-remove") {
      const botMember = guild.members.me;
      if (!botMember?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        await sendStatus(guild, "I need the **Manage Roles** permission to do that.");
        return;
      }

      const roleMatch = await findRoleByName(guild, command.roleName);
      if (!roleMatch.role) {
        await sendStatus(guild, `I couldn't find a role named **${command.roleName}**.`);
        return;
      }

      if (roleMatch.ambiguous) {
        const secondRoleName = roleMatch.secondRole?.name;
        await sendStatus(
          guild,
          secondRoleName
            ? `I found multiple roles close to **${command.roleName}**: **${roleMatch.role.name}** and **${secondRoleName}**.`
            : `I found multiple roles close to **${command.roleName}**.`
        );
        return;
      }

      if (!roleMatch.role.editable) {
        await sendStatus(guild, `I can't manage **${roleMatch.role.name}** because it is above my highest role.`);
        return;
      }

      const activeTargets = [];
      const skippedTargets = [];
      const unmanageableTargets = [];

      for (const target of targetResult.members) {
        if (!target.manageable) {
          unmanageableTargets.push(target);
          continue;
        }

        if (command.type === "role-add") {
          if (target.roles.cache.has(roleMatch.role.id)) {
            skippedTargets.push(target);
            continue;
          }

          await target.roles.add(roleMatch.role, `MOON voice command by ${controller.user.tag}`);
          activeTargets.push(target);
          continue;
        }

        if (!target.roles.cache.has(roleMatch.role.id)) {
          skippedTargets.push(target);
          continue;
        }

        await target.roles.remove(roleMatch.role, `MOON voice command by ${controller.user.tag}`);
        activeTargets.push(target);
      }

      if (activeTargets.length) {
        await sendStatus(
          guild,
          command.type === "role-add"
            ? activeTargets.length === 1
              ? `Gave **${roleMatch.role.name}** to **${activeTargets[0].displayName}**.`
              : `Gave **${roleMatch.role.name}** to ${formatMemberList(activeTargets)}.`
            : activeTargets.length === 1
              ? `Removed **${roleMatch.role.name}** from **${activeTargets[0].displayName}**.`
              : `Removed **${roleMatch.role.name}** from ${formatMemberList(activeTargets)}.`
        );
      }

      if (skippedTargets.length) {
        await sendStatus(
          guild,
          command.type === "role-add"
            ? `${formatMemberList(skippedTargets)} already ${skippedTargets.length === 1 ? "has" : "have"} **${roleMatch.role.name}**.`
            : `${formatMemberList(skippedTargets)} ${skippedTargets.length === 1 ? "does" : "do"} not have **${roleMatch.role.name}**.`
        );
      }

      if (unmanageableTargets.length) {
        await sendStatus(
          guild,
          `${formatMemberList(unmanageableTargets)} ${unmanageableTargets.length === 1 ? "is" : "are"} above my role hierarchy, so I can't change roles for ${unmanageableTargets.length === 1 ? "them" : "those members"}.`
        );
      }

      if (targetResult.failures.length) {
        await sendStatus(guild, formatResolutionFailures(transcript, targetResult.failures));
      }

      if (!activeTargets.length && !skippedTargets.length && !unmanageableTargets.length) {
        await sendStatus(guild, `I couldn't execute ${command.type === "role-add" ? "that role assignment" : "that role removal"}.`);
      }
      return;
    }
    if (command.type === "drag") {
      const destination =
        command.destinationType === "named"
          ? await findVoiceChannelByName(guild, command.destinationName)
          : { channel: controllerChannel, score: 1, ambiguous: false };

      if (!destination.channel) {
        await sendStatus(guild, `I couldn't find a voice channel named **${command.destinationName}**.`);
        return;
      }

      if (destination.ambiguous) {
        const secondChannelName = destination.secondChannel?.name;
        await sendStatus(
          guild,
          secondChannelName
            ? `I found multiple channels close to **${command.destinationName}**: **${destination.channel.name}** and **${secondChannelName}**.`
            : `I found multiple channels close to **${command.destinationName}**.`
        );
        return;
      }

      const botTarget = targetResult.members.find((member) => member.id === guild.members.me?.id) ?? null;
      const humanTargets = targetResult.members.filter((member) => member.id !== guild.members.me?.id);
      const movedMembers = [];
      const unavailableMembers = [];

      for (const target of humanTargets) {
        if (!target.voice.channel) {
          unavailableMembers.push(target);
          continue;
        }

        await target.voice.setChannel(
          destination.channel,
          `MOON voice command by ${controller.user.tag}`
        );
        movedMembers.push(target);
      }

      if (botTarget) {
        try {
          session.connection.rejoin({
            channelId: destination.channel.id,
            selfDeaf: false,
            selfMute: false,
          });

          await entersState(session.connection, VoiceConnectionStatus.Ready, 20000);
        } catch (error) {
          throw createUserFacingError(`Couldn't move MOON into **${destination.channel.name}**.`);
        }
      }

      if (!movedMembers.length && !botTarget) {
        const messages = [];
        if (unavailableMembers.length) {
          messages.push(`${formatMemberList(unavailableMembers)} ${unavailableMembers.length === 1 ? "is" : "are"} not in a voice channel.`);
        }
        if (targetResult.failures.length) {
          messages.push(formatResolutionFailures(transcript, targetResult.failures));
        }
        await sendStatus(guild, messages.filter(Boolean).join(" ") || `I couldn't move anyone into **${destination.channel.name}**.`);
        return;
      }

      const movedTargets = botTarget ? [...movedMembers, botTarget] : movedMembers;
      if (movedMembers.length === 1 && !botTarget) {
        await sendStatus(guild, `Moved **${movedMembers[0].displayName}** into **${destination.channel.name}**.`);
      } else if (botTarget && !movedMembers.length) {
        await sendStatus(guild, `Moved MOON into **${destination.channel.name}**.`);
      } else {
        await sendStatus(guild, `Moved ${formatMemberList(movedTargets)} into **${destination.channel.name}**.`);
      }

      if (unavailableMembers.length) {
        await sendStatus(guild, `${formatMemberList(unavailableMembers)} ${unavailableMembers.length === 1 ? "is" : "are"} not in a voice channel.`);
      }
      if (targetResult.failures.length) {
        await sendStatus(guild, formatResolutionFailures(transcript, targetResult.failures));
      }
      return;
    }

    let targets = targetResult.members;
    if (command.type === "kick") {
      const botTargets = targets.filter((member) => member.id === guild.members.me?.id);
      if (botTargets.length && targets.length > 1) {
        await sendStatus(guild, "Disconnecting MOON ends the session, so remove MOON in a separate command.");
        targets = targets.filter((member) => member.id !== guild.members.me?.id);
      }

      if (targets.length === 1 && targets[0].id === guild.members.me?.id) {
        destroySession(guild.id);
        await sendStatusToChannel(guild, session.textChannelId, "Disconnected from voice.");
        return;
      }
    }

    const activeTargets = [];
    const unavailableMembers = [];

    for (const target of targets) {
      if (!target.voice.channel) {
        unavailableMembers.push(target);
        continue;
      }

      if (command.type === "mute") {
        await target.voice.setMute(true, `MOON voice command by ${controller.user.tag}`);
        activeTargets.push(target);
        continue;
      }

      if (command.type === "unmute") {
        await target.voice.setMute(false, `MOON voice command by ${controller.user.tag}`);
        activeTargets.push(target);
        continue;
      }

      if (command.type === "kick") {
        await target.voice.disconnect(`MOON voice command by ${controller.user.tag}`);
        activeTargets.push(target);
      }
    }

    if (!activeTargets.length) {
      const messages = [];
      if (unavailableMembers.length) {
        messages.push(`${formatMemberList(unavailableMembers)} ${unavailableMembers.length === 1 ? "is" : "are"} not in a voice channel.`);
      }
      if (targetResult.failures.length) {
        messages.push(formatResolutionFailures(transcript, targetResult.failures));
      }
      await sendStatus(guild, messages.filter(Boolean).join(" ") || `I couldn't execute \`${command.type}\` for that target.`);
      return;
    }

    if (command.type === "mute") {
      await sendStatus(
        guild,
        activeTargets.length === 1
          ? `Server-muted **${activeTargets[0].displayName}**.`
          : `Server-muted ${formatMemberList(activeTargets)}.`
      );
    }

    if (command.type === "unmute") {
      await sendStatus(
        guild,
        activeTargets.length === 1
          ? `Server-unmuted **${activeTargets[0].displayName}**.`
          : `Server-unmuted ${formatMemberList(activeTargets)}.`
      );
    }

    if (command.type === "kick") {
      await sendStatus(
        guild,
        activeTargets.length === 1
          ? `Disconnected **${activeTargets[0].displayName}** from voice chat.`
          : `Disconnected ${formatMemberList(activeTargets)} from voice chat.`
      );
    }

    if (unavailableMembers.length) {
      await sendStatus(guild, `${formatMemberList(unavailableMembers)} ${unavailableMembers.length === 1 ? "is" : "are"} not in a voice channel.`);
    }
    if (targetResult.failures.length) {
      await sendStatus(guild, formatResolutionFailures(transcript, targetResult.failures));
    }
  }

  async function processSpeechJob(guild, job) {
    const session = getSession(guild.id);
    if (!session) {
      return;
    }

    const { userId, pcmBuffer } = job;
    if (!pcmBuffer?.length) {
      return;
    }

    const speaker = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
    if (!speaker) {
      return;
    }

    const controller = guild.members.cache.get(session.ownerUserId) ?? (await guild.members.fetch(session.ownerUserId).catch(() => null));
    if (!controller || !controller.voice.channelId) {
      return;
    }

    if (speaker.voice.channelId !== controller.voice.channelId) {
      return;
    }

    const guildSettings = await getGuildSettings(guild, session.ownerUserId);
    session.guildSettingsSnapshot = guildSettings;
    session.runtimeVoiceSettings = getRuntimeVoiceSettings(guildSettings);

    if (!memberCanUseVoiceCommands(speaker, session, guildSettings)) {
      return;
    }

    if (!session.runtimeVoiceSettings.transcriptionEnabled) {
      return;
    }

    const latestSession = getSession(guild.id);
    if (!latestSession) {
      return;
    }

    const transcript = await transcribePcmBuffer(pcmBuffer);
    if (!transcript || isIgnorableTranscript(transcript)) {
      return;
    }

    const command = parseVoiceCommand(transcript, {
      wakeWord: latestSession.runtimeVoiceSettings?.wakeWord ?? session.runtimeVoiceSettings.wakeWord,
      requireWakeWord:
        latestSession.runtimeVoiceSettings?.requireWakeWord ?? session.runtimeVoiceSettings.requireWakeWord,
    });
    if (!command) {
      log(`Ignored transcript from ${speaker.user.tag}: ${transcript}`);
      return;
    }

    latestSession.focusSpeakerId = speaker.id;
    latestSession.focusUntil = Date.now() + 4000;

    if (shouldPostTranscripts(guildSettings)) {
      await sendStatus(guild, `Transcript from **${speaker.displayName}**: \`${transcript}\``);
    }

    const cooldownRemaining = latestSession.lastCommandAt + latestSession.runtimeVoiceSettings.commandCooldownMs - Date.now();
    if (cooldownRemaining > 0) {
      await wait(cooldownRemaining);
    }

    latestSession.lastCommandAt = Date.now();
    log(`Executing command: ${command.type}`, {
      guild: guild.name,
      speaker: speaker.user.tag,
      transcript,
      confidence: command.confidence,
    });

    await executeVoiceCommand(
      guild,
      latestSession,
      command,
      transcript,
      guildSettings,
      controller,
      speaker
    );
  }

  async function drainSpeechQueue(guild) {
    const session = getSession(guild.id);
    if (!session || session.isProcessing) {
      return;
    }

    const nextJob = session.speechQueue.shift();
    if (!nextJob) {
      return;
    }

    session.isProcessing = true;

    try {
      await processSpeechJob(guild, nextJob);
    } catch (error) {
      log("Voice command failed", error?.details ?? error);
      await sendStatus(guild, formatUserFacingError(error, "Voice command failed. Please try again."));
    } finally {
      const latestSession = getSession(guild.id);
      if (!latestSession) {
        return;
      }

      latestSession.isProcessing = false;

      if (latestSession.speechQueue.length > 0) {
        setImmediate(() => {
          drainSpeechQueue(guild).catch((error) => {
            log("Queue drain failed", error?.details ?? error);
          });
        });
      }
    }
  }

  async function startSpeechCapture(guild, userId) {
    const session = getSession(guild.id);
    if (!session || session.activeCaptures.has(userId)) {
      return;
    }

    const speaker = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
    const controller = guild.members.cache.get(session.ownerUserId) ?? (await guild.members.fetch(session.ownerUserId).catch(() => null));
    if (!speaker || !controller || !controller.voice.channelId) {
      return;
    }

    if (speaker.voice.channelId !== controller.voice.channelId) {
      return;
    }

    const guildSettings = session.guildSettingsSnapshot ?? (await getGuildSettings(guild, session.ownerUserId));
    session.guildSettingsSnapshot = guildSettings;
    session.runtimeVoiceSettings = getRuntimeVoiceSettings(guildSettings);

    if (!memberCanUseVoiceCommands(speaker, session, guildSettings)) {
      return;
    }

    if (!session.runtimeVoiceSettings.transcriptionEnabled) {
      return;
    }

    session.activeCaptures.add(userId);

    try {
      const pcmBuffer = await collectPcmBuffer(
        session.receiver,
        userId,
        session.runtimeVoiceSettings.transcriptionSilenceMs
      );

      if (!pcmBuffer.length) {
        return;
      }

      const latestSession = getSession(guild.id);
      if (!latestSession) {
        return;
      }

      latestSession.speechQueue.push({
        userId,
        pcmBuffer,
        capturedAt: Date.now(),
      });
      sortSpeechQueue(latestSession);
      while (latestSession.speechQueue.length > 8) {
        latestSession.speechQueue.pop();
      }

      drainSpeechQueue(guild).catch((error) => {
        log("Queue start failed", error?.details ?? error);
      });
    } catch (error) {
      log("Speech capture failed", error?.details ?? error);
    } finally {
      const latestSession = getSession(guild.id);
      if (latestSession) {
        latestSession.activeCaptures.delete(userId);
      }
    }
  }

  function enqueueSpeech(guild, userId) {
    startSpeechCapture(guild, userId).catch((error) => {
      log("Speech capture start failed", error?.details ?? error);
    });
  }

  async function connectToMemberChannel(member, textChannel) {
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      throw createUserFacingError("Join a voice channel first, then use !join.");
    }

    const ownerUserId = member.id;
    const guildSettings = await getGuildSettings(member.guild, ownerUserId);
    if (!guildSettings.botEnabled) {
      throw createUserFacingError("MOON is paused for this server in the dashboard.");
    }

    destroySession(member.guild.id);

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: member.guild.id,
      adapterCreator: member.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20000);

    const onSpeakingStart = (userId) => {
      enqueueSpeech(member.guild, userId);
    };

    const session = {
      connection,
      receiver: connection.receiver,
      onSpeakingStart,
      ownerUserId,
      textChannelId: guildSettings.preferredTextChannelId || textChannel.id,
      isProcessing: false,
      speechQueue: [],
      activeCaptures: new Set(),
      focusSpeakerId: null,
      focusUntil: 0,
      lastCommandAt: 0,
      guildSettingsSnapshot: guildSettings,
      runtimeVoiceSettings: getRuntimeVoiceSettings(guildSettings),
    };

    connection.receiver.speaking.on("start", onSpeakingStart);
    sessions.set(member.guild.id, session);

    return session;
  }

  function getHelpText(guildSettings) {
    const runtimeVoiceSettings = getRuntimeVoiceSettings(guildSettings);
    const wakePrefix = runtimeVoiceSettings.requireWakeWord
      ? `${runtimeVoiceSettings.wakeWord} `
      : "";

    return [
      "**MOON commands**",
      `\`${config.PREFIX}join\` - join your current voice channel and listen for voice commands`,
      `\`${config.PREFIX}leave\` - disconnect MOON`,
      `\`${config.PREFIX}dashboard\` - open the admin dashboard`,
      `\`${config.PREFIX}help\` - show this help`,
      "",
      "**Voice commands**",
      runtimeVoiceSettings.requireWakeWord
        ? `Say the wake word first, for example \`${runtimeVoiceSettings.wakeWord}, lock the vc\``
        : "Speak the command phrase directly.",
      `\`${wakePrefix}drag <name> here\``,
      `\`${wakePrefix}drag <name> to general\``,
      `\`${wakePrefix}drag all to general\``,
      `\`${wakePrefix}drag me and aditya to admin room\``,
      `\`${wakePrefix}mute <name>\``,
      `\`${wakePrefix}unmute <name>\``,
      `\`${wakePrefix}kick <name>\``,
      `\`${wakePrefix}give <name> <role> role\``,
      `\`${wakePrefix}remove <role> role from <name>\``,
      `\`${wakePrefix}lock the vc\``,
      `\`${wakePrefix}unlock the vc\``,
    ].join("\n");
  }

  client.once("clientReady", async () => {
    log(`Logged in as ${client.user.tag}`);
    await syncBotPresence(client);
  });

  client.on("guildCreate", async (guild) => {
    if (typeof store.updateBotPresence === "function") {
      await store.updateBotPresence(guild.id, guild.name, true);
    }
  });

  client.on("guildDelete", async (guild) => {
    if (typeof store.updateBotPresence === "function") {
      await store.updateBotPresence(guild.id, guild.name, false);
    }
  });

  client.on("messageCreate", async (message) => {
    if (!message.guild || message.author.bot) {
      return;
    }

    const content = message.content.trim();
    if (!content.startsWith(config.PREFIX)) {
      return;
    }

    const commandName = content.slice(config.PREFIX.length).trim().toLowerCase();

    try {
      const guildSettings = await getGuildSettings(message.guild, message.author.id);

      if (commandName === "help") {
        await message.reply(getHelpText(guildSettings));
        return;
      }

      if (commandName === "dashboard") {
        await message.reply(`Dashboard: ${config.appBaseUrl}`);
        return;
      }

      if (commandName === "join") {
        if (!memberHasDashboardAdmin(message.member, guildSettings)) {
          await message.reply("Only server admins or configured MOON admins can start a session.");
          return;
        }

        const session = await connectToMemberChannel(message.member, message.channel);
        const wakeWordSummary = session.runtimeVoiceSettings.requireWakeWord
          ? `Wake word: **${session.runtimeVoiceSettings.wakeWord}**.`
          : `Wake word optional. Current wake word: **${session.runtimeVoiceSettings.wakeWord}**.`;
        await message.reply(`Listening in **${message.member.voice.channel.name}**. ${wakeWordSummary}`);
        return;
      }

      if (commandName === "leave") {
        if (!memberHasDashboardAdmin(message.member, guildSettings)) {
          await message.reply("Only server admins or configured MOON admins can stop a session.");
          return;
        }

        const connection = getVoiceConnection(message.guild.id);
        if (!connection) {
          await message.reply("MOON is not in a voice channel right now.");
          return;
        }

        destroySession(message.guild.id);
        await message.reply("Disconnected from voice.");
      }
    } catch (error) {
      log("Text command failed", error?.details ?? error);
      await message.reply(formatUserFacingError(error, "Command failed. Please try again."));
    }
  });

  client.on("voiceStateUpdate", async (oldState, newState) => {
    const session = getSession(newState.guild.id);
    if (!session || newState.id !== session.ownerUserId) {
      return;
    }

    const botMember = await newState.guild.members.fetchMe();
    if (!botMember.voice.channelId) {
      return;
    }

    if (!newState.channelId) {
      const textChannelId = session.textChannelId;
      destroySession(newState.guild.id);
      await sendStatusToChannel(
        newState.guild,
        textChannelId,
        "The session owner left voice, so MOON disconnected."
      );
      return;
    }

    if (newState.channelId === botMember.voice.channelId) {
      return;
    }

    try {
      session.connection.rejoin({
        channelId: newState.channelId,
        selfDeaf: false,
        selfMute: false,
      });

      await entersState(session.connection, VoiceConnectionStatus.Ready, 20000);
      await sendStatus(newState.guild, `Moved to **${newState.channel.name}** with the session owner.`);
    } catch (error) {
      log("Failed to follow session owner", error?.details ?? error);
      await sendStatus(newState.guild, formatUserFacingError(error, "Couldn't follow the session owner."));
    }
  });

  return {
    async start() {
      await client.login(config.DISCORD_TOKEN);
      return client;
    },
  };
}

module.exports = {
  createBot,
};









