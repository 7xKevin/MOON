const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} = require("@discordjs/voice");
const prism = require("prism-media");
const { buildWakeWordCandidates, getGlobalVoiceCommandCatalog, getVoiceCommandGuide, normalizeText, parseVoiceCommand, stripWakeWordPrefix } = require("./commandParser");
const { transcribePcmBuffer } = require("./transcriber");
const { interpretVoiceCommand } = require("./agent");
const { buildRuntimeAgentContext, buildSessionAgentContext } = require("./agentContext");
const {
  findRoleByName,
  findSoundboardSoundByName,
  findTextChannelByName,
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

  async function recordCommandTelemetry(event) {
    if (typeof store.recordCommandTelemetry !== "function") {
      return;
    }

    try {
      await store.recordCommandTelemetry(event);
    } catch (error) {
      log("Command telemetry failed", error?.details ?? error);
    }
  }

  function rememberAgentExperience(session, entry) {
    if (!session) {
      return;
    }

    if (!Array.isArray(session.agentExperience)) {
      session.agentExperience = [];
    }

    session.agentExperience.push(entry);
    if (session.agentExperience.length > 12) {
      session.agentExperience.splice(0, session.agentExperience.length - 12);
    }
  }

  function replaceDigitsWithWords(input) {
    return String(input ?? "")
      .replace(/\b0\b/g, "zero")
      .replace(/\b1\b/g, "one")
      .replace(/\b2\b/g, "two")
      .replace(/\b3\b/g, "three")
      .replace(/\b4\b/g, "four")
      .replace(/\b5\b/g, "five")
      .replace(/\b6\b/g, "six")
      .replace(/\b7\b/g, "seven")
      .replace(/\b8\b/g, "eight")
      .replace(/\b9\b/g, "nine")
      .replace(/\b10\b/g, "ten");
  }

  function buildKeytermVariants(value) {
    const source = String(value ?? "").trim();
    if (!source) {
      return [];
    }

    const variants = new Set();
    const pushVariant = (candidate) => {
      const normalized = normalizeText(candidate);
      if (normalized.length >= 2) {
        variants.add(normalized);
      }
    };

    pushVariant(source);
    pushVariant(source.replace(/-/g, " "));
    pushVariant(source.replace(/&/g, " and "));
    pushVariant(source.replace(/\bvc\b/gi, "v c"));
    pushVariant(source.replace(/\bvoice channel\b/gi, "vc"));
    pushVariant(replaceDigitsWithWords(source));
    pushVariant(replaceDigitsWithWords(source.replace(/-/g, " ")));

    return Array.from(variants);
  }

  function collectTranscriptionKeyterms(guild, runtimeVoiceSettings, controller = null, speaker = null) {
    const terms = new Set();
    const addTerm = (value) => {
      for (const variant of buildKeytermVariants(value)) {
        terms.add(variant);
      }
    };

    buildWakeWordCandidates(runtimeVoiceSettings.wakeWord).forEach(addTerm);
    [
      "lock vc",
      "unlock vc",
      "mute me",
      "mute",
      "unmute",
      "disconnect me",
      "disconnect all",
      "kick",
      "drag me",
      "drag all",
      "move me",
      "move all",
      "bring me",
      "role add",
      "role remove",
      "give role",
      "remove role",
      "say in",
      "send in",
      "mention",
      "ping",
      "spam",
      "stop spam",
      "play",
      "play sound",
      "soundboard",
      "voice channel",
      "general",
      "admin room",
      "live room",
      "waiting room",
      "rff area",
    ].forEach(addTerm);

    for (const command of getGlobalVoiceCommandCatalog()) {
      addTerm(command.syntax.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
    }

    const prioritizedMembers = new Map();
    for (const member of controller?.voice?.channel?.members?.values?.() ?? []) {
      prioritizedMembers.set(member.id, member);
    }
    if (speaker) {
      prioritizedMembers.set(speaker.id, speaker);
    }
    for (const member of Array.from(guild.members.cache.values()).slice(0, 40)) {
      if (!prioritizedMembers.has(member.id) && prioritizedMembers.size < 40) {
        prioritizedMembers.set(member.id, member);
      }
    }

    for (const member of prioritizedMembers.values()) {
      addTerm(member.displayName);
      addTerm(member.user.username);
      addTerm(member.nickname);
      addTerm(member.user.globalName);
    }

    const soundboardSounds = Array.from(guild.soundboardSounds?.cache?.values?.() ?? []).slice(0, 32);
    for (const sound of soundboardSounds) {
      addTerm(sound.name);
    }

    const channels = Array.from(guild.channels.cache.values()).slice(0, 48);
    for (const channel of channels) {
      addTerm(channel.name);
    }

    const roles = Array.from(guild.roles.cache.values()).filter((role) => role.id !== guild.id).slice(0, 32);
    for (const role of roles) {
      addTerm(role.name);
    }

    return Array.from(terms).slice(0, 64);
  }
function buildTranscriptionPrompt(runtimeVoiceSettings, keyterms) {
    const wakeAliases = buildWakeWordCandidates(runtimeVoiceSettings.wakeWord).join(", ");
    const hintedTerms = keyterms.slice(0, 18).join(", ");
    return [
      `Transcribe short Discord voice commands. Preferred wake word: ${runtimeVoiceSettings.wakeWord}.`,
      `Common wake word variants: ${wakeAliases}.`,
      "Keep command words literal: lock vc, unlock vc, mute, unmute, disconnect, drag, role add, role remove, say, mention, spam, stop spam.",
      hintedTerms ? `Important names and channels: ${hintedTerms}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  function buildAgentRuntimeSettings(globalAdminSettings = null) {
    return {
      preferredProvider: globalAdminSettings?.preferredAgentProvider,
      groqEnabled: globalAdminSettings?.groqAgentEnabled,
      geminiEnabled: globalAdminSettings?.geminiAgentEnabled,
      groqModel: globalAdminSettings?.groqAgentModel,
      geminiModel: globalAdminSettings?.geminiAgentModel,
    };
  }

  function describeUnderstandingPath(command) {
    if (command?.understandingSource === "agent") {
      return "agent:" + (command.understandingProvider || "unknown") + (command.understandingModel ? "/" + command.understandingModel : "");
    }

    return "parser:deterministic";
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

  async function getGlobalAdminSettings() {
    if (typeof store.getGlobalAdminSettings !== "function") {
      return null;
    }

    return store.getGlobalAdminSettings();
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

  function memberHasDashboardAdmin(member) {
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return true;
    }

    if (member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return true;
    }

    return false;
  }

  function memberCanJoinSession(member, guildSettings) {
    return guildSettings.joinUserIds.includes(member.id);
  }

  function memberCanUseVoiceCommands(member, guildSettings) {
    return guildSettings.commandUserIds.includes(member.id);
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

  function stopSpamJob(guildId) {
    const job = spamJobs.get(guildId);
    if (!job) {
      return false;
    }

    job.cancelled = true;
    spamJobs.delete(guildId);
    return true;
  }

  async function resolveTextChannel(guild, channelName) {
    return findTextChannelByName(guild, channelName);
  }

  function canSendText(channel, botMember) {
    if (!channel?.isTextBased?.()) {
      return false;
    }

    if (!botMember) {
      return false;
    }

    const permissions = channel.permissionsFor(botMember);
    return Boolean(
      permissions?.has(PermissionsBitField.Flags.ViewChannel) &&
        permissions.has(PermissionsBitField.Flags.SendMessages)
    );
  }

  function messageRequestsEveryoneMention(content) {
    return /@(?:everyone|here)\b/i.test(String(content ?? ""));
  }

  function canMentionEveryone(channel, botMember) {
    if (!botMember) {
      return false;
    }

    const permissions = channel.permissionsFor(botMember);
    return Boolean(permissions?.has(PermissionsBitField.Flags.MentionEveryone));
  }

  async function sendPlainText(channel, content) {
    const allowEveryone = messageRequestsEveryoneMention(content);
    return channel.send({
      content,
      allowedMentions: {
        parse: allowEveryone ? ["everyone"] : [],
      },
    });
  }

  async function sendMentionText(channel, members, options = {}) {
    if (options.everyone) {
      return channel.send({
        content: "@everyone",
        allowedMentions: {
          parse: ["everyone"],
        },
      });
    }

    const content = members.map((member) => '<@' + member.id + '>').join(' ');
    return channel.send({
      content,
      allowedMentions: {
        users: members.map((member) => member.id),
        roles: [],
        parse: [],
      },
    });
  }

  function startSpamJob(guild, channel, message, count) {
    stopSpamJob(guild.id);
    const job = { cancelled: false };
    spamJobs.set(guild.id, job);

    (async () => {
      try {
        for (let index = 0; index < count; index += 1) {
          if (job.cancelled) {
            break;
          }

          await sendPlainText(channel, message);

          if (index < count - 1) {
            await wait(1200);
          }
        }
      } catch (error) {
        log("Spam job failed", error?.details ?? error);
      } finally {
        if (spamJobs.get(guild.id) === job) {
          spamJobs.delete(guild.id);
        }
      }
    })().catch((error) => {
      log("Spam job failed", error?.details ?? error);
      if (spamJobs.get(guild.id) === job) {
        spamJobs.delete(guild.id);
      }
    });
  }

  function getBotCallCommand(member) {
    const names = [member?.displayName, member?.user?.globalName, member?.user?.username]
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter(Boolean);

    if (names.some((name) => name.includes("rythm"))) {
      return "!summon";
    }

    if (names.some((name) => name.includes("fredboat"))) {
      return ";;join";
    }

    return null;
  }

  async function resolveTextChannelForCall(guild, session, channelName) {
    if (channelName) {
      return resolveTextChannel(guild, channelName);
    }

    const fallbackChannel =
      guild.channels.cache.get(session.textChannelId) ?? (await guild.channels.fetch(session.textChannelId).catch(() => null));
    return {
      channel: fallbackChannel && fallbackChannel.isTextBased?.() ? fallbackChannel : null,
      score: fallbackChannel ? 1 : 0,
      ambiguous: false,
      secondChannel: null,
    };
  }

  async function executeVoiceCommand(guild, session, command, transcript, guildSettings, controller, speaker) {
    const controllerChannel = controller.voice.channel;

    if (!controllerChannel) {
      throw createUserFacingError("The session owner is no longer in a voice channel.");
    }

    if (!guildSettings.botEnabled) {
      await sendStatus(guild, "This server has MOON paused in the dashboard.");
      return { status: "blocked", reason: "bot-disabled" };
    }

    if ((command.confidence ?? 1) < getCommandConfidenceFloor(command.type)) {
      await sendStatus(guild, `I heard \`${transcript}\`, but I am not confident enough to run that command.`);
      return { status: "blocked", reason: "low-command-confidence" };
    }

    if (command.type === "drag" && !guildSettings.commandDragEnabled) {
      await sendStatus(guild, "Drag commands are disabled in the dashboard.");
      return { status: "blocked", reason: "drag-disabled" };
    }

    if ((command.type === "mute" || command.type === "unmute") && !guildSettings.commandMuteEnabled) {
      await sendStatus(guild, "Mute commands are disabled in the dashboard.");
      return { status: "blocked", reason: "mute-disabled" };
    }

    if (command.type === "kick" && !guildSettings.commandKickEnabled) {
      await sendStatus(guild, "Kick commands are disabled in the dashboard.");
      return { status: "blocked", reason: "kick-disabled" };
    }

    if ((command.type === "lock" || command.type === "unlock") && !guildSettings.commandLockEnabled) {
      await sendStatus(guild, "Lock commands are disabled in the dashboard.");
      return { status: "blocked", reason: "lock-disabled" };
    }

    if (command.type === "lock") {
      await controllerChannel.permissionOverwrites.edit(
        guild.roles.everyone,
        { Connect: false },
        { reason: `MOON voice command by ${controller.user.tag}` }
      );
      await sendStatus(guild, `Locked **${controllerChannel.name}**.`);
      return { status: "success", reason: "lock" };
    }

    if (command.type === "unlock") {
      await controllerChannel.permissionOverwrites.edit(
        guild.roles.everyone,
        { Connect: null },
        { reason: `MOON voice command by ${controller.user.tag}` }
      );
      await sendStatus(guild, `Unlocked **${controllerChannel.name}**.`);
      return { status: "success", reason: "unlock" };
    }

    if (command.type === "soundboard") {
      const soundMatch = await findSoundboardSoundByName(guild, command.soundName);
      if (!soundMatch.sound) {
        await sendStatus(guild, `I couldn't find a soundboard sound named **${command.soundName}**.`);
        return { status: "blocked", reason: "soundboard-missing" };
      }

      if (soundMatch.ambiguous) {
        await sendStatus(
          guild,
          soundMatch.secondSound?.name
            ? `I found multiple soundboard sounds close to **${command.soundName}**: **${soundMatch.sound.name}** and **${soundMatch.secondSound.name}**.`
            : `I found multiple soundboard sounds close to **${command.soundName}**.`
        );
        return { status: "blocked", reason: "soundboard-ambiguous" };
      }

      await controllerChannel.sendSoundboardSound(soundMatch.sound);
      await sendStatus(guild, `Played soundboard **${soundMatch.sound.name}** in **${controllerChannel.name}**.`);
      return { status: "success", reason: "soundboard" };
    }

    if (command.type === "spam-stop") {
      const stopped = stopSpamJob(guild.id);
      await sendStatus(guild, stopped ? "Stopped the active spam job." : "There is no active spam job right now.");
      return { status: "success", reason: stopped ? "spam-stopped" : "spam-not-running" };
    }

    if (command.type === "say" || command.type === "spam") {
      const botMember = guild.members.me;
      const channelMatch = await resolveTextChannel(guild, command.channelName);
      if (!channelMatch.channel) {
        await sendStatus(guild, `I couldn't find a text channel named **${command.channelName}**.`);
        return { status: "blocked", reason: "text-channel-missing" };
      }

      if (channelMatch.ambiguous) {
        const secondChannelName = channelMatch.secondChannel?.name;
        await sendStatus(
          guild,
          secondChannelName
            ? `I found multiple text channels close to **${command.channelName}**: **${channelMatch.channel.name}** and **${secondChannelName}**.`
            : `I found multiple text channels close to **${command.channelName}**.`
        );
        return { status: "blocked", reason: "text-channel-ambiguous" };
      }

      if (!canSendText(channelMatch.channel, botMember)) {
        await sendStatus(guild, `I can't send messages in **${channelMatch.channel.name}**.`);
        return { status: "blocked", reason: "text-channel-no-send" };
      }

      const safeMessage = String(command.message ?? "").trim().slice(0, 300);
      if (!safeMessage) {
        await sendStatus(guild, "I need some message text for that command.");
        return { status: "blocked", reason: "missing-message" };
      }

      if (messageRequestsEveryoneMention(safeMessage) && !canMentionEveryone(channelMatch.channel, botMember)) {
        await sendStatus(guild, `I don't have permission to mention everyone in **${channelMatch.channel.name}**.`);
        return { status: "blocked", reason: "mention-everyone-denied" };
      }

      if (command.type === "say") {
        await sendPlainText(channelMatch.channel, safeMessage);
        await sendStatus(guild, `Sent a message in **${channelMatch.channel.name}**.`);
        return { status: "success", reason: "say" };
      }

      const spamCount = 5;
      startSpamJob(guild, channelMatch.channel, safeMessage, spamCount);
      await sendStatus(guild, `Started spam in **${channelMatch.channel.name}** for **${spamCount}** messages.`);
      return { status: "success", reason: "spam-started" };
    }

    if (command.type === "call") {
      const botMember = guild.members.me;
      const channelMatch = await resolveTextChannelForCall(guild, session, command.channelName);
      if (!channelMatch.channel) {
        await sendStatus(guild, command.channelName
          ? `I couldn't find a text channel named **${command.channelName}**.`
          : "I couldn't find a text channel to send that call message.");
        return { status: "blocked", reason: "text-channel-missing" };
      }

      if (channelMatch.ambiguous) {
        const secondChannelName = channelMatch.secondChannel?.name;
        await sendStatus(
          guild,
          secondChannelName
            ? `I found multiple text channels close to **${command.channelName}**: **${channelMatch.channel.name}** and **${secondChannelName}**.`
            : `I found multiple text channels close to **${command.channelName}**.`
        );
        return { status: "blocked", reason: "text-channel-ambiguous" };
      }

      if (!canSendText(channelMatch.channel, botMember)) {
        await sendStatus(guild, `I can't send messages in **${channelMatch.channel.name}**.`);
        return { status: "blocked", reason: "text-channel-no-send" };
      }

      const callTargets = await resolveCommandTargets(guild, speaker, controller, command, getTargetConfidenceFloor);
      if (!callTargets.members.length) {
        await sendStatus(
          guild,
          formatResolutionFailures(transcript, callTargets.failures) ?? `I heard \`${transcript}\`, but I couldn't confidently resolve the target.`
        );
        return { status: "blocked", reason: "target-resolution-failed" };
      }

      const humanTargets = callTargets.members.filter((member) => !member.user.bot);
      const botTargets = callTargets.members.filter((member) => member.user.bot);

      if (humanTargets.length) {
        const mentionedIds = [...humanTargets.map((member) => member.id), speaker.id];
        const targetMentions = humanTargets.map((member) => `<@${member.id}>`).join(" ");
        await channelMatch.channel.send({
          content: `${targetMentions}, <@${speaker.id}> is calling you to join **${controllerChannel.name}**.`,
          allowedMentions: {
            users: mentionedIds,
            roles: [],
            parse: [],
          },
        });
      }

      const unsupportedBots = [];
      for (const botTarget of botTargets) {
        const summonCommand = getBotCallCommand(botTarget);
        if (!summonCommand) {
          unsupportedBots.push(botTarget);
          continue;
        }

        await channelMatch.channel.send(summonCommand);
      }

      if (unsupportedBots.length) {
        await sendStatus(guild, `I don't have a supported summon command for ${formatMemberList(unsupportedBots)} yet.`);
      }

      if (callTargets.failures.length) {
        await sendStatus(guild, formatResolutionFailures(transcript, callTargets.failures));
      }

      if (humanTargets.length || botTargets.length) {
        await sendStatus(guild, `Sent the call in **${channelMatch.channel.name}** for ${formatMemberList(callTargets.members)}.`);
        return { status: "success", reason: botTargets.length ? "call-mixed" : "call" };
      }

      return { status: "blocked", reason: "call-no-target" };
    }
    if (command.type === "mention") {
      const botMember = guild.members.me;
      const channelMatch = await resolveTextChannel(guild, command.channelName);
      if (!channelMatch.channel) {
        await sendStatus(guild, `I couldn't find a text channel named **${command.channelName}**.`);
        return { status: "blocked", reason: "text-channel-missing" };
      }

      if (channelMatch.ambiguous) {
        const secondChannelName = channelMatch.secondChannel?.name;
        await sendStatus(
          guild,
          secondChannelName
            ? `I found multiple text channels close to **${command.channelName}**: **${channelMatch.channel.name}** and **${secondChannelName}**.`
            : `I found multiple text channels close to **${command.channelName}**.`
        );
        return { status: "blocked", reason: "text-channel-ambiguous" };
      }

      if (!canSendText(channelMatch.channel, botMember)) {
        await sendStatus(guild, `I can't send messages in **${channelMatch.channel.name}**.`);
        return { status: "blocked", reason: "text-channel-no-send" };
      }

      const wantsEveryoneMention =
        command.targetSpec?.kind === "channel" &&
        ["all", "everyone", "everybody"].includes(String(command.targetSpec.source ?? "").toLowerCase());

      if (wantsEveryoneMention) {
        if (!canMentionEveryone(channelMatch.channel, botMember)) {
          await sendStatus(guild, `I don't have permission to mention everyone in **${channelMatch.channel.name}**.`);
          return { status: "blocked", reason: "mention-everyone-denied" };
        }

        await sendMentionText(channelMatch.channel, [], { everyone: true });
        await sendStatus(guild, `Mentioned **@everyone** in **${channelMatch.channel.name}**.`);
        return { status: "success", reason: "mention-everyone" };
      }

      const mentionTargets = await resolveCommandTargets(guild, speaker, controller, command, getTargetConfidenceFloor);
      if (!mentionTargets.members.length) {
        await sendStatus(
          guild,
          formatResolutionFailures(transcript, mentionTargets.failures) ?? `I heard \`${transcript}\`, but I couldn't confidently resolve the target.`
        );
        return { status: "blocked", reason: "target-resolution-failed" };
      }

      await sendMentionText(channelMatch.channel, mentionTargets.members);
      await sendStatus(guild, `Mentioned ${formatMemberList(mentionTargets.members)} in **${channelMatch.channel.name}**.`);
      if (mentionTargets.failures.length) {
        await sendStatus(guild, formatResolutionFailures(transcript, mentionTargets.failures));
      }
      return { status: "success", reason: "mention" };
    }

    const targetResult = await resolveCommandTargets(guild, speaker, controller, command, getTargetConfidenceFloor);
    if (!targetResult.members.length) {
      await sendStatus(
        guild,
        formatResolutionFailures(transcript, targetResult.failures) ?? `I heard \`${transcript}\`, but I couldn't confidently resolve the target.`
      );
      return { status: "blocked", reason: "target-resolution-failed" };
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
        return { status: "blocked", reason: "no-move-targets" };
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
      return { status: "success", reason: "drag" };
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
        return { status: "success", reason: "disconnect-bot" };
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
      return { status: "blocked", reason: "target-not-in-voice" };
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
    return { status: "success", reason: command.type };
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

    const [guildSettings, globalAdminSettings] = await Promise.all([
      getGuildSettings(guild, session.ownerUserId),
      getGlobalAdminSettings(),
    ]);
    session.guildSettingsSnapshot = guildSettings;
    session.runtimeVoiceSettings = getRuntimeVoiceSettings(guildSettings, config);
    const telemetryBase = {
      guildId: guild.id,
      guildName: guild.name,
      speakerId: speaker.id,
      speakerTag: speaker.user.tag,
      wakeWord: session.runtimeVoiceSettings.wakeWord,
      totalLatencyMs: Date.now() - job.capturedAt,
    };

    if (globalAdminSettings && !globalAdminSettings.globalBotEnabled) {
      await recordCommandTelemetry({
        ...telemetryBase,
        status: "blocked",
        reason: "global-bot-disabled",
      });
      return;
    }

    if (!memberCanUseVoiceCommands(speaker, guildSettings)) {
      await recordCommandTelemetry({
        ...telemetryBase,
        status: "blocked",
        reason: "speaker-not-allowed",
      });
      return;
    }

    if (!session.runtimeVoiceSettings.transcriptionEnabled) {
      await recordCommandTelemetry({
        ...telemetryBase,
        status: "blocked",
        reason: "transcription-disabled",
      });
      return;
    }

    const latestSession = getSession(guild.id);
    if (!latestSession) {
      return;
    }

    const keyterms = collectTranscriptionKeyterms(guild, session.runtimeVoiceSettings, controller, speaker);
    const transcription = await transcribePcmBuffer(pcmBuffer, {
      preferredSttProvider: globalAdminSettings?.preferredSttProvider,
      groqEnabled: globalAdminSettings?.groqEnabled,
      deepgramEnabled: globalAdminSettings?.deepgramEnabled,
      assemblyAiEnabled: globalAdminSettings?.assemblyAiEnabled,
      localWhisperEnabled: globalAdminSettings?.localWhisperEnabled,
      groqSttModel: globalAdminSettings?.groqSttModel,
      deepgramSttModel: globalAdminSettings?.deepgramSttModel,
      assemblyAiSttModel: globalAdminSettings?.assemblyAiSttModel,
      whisperPrompt: buildTranscriptionPrompt(session.runtimeVoiceSettings, keyterms),
      keyterms,
    });
    const transcript = transcription?.text?.trim?.() ?? "";
    if (!transcript || isIgnorableTranscript(transcript)) {
      await recordCommandTelemetry({
        ...telemetryBase,
        transcript,
        provider: transcription?.provider,
        model: transcription?.model,
        sttLatencyMs: transcription?.sttLatencyMs,
        totalLatencyMs: Date.now() - job.capturedAt,
        status: "ignored",
        reason: "ignorable-transcript",
      });
      return;
    }

    const effectiveWakeWord = latestSession.runtimeVoiceSettings?.wakeWord ?? session.runtimeVoiceSettings.wakeWord;
    const requireWakeWord =
      latestSession.runtimeVoiceSettings?.requireWakeWord ?? session.runtimeVoiceSettings.requireWakeWord;
    if (requireWakeWord && !stripWakeWordPrefix(normalizeText(transcript), effectiveWakeWord, true)) {
      await recordCommandTelemetry({
        ...telemetryBase,
        transcript,
        provider: transcription?.provider,
        model: transcription?.model,
        sttLatencyMs: transcription?.sttLatencyMs,
        totalLatencyMs: Date.now() - job.capturedAt,
        status: "ignored",
        reason: "wake-word-missing",
      });
      return;
    }

    let command = null;
    if (config.AGENT_ENABLED) {
      try {
        const agentContext = buildRuntimeAgentContext(
          latestSession.agentBaseContext ?? buildSessionAgentContext(guild, controller, guildSettings, latestSession.runtimeVoiceSettings ?? session.runtimeVoiceSettings),
          controller,
          speaker,
          latestSession
        );
        command = await interpretVoiceCommand(transcript, agentContext, buildAgentRuntimeSettings(globalAdminSettings));
      } catch (error) {
        log("Agent understanding failed, falling back", error?.details ?? error);
      }
    }

    if (!command) {
      command = parseVoiceCommand(transcript, {
        wakeWord: latestSession.runtimeVoiceSettings?.wakeWord ?? session.runtimeVoiceSettings.wakeWord,
        requireWakeWord:
          latestSession.runtimeVoiceSettings?.requireWakeWord ?? session.runtimeVoiceSettings.requireWakeWord,
      });
    }
    if (command && !command.understandingSource) {
      command.understandingSource = "parser";
      command.understandingProvider = "deterministic";
      command.understandingModel = "deterministic";
    }

    if (!command) {
      log(`Ignored transcript from ${speaker.user.tag}: ${transcript}`);
      await recordCommandTelemetry({
        ...telemetryBase,
        transcript,
        provider: transcription?.provider,
        model: transcription?.model,
        sttLatencyMs: transcription?.sttLatencyMs,
        totalLatencyMs: Date.now() - job.capturedAt,
        status: "ignored",
        reason: "understanding-failed",
      });
      rememberAgentExperience(latestSession, {
        transcript,
        outcome: "understanding-failed",
      });
      return;
    }

    if (command.type === "clarify") {
      await sendStatus(guild, command.message || "Please clarify the command.");
      await recordCommandTelemetry({
        ...telemetryBase,
        transcript,
        provider: transcription?.provider,
        model: transcription?.model,
        sttLatencyMs: transcription?.sttLatencyMs,
        totalLatencyMs: Date.now() - job.capturedAt,
        status: "blocked",
        reason: "clarification-requested",
      });
      rememberAgentExperience(latestSession, {
        transcript,
        outcome: "clarification-requested",
        message: command.message || "Please clarify the command.",
      });
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
      sttProvider: transcription?.provider ?? "unknown",
      sttModel: transcription?.model ?? "unknown",
      understanding: describeUnderstandingPath(command),
    });

    const executionResult = await executeVoiceCommand(
      guild,
      latestSession,
      command,
      transcript,
      guildSettings,
      controller,
      speaker
    );
    await recordCommandTelemetry({
      ...telemetryBase,
      transcript,
      commandType: command.type,
      provider: transcription?.provider,
      model: transcription?.model,
      sttLatencyMs: transcription?.sttLatencyMs,
      totalLatencyMs: Date.now() - job.capturedAt,
      status: executionResult?.status ?? "success",
      reason: executionResult?.reason ?? command.type,
    });
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
      const sessionForTelemetry = getSession(guild.id);
      const speaker =
        nextJob?.userId
          ? guild.members.cache.get(nextJob.userId) ?? (await guild.members.fetch(nextJob.userId).catch(() => null))
          : null;
      await recordCommandTelemetry({
        guildId: guild.id,
        guildName: guild.name,
        speakerId: speaker?.id ?? nextJob?.userId ?? "",
        speakerTag: speaker?.user?.tag ?? "unknown",
        wakeWord: sessionForTelemetry?.runtimeVoiceSettings?.wakeWord ?? "",
        status: "failed",
        reason: "execution-error",
        totalLatencyMs: nextJob?.capturedAt ? Date.now() - nextJob.capturedAt : null,
      });
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

    if (!memberCanUseVoiceCommands(speaker, guildSettings)) {
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
    await Promise.all([
      member.guild.members.fetch().catch(() => null),
      member.guild.channels.fetch().catch(() => null),
      member.guild.soundboardSounds?.fetch?.().catch(() => null),
    ]);
    const [guildSettings, globalAdminSettings] = await Promise.all([
      getGuildSettings(member.guild, ownerUserId),
      getGlobalAdminSettings(),
    ]);
    if (globalAdminSettings && !globalAdminSettings.globalBotEnabled) {
      throw createUserFacingError("MOON is globally paused by MOON ADMIN.");
    }
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

    const runtimeVoiceSettings = getRuntimeVoiceSettings(guildSettings, config);
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
      runtimeVoiceSettings,
      agentBaseContext: buildSessionAgentContext(member.guild, member, guildSettings, runtimeVoiceSettings),
      agentExperience: [],
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
      const [guildSettings, globalAdminSettings] = await Promise.all([
        getGuildSettings(message.guild, message.author.id),
        getGlobalAdminSettings(),
      ]);

      if (commandName === "help") {
        await message.reply(getHelpText(guildSettings));
        return;
      }

      if (commandName === "dashboard") {
        await message.reply(`Dashboard: ${config.appBaseUrl}`);
        return;
      }

      if (commandName === "join") {
        if (globalAdminSettings && !globalAdminSettings.globalBotEnabled) {
          await message.reply("MOON is globally paused by MOON ADMIN.");
          return;
        }

        if (!guildSettings.joinUserIds.length) {
          await message.reply("No Join user IDs are configured for this server yet.");
          return;
        }

        if (!memberCanJoinSession(message.member, guildSettings)) {
          await message.reply("Only users in the Join user IDs list can start a session.");
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
        if (!guildSettings.joinUserIds.length) {
          await message.reply("No Join user IDs are configured for this server yet.");
          return;
        }

        if (!memberCanJoinSession(message.member, guildSettings)) {
          await message.reply("Only users in the Join user IDs list can stop a session.");
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



