const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} = require("@discordjs/voice");
const prism = require("prism-media");
const { parseVoiceCommand, similarityScore } = require("./commandParser");
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

    session.receiver.speaking.off("start", session.onSpeakingStart);
    session.connection.destroy();
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

  function scoreMemberName(candidate, lookup) {
    const normalizedCandidate = String(candidate ?? "").trim().toLowerCase();
    const normalizedLookup = String(lookup ?? "").trim().toLowerCase();

    if (!normalizedCandidate || !normalizedLookup) {
      return -1;
    }

    if (normalizedCandidate === normalizedLookup) {
      return 1;
    }

    if (
      normalizedCandidate.startsWith(normalizedLookup) ||
      normalizedLookup.startsWith(normalizedCandidate)
    ) {
      return 0.92;
    }

    if (
      normalizedCandidate.includes(normalizedLookup) ||
      normalizedLookup.includes(normalizedCandidate)
    ) {
      return 0.82;
    }

    return similarityScore(normalizedCandidate, normalizedLookup);
  }

  function collectMemberScores(members, lookup, scoreMap) {
    for (const member of members.values()) {
      if (member.user.bot) {
        continue;
      }

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
    const lookup = rawName.trim().toLowerCase();
    const scoreMap = new Map();

    collectMemberScores(guild.members.cache, lookup, scoreMap);

    const searchedMembers = await guild.members
      .search({ query: rawName.slice(0, 32), limit: 25, cache: true })
      .catch(() => null);
    if (searchedMembers?.size) {
      collectMemberScores(searchedMembers, lookup, scoreMap);
    }

    let ranked = getTopMemberMatches(scoreMap);
    if ((!ranked.length || ranked[0].score < 0.82) && guild.memberCount <= 250) {
      const fetchedMembers = await guild.members.fetch().catch(() => null);
      if (fetchedMembers?.size) {
        collectMemberScores(fetchedMembers, lookup, scoreMap);
        ranked = getTopMemberMatches(scoreMap);
      }
    }

    const [best, second] = ranked;
    if (!best || best.score < 0.72) {
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

  async function getGuildSettings(guild) {
    return store.getGuildSettings(guild.id, guild.name);
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

  function getCommandConfidenceFloor(commandType) {
    if (commandType === "kick" || commandType === "drag") {
      return 0.82;
    }

    if (commandType === "mute" || commandType === "unmute") {
      return 0.76;
    }

    return 0.74;
  }

  function getTargetConfidenceFloor(commandType) {
    if (commandType === "kick" || commandType === "drag") {
      return 0.86;
    }

    return 0.8;
  }

  async function executeVoiceCommand(guild, session, command, transcript, guildSettings, controller) {
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

    const targetMatch = await findMemberByName(guild, command.targetName);
    if (!targetMatch.member) {
      await sendStatus(
        guild,
        `I heard \`${transcript}\`, but I couldn't confidently find **${command.targetName}**.`
      );
      return;
    }

    if (targetMatch.ambiguous) {
      const secondName = targetMatch.secondMember?.displayName || targetMatch.secondMember?.user?.username;
      await sendStatus(
        guild,
        secondName
          ? `I heard \`${transcript}\`, but **${command.targetName}** looks ambiguous between **${targetMatch.member.displayName}** and **${secondName}**.`
          : `I heard \`${transcript}\`, but **${command.targetName}** looks ambiguous.`
      );
      return;
    }

    if (targetMatch.score < getTargetConfidenceFloor(command.type)) {
      await sendStatus(
        guild,
        `I heard \`${transcript}\`, but I am not confident enough that **${targetMatch.member.displayName}** is the right target.`
      );
      return;
    }

    const target = targetMatch.member;

    if (command.type === "drag") {
      if (!target.voice.channel) {
        await sendStatus(guild, `**${target.displayName}** is not in a voice channel.`);
        return;
      }

      await target.voice.setChannel(
        controllerChannel,
        `MOON voice command by ${controller.user.tag}`
      );
      await sendStatus(guild, `Moved **${target.displayName}** into **${controllerChannel.name}**.`);
      return;
    }

    if (command.type === "mute") {
      if (!target.voice.channel) {
        await sendStatus(guild, `**${target.displayName}** is not in a voice channel.`);
        return;
      }

      await target.voice.setMute(true, `MOON voice command by ${controller.user.tag}`);
      await sendStatus(guild, `Server-muted **${target.displayName}**.`);
      return;
    }

    if (command.type === "unmute") {
      if (!target.voice.channel) {
        await sendStatus(guild, `**${target.displayName}** is not in a voice channel.`);
        return;
      }

      await target.voice.setMute(false, `MOON voice command by ${controller.user.tag}`);
      await sendStatus(guild, `Server-unmuted **${target.displayName}**.`);
      return;
    }

    if (command.type === "kick") {
      if (!target.voice.channel) {
        await sendStatus(guild, `**${target.displayName}** is not in a voice channel.`);
        return;
      }

      await target.voice.disconnect(`MOON voice command by ${controller.user.tag}`);
      await sendStatus(guild, `Disconnected **${target.displayName}** from voice chat.`);
    }
  }

  function getRuntimeVoiceSettings(guildSettings) {
    return {
      wakeWord: guildSettings.wakeWord || config.WAKE_WORD,
      requireWakeWord:
        guildSettings.requireWakeWord === undefined
          ? config.REQUIRE_WAKE_WORD
          : guildSettings.requireWakeWord,
      transcriptionSilenceMs:
        guildSettings.transcriptionSilenceMs || config.TRANSCRIPTION_SILENCE_MS,
      commandCooldownMs:
        guildSettings.commandCooldownMs || config.COMMAND_COOLDOWN_MS,
    };
  }

  async function processSpeech(guild, userId) {
    const session = getSession(guild.id);
    if (!session) {
      return;
    }

    const speaker = await guild.members.fetch(userId).catch(() => null);
    if (!speaker) {
      return;
    }

    const controller = await guild.members.fetch(session.ownerUserId).catch(() => null);
    if (!controller || !controller.voice.channelId) {
      return;
    }

    if (speaker.voice.channelId !== controller.voice.channelId) {
      return;
    }

    const guildSettings = await getGuildSettings(guild);
    if (!memberCanUseVoiceCommands(speaker, session, guildSettings)) {
      return;
    }

    const runtimeVoiceSettings = getRuntimeVoiceSettings(guildSettings);
    const now = Date.now();
    if (now - session.lastCommandAt < runtimeVoiceSettings.commandCooldownMs) {
      return;
    }

    const pcmBuffer = await collectPcmBuffer(
      session.receiver,
      userId,
      runtimeVoiceSettings.transcriptionSilenceMs
    );
    if (!pcmBuffer.length) {
      return;
    }

    const transcript = await transcribePcmBuffer(pcmBuffer);
    if (!transcript) {
      return;
    }

    if (config.DEBUG_TRANSCRIPTS || guildSettings.debugTranscripts) {
      await sendStatus(guild, `Transcript from **${speaker.displayName}**: \`${transcript}\``);
    }

    const command = parseVoiceCommand(transcript, {
      wakeWord: runtimeVoiceSettings.wakeWord,
      requireWakeWord: runtimeVoiceSettings.requireWakeWord,
    });
    if (!command) {
      log(`Ignored transcript from ${speaker.user.tag}: ${transcript}`);
      return;
    }

    session.lastCommandAt = Date.now();
    log(`Executing command: ${command.type}`, {
      guild: guild.name,
      speaker: speaker.user.tag,
      transcript,
      confidence: command.confidence,
    });

    await executeVoiceCommand(
      guild,
      session,
      command,
      transcript,
      guildSettings,
      controller
    );
  }

  async function drainSpeechQueue(guild) {
    const session = getSession(guild.id);
    if (!session || session.isProcessing) {
      return;
    }

    const nextUserId = session.speechQueue.shift();
    if (!nextUserId) {
      return;
    }

    session.queuedUserIds.delete(nextUserId);
    session.isProcessing = true;
    session.processingUserId = nextUserId;

    try {
      await processSpeech(guild, nextUserId);
    } catch (error) {
      log("Voice command failed", error?.details ?? error);
      await sendStatus(guild, formatUserFacingError(error, "Voice command failed. Please try again."));
    } finally {
      const latestSession = getSession(guild.id);
      if (!latestSession) {
        return;
      }

      latestSession.isProcessing = false;
      latestSession.processingUserId = null;

      if (latestSession.speechQueue.length > 0) {
        setImmediate(() => {
          drainSpeechQueue(guild).catch((error) => {
            log("Queue drain failed", error?.details ?? error);
          });
        });
      }
    }
  }

  function enqueueSpeech(guild, userId) {
    const session = getSession(guild.id);
    if (!session) {
      return;
    }

    if (session.processingUserId === userId || session.queuedUserIds.has(userId)) {
      return;
    }

    if (session.speechQueue.length >= 5) {
      const droppedUserId = session.speechQueue.shift();
      if (droppedUserId) {
        session.queuedUserIds.delete(droppedUserId);
      }
    }

    session.speechQueue.push(userId);
    session.queuedUserIds.add(userId);

    drainSpeechQueue(guild).catch((error) => {
      log("Queue start failed", error?.details ?? error);
    });
  }

  async function connectToMemberChannel(member, textChannel) {
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      throw createUserFacingError("Join a voice channel first, then use !join.");
    }

    const guildSettings = await getGuildSettings(member.guild);
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
      ownerUserId: config.CONTROLLER_USER_ID ?? member.id,
      textChannelId: guildSettings.preferredTextChannelId || textChannel.id,
      isProcessing: false,
      processingUserId: null,
      speechQueue: [],
      queuedUserIds: new Set(),
      lastCommandAt: 0,
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
      `\`${wakePrefix}mute <name>\``,
      `\`${wakePrefix}unmute <name>\``,
      `\`${wakePrefix}kick <name>\``,
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
      const guildSettings = await getGuildSettings(message.guild);

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

        await connectToMemberChannel(message.member, message.channel);
        await message.reply(`Listening in **${message.member.voice.channel.name}**.`);
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
