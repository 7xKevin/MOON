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

function buildAgentContext(guild, controller, speaker, guildSettings, runtimeVoiceSettings) {
  const voiceChannels = [];
  const usersInChannels = {};
  for (const channel of guild.channels.cache.values()) {
    if (!channel?.isVoiceBased?.()) {
      continue;
    }

    voiceChannels.push(channel.name);
    usersInChannels[channel.name] = Array.from(channel.members.values())
      .slice(0, 25)
      .flatMap((member) => memberNames(member))
      .slice(0, 25);
  }

  const textChannels = Array.from(guild.channels.cache.values())
    .filter((channel) => channel?.isTextBased?.() && channel.name)
    .slice(0, 60)
    .map((channel) => channel.name);

  const roles = Array.from(guild.roles.cache.values())
    .filter((role) => role.id !== guild.id)
    .slice(0, 60)
    .map((role) => role.name);

  const members = Array.from(guild.members.cache.values())
    .slice(0, 80)
    .map((member) => memberNames(member))
    .flat();

  const sounds = Array.from(guild.soundboardSounds?.cache?.values?.() ?? [])
    .slice(0, 40)
    .map((sound) => sound.name);

  return {
    guild_name: guild.name,
    wake_word: runtimeVoiceSettings.wakeWord,
    require_wake_word: Boolean(runtimeVoiceSettings.requireWakeWord),
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
    voice_channels: uniqueNames(voiceChannels),
    text_channels: uniqueNames(textChannels),
    roles: uniqueNames(roles),
    soundboard_sounds: uniqueNames(sounds),
    known_member_names: uniqueNames(members).slice(0, 120),
    users_in_channels: usersInChannels,
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

module.exports = {
  buildAgentContext,
};
