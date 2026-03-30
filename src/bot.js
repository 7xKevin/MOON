const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} = require("@discordjs/voice");
const prism = require("prism-media");
const { parseVoiceCommand } = require("./commandParser");
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

  async function collectPcmBuffer(receiver, userId) {
    return new Promise((resolve, reject) => {
      const opusStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: config.TRANSCRIPTION_SILENCE_MS,
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

  async function findMemberByName(guild, rawName) {
    const lookup = rawName.trim().toLowerCase();
    const members = await guild.members.fetch();

    let bestMatch = null;
    let bestScore = -1;

    for (const member of members.values()) {
      if (member.user.bot) {
        continue;
      }

      const candidates = [
        member.displayName,
        member.user.username,
        member.nickname,
        member.user.globalName,
      ]
        .filter(Boolean)
        .map((name) => name.toLowerCase());

      for (const candidate of candidates) {
        let score = -1;

        if (candidate === lookup) {
          score = 100;
        } else if (candidate.startsWith(lookup) || lookup.startsWith(candidate)) {
          score = 75;
        } else if (candidate.includes(lookup) || lookup.includes(candidate)) {
          score = 50;
        }

        if (score > bestScore) {
          bestScore = score;
          bestMatch = member;
        }
      }
    }

    return bestScore >= 50 ? bestMatch : null;
  }

  async function getGuildSettings(guild) {
    return store.getGuildSettings(guild.id, guild.name);
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

  async function executeVoiceCommand(guild, session, command, transcript) {
    const controller = await guild.members.fetch(session.ownerUserId);
    const controllerChannel = controller.voice.channel;
    const guildSettings = await getGuildSettings(guild);

    if (!controllerChannel) {
      throw new Error("The session owner is no longer in a voice channel.");
    }

    if (!guildSettings.botEnabled) {
      await sendStatus(guild, "This server has MOON paused in the dashboard.");
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

    const target = await findMemberByName(guild, command.targetName);
    if (!target) {
      await sendStatus(
        guild,
        `I heard \`${transcript}\`, but I couldn't find **${command.targetName}**.`
      );
      return;
    }

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

  async function handleSpeech(guild, userId) {
    const session = getSession(guild.id);
    if (!session || session.isProcessing) {
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

    const now = Date.now();
    if (now - session.lastCommandAt < config.COMMAND_COOLDOWN_MS) {
      return;
    }

    session.isProcessing = true;

    try {
      const pcmBuffer = await collectPcmBuffer(session.receiver, userId);
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
        wakeWord: config.WAKE_WORD,
        requireWakeWord: config.REQUIRE_WAKE_WORD,
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
      });
      await executeVoiceCommand(guild, session, command, transcript);
    } catch (error) {
      log("Voice command failed", error);
      await sendStatus(guild, `Voice command failed: ${error.message}`);
    } finally {
      session.isProcessing = false;
    }
  }

  async function connectToMemberChannel(member, textChannel) {
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      throw new Error("Join a voice channel first, then use !join.");
    }

    const guildSettings = await getGuildSettings(member.guild);
    if (!guildSettings.botEnabled) {
      throw new Error("MOON is paused for this server in the dashboard.");
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
      handleSpeech(member.guild, userId).catch((error) => {
        log("Unhandled speech error", error);
      });
    };

    const session = {
      connection,
      receiver: connection.receiver,
      onSpeakingStart,
      ownerUserId: config.CONTROLLER_USER_ID ?? member.id,
      textChannelId: guildSettings.preferredTextChannelId || textChannel.id,
      isProcessing: false,
      lastCommandAt: 0,
    };

    connection.receiver.speaking.on("start", onSpeakingStart);
    sessions.set(member.guild.id, session);

    return session;
  }

  function getHelpText() {
    const wakePrefix = config.REQUIRE_WAKE_WORD ? `${config.WAKE_WORD} ` : "";

    return [
      "**MOON commands**",
      `\`${config.PREFIX}join\` - join your current voice channel and listen for voice commands`,
      `\`${config.PREFIX}leave\` - disconnect MOON`,
      `\`${config.PREFIX}dashboard\` - open the admin dashboard`,
      `\`${config.PREFIX}help\` - show this help`,
      "",
      "**Voice commands**",
      config.REQUIRE_WAKE_WORD
        ? `Say the wake word first, for example \`${config.WAKE_WORD}, lock the vc\``
        : "Speak the command phrase directly.",
      `\`${wakePrefix}drag <name> here\``,
      `\`${wakePrefix}mute <name>\``,
      `\`${wakePrefix}unmute <name>\``,
      `\`${wakePrefix}kick <name>\``,
      `\`${wakePrefix}lock the vc\``,
      `\`${wakePrefix}unlock the vc\``,
    ].join("\n");
  }

  client.once("ready", () => {
    log(`Logged in as ${client.user.tag}`);
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
        await message.reply(getHelpText());
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
      log("Text command failed", error);
      await message.reply(`Command failed: ${error.message}`);
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
      log("Failed to follow session owner", error);
      await sendStatus(newState.guild, `Couldn't follow the session owner: ${error.message}`);
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
