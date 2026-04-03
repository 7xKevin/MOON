const { getGlobalVoiceCommandCatalog } = require("./commandParser");

function uniqueNames(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function memberNames(member) {
  return uniqueNames([
    member?.displayName,
    member?.nickname,
    member?.user?.globalName,
    member?.user?.username,
  ]);
}

function commandAvailability(guildSettings) {
  return {
    lock: Boolean(guildSettings.commandLockEnabled),
    unlock: Boolean(guildSettings.commandLockEnabled),
    mute: Boolean(guildSettings.commandMuteEnabled),
    unmute: Boolean(guildSettings.commandMuteEnabled),
    kick: Boolean(guildSettings.commandKickEnabled),
    drag: Boolean(guildSettings.commandDragEnabled),
    roleAdd: true,
    roleRemove: true,
    say: true,
    mention: true,
    spam: true,
    spamStop: true,
    soundboard: true,
  };
}

function buildSessionAgentContext(guild, controller, guildSettings, runtimeVoiceSettings) {
  const voiceChannels = [];
  const usersInChannels = {};
  for (const channel of guild.channels.cache.values()) {
    if (!channel?.isVoiceBased?.()) {
      continue;
    }

    voiceChannels.push(channel.name);
    usersInChannels[channel.name] = Array.from(channel.members.values()).flatMap((member) => memberNames(member));
  }

  const textChannels = Array.from(guild.channels.cache.values())
    .filter((channel) => channel?.isTextBased?.() && channel.name)
    .map((channel) => channel.name);

  const roles = Array.from(guild.roles.cache.values())
    .filter((role) => role.id !== guild.id)
    .map((role) => role.name);

  const members = Array.from(guild.members.cache.values()).map((member) => ({
    id: member.id,
    names: memberNames(member),
  }));

  const sounds = Array.from(guild.soundboardSounds?.cache?.values?.() ?? []).map((sound) => sound.name);

  return {
    guild_name: guild.name,
    wake_word: runtimeVoiceSettings.wakeWord,
    require_wake_word: Boolean(runtimeVoiceSettings.requireWakeWord),
    session_owner: {
      id: controller.id,
      names: memberNames(controller),
    },
    voice_channels: uniqueNames(voiceChannels),
    text_channels: uniqueNames(textChannels),
    roles: uniqueNames(roles),
    soundboard_sounds: uniqueNames(sounds),
    known_members: members,
    users_in_channels: Object.fromEntries(
      Object.entries(usersInChannels).map(([channelName, names]) => [channelName, uniqueNames(names)])
    ),
    command_access: {
      join_user_ids: guildSettings.joinUserIds,
      command_user_ids: guildSettings.commandUserIds,
    },
    enabled_actions: commandAvailability(guildSettings),
    command_catalog: getGlobalVoiceCommandCatalog().map((command) => ({
      family: command.family,
      syntax: command.syntax,
      description: command.description,
    })),
  };
}

function buildRuntimeAgentContext(sessionAgentContext, controller, speaker, session) {
  return {
    ...sessionAgentContext,
    speaker: {
      id: speaker.id,
      names: memberNames(speaker),
    },
    session_owner: {
      id: controller.id,
      names: memberNames(controller),
    },
    current_voice_channel: controller.voice.channel?.name ?? null,
    speaker_voice_channel: speaker.voice.channel?.name ?? null,
    recent_experience: Array.isArray(session?.agentExperience) ? session.agentExperience.slice(-8) : [],
  };
}

module.exports = {
  buildRuntimeAgentContext,
  buildSessionAgentContext,
};
