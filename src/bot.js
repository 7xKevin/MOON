const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} = require("@discordjs/voice");
const prism = require("prism-media");
const { getVoiceCommandGuide, parseVoiceCommand } = require("./commandParser");
const { transcribePcmBuffer } = require("./transcriber");
const {
  findRoleByName,
  findVoiceChannelByName,
  formatMemberList,
  formatResolutionFailures,
  resolveCommandTargets,
} = require("./discordResolvers");
const {
  getCommandConfidenceFloor,
  getRuntimeVoiceSettings,
  getTargetConfidenceFloor,
  isIgnorableTranscript,
  shouldDiscardPcmBuffer,
  shouldPostTranscripts,
} = require("./voiceCommandRuntime");

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
  const spamJobs = new Map();

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

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

    if (command.type === "spam-stop") {
      const stopped = stopSpamJob(guild.id);
      await sendStatus(guild, stopped ? "Stopped the active spam job." : "There is no active spam job right now.");
      return;
    }

    if (command.type === "say" || command.type === "spam") {
      const botMember = guild.members.me;
      const channelMatch = await resolveTextChannel(guild, command.channelName);
      if (!channelMatch.channel) {
        await sendStatus(guild, `I couldn't find a text channel named **${command.channelName}**.`);
        return;
      }

      if (channelMatch.ambiguous) {
        const secondChannelName = channelMatch.secondChannel?.name;
        await sendStatus(
          guild,
          secondChannelName
            ? `I found multiple text channels close to **${command.channelName}**: **${channelMatch.channel.name}** and **${secondChannelName}**.`
            : `I found multiple text channels close to **${command.channelName}**.`
        );
        return;
      }

      if (!canSendText(channelMatch.channel, botMember)) {
        await sendStatus(guild, `I can't send messages in **${channelMatch.channel.name}**.`);
        return;
      }

      const safeMessage = String(command.message ?? "").trim().slice(0, 300);
      if (!safeMessage) {
        await sendStatus(guild, "I need some message text for that command.");
        return;
      }

      if (command.type === "say") {
        await sendPlainText(channelMatch.channel, safeMessage);
        await sendStatus(guild, `Sent a message in **${channelMatch.channel.name}**.`);
        return;
      }

      const spamCount = Math.min(Math.max(command.count || 1, 1), 5);
      startSpamJob(guild, channelMatch.channel, safeMessage, spamCount);
      await sendStatus(guild, `Started spam in **${channelMatch.channel.name}** for **${spamCount}** messages.`);
      return;
    }

    if (command.type === "mention") {
      const botMember = guild.members.me;
      const channelMatch = await resolveTextChannel(guild, command.channelName);
      if (!channelMatch.channel) {
        await sendStatus(guild, `I couldn't find a text channel named **${command.channelName}**.`);
        return;
      }

      if (channelMatch.ambiguous) {
        const secondChannelName = channelMatch.secondChannel?.name;
        await sendStatus(
          guild,
          secondChannelName
            ? `I found multiple text channels close to **${command.channelName}**: **${channelMatch.channel.name}** and **${secondChannelName}**.`
            : `I found multiple text channels close to **${command.channelName}**.`
        );
        return;
      }

      if (!canSendText(channelMatch.channel, botMember)) {
        await sendStatus(guild, `I can't send messages in **${channelMatch.channel.name}**.`);
        return;
      }

      const mentionTargets = await resolveCommandTargets(guild, speaker, controller, command, getTargetConfidenceFloor);
      if (!mentionTargets.members.length) {
        await sendStatus(
          guild,
          formatResolutionFailures(transcript, mentionTargets.failures) ?? `I heard \`${transcript}\`, but I couldn't confidently resolve the target.`
        );
        return;
      }

      await sendMentionText(channelMatch.channel, mentionTargets.members);
      await sendStatus(guild, `Mentioned ${formatMemberList(mentionTargets.members)} in **${channelMatch.channel.name}**.`);
      if (mentionTargets.failures.length) {
        await sendStatus(guild, formatResolutionFailures(transcript, mentionTargets.failures));
      }
      return;
    }

    const targetResult = await resolveCommandTargets(guild, speaker, controller, command, getTargetConfidenceFloor);
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
    session.runtimeVoiceSettings = getRuntimeVoiceSettings(guildSettings, config);

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

    let nextJob = session.speechQueue.shift();
    while (nextJob && Date.now() - nextJob.capturedAt > session.runtimeVoiceSettings.maxQueuedCommandAgeMs) {
      nextJob = session.speechQueue.shift();
    }

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
    session.runtimeVoiceSettings = getRuntimeVoiceSettings(guildSettings, config);

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

      if (!pcmBuffer.length || shouldDiscardPcmBuffer(pcmBuffer, session.runtimeVoiceSettings)) {
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
      runtimeVoiceSettings: getRuntimeVoiceSettings(guildSettings, config),
    };

    connection.receiver.speaking.on("start", onSpeakingStart);
    sessions.set(member.guild.id, session);

    return session;
  }

  function getHelpText(guildSettings) {
    const runtimeVoiceSettings = getRuntimeVoiceSettings(guildSettings, config);

    return [
      "**MOON commands**",
      `\`${config.PREFIX}join\` - join your current voice channel and show the global voice commands`,
      `\`${config.PREFIX}leave\` - disconnect MOON`,
      `\`${config.PREFIX}dashboard\` - open the admin dashboard`,
      `\`${config.PREFIX}help\` - show this help`,
      "",
      runtimeVoiceSettings.requireWakeWord
        ? `Wake word required: **${runtimeVoiceSettings.wakeWord}**`
        : `Wake word optional. Current wake word: **${runtimeVoiceSettings.wakeWord}**`,
      "",
      getVoiceCommandGuide(runtimeVoiceSettings),
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
        await sendStatusToChannel(message.guild, session.textChannelId, getVoiceCommandGuide(session.runtimeVoiceSettings));
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



