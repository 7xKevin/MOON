const { ChannelType } = require("discord.js");
const { config } = require("./config");
const { cleanCommandText, normalizeText, parseVoiceCommand } = require("./commandParser");

const GROUP_SOURCES = new Set(["all", "everyone", "everybody", "all here", "everyone here", "everybody here", "all of us", "us", "we"]);
const ALLOWED_TYPES = new Set(["lock", "unlock", "drag", "mute", "unmute", "kick", "role-add", "role-remove"]);

function uniqueStrings(values, limit) {
  const seen = new Set();
  const output = [];

  for (const value of values) {
    const normalized = cleanCommandText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    output.push(normalized);
    if (output.length >= limit) {
      break;
    }
  }

  return output;
}

function getGuildInterpreterContext(guild, speaker, controller) {
  const currentVoiceMembers = controller?.voice?.channel
    ? [...controller.voice.channel.members.values()]
        .filter((member) => member.id !== guild.members.me?.id)
        .map((member) => member.displayName)
    : [];

  const cachedMemberNames = [...guild.members.cache.values()]
    .filter((member) => member.id !== guild.members.me?.id)
    .map((member) => member.displayName);

  const voiceChannelNames = [...guild.channels.cache.values()]
    .filter((channel) => channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice)
    .map((channel) => channel.name);

  const roleNames = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.id)
    .map((role) => role.name);

  return {
    speakerName: speaker?.displayName ?? speaker?.user?.username ?? "speaker",
    controllerName: controller?.displayName ?? controller?.user?.username ?? "controller",
    memberNames: uniqueStrings([...currentVoiceMembers, ...cachedMemberNames], 60),
    voiceChannelNames: uniqueStrings(voiceChannelNames, 40),
    roleNames: uniqueStrings(roleNames, 40),
  };
}

function stripJsonFences(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function sanitizeName(value) {
  return cleanCommandText(String(value ?? ""));
}

function sanitizeTargetSpec(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const kind = input.kind === "list" || input.kind === "channel" ? input.kind : "single";
  const source = sanitizeName(input.source);
  const names = Array.isArray(input.names)
    ? input.names.map((name) => sanitizeName(name)).filter(Boolean).slice(0, 10)
    : [];

  if (kind === "channel") {
    const normalizedSource = source || names[0] || "all";
    return {
      kind: "channel",
      source: GROUP_SOURCES.has(normalizedSource) ? normalizedSource : "all",
      names: [],
    };
  }

  if (!names.length) {
    if (!source) {
      return null;
    }

    return {
      kind,
      source,
      names: [source],
    };
  }

  return {
    kind: names.length > 1 ? "list" : kind,
    source: source || names.join(" and "),
    names,
  };
}

function sanitizeAiCommand(payload, transcript) {
  if (!payload || typeof payload !== "object" || payload.recognized !== true) {
    return null;
  }

  const type = typeof payload.type === "string" ? payload.type.trim() : "";
  if (!ALLOWED_TYPES.has(type)) {
    return null;
  }

  const confidence = Number.isFinite(Number(payload.confidence))
    ? Math.max(0, Math.min(1, Number(payload.confidence)))
    : 0.9;

  if (type === "lock" || type === "unlock") {
    return {
      type,
      transcript: normalizeText(transcript),
      rawTranscript: transcript,
      confidence,
      matchType: "ai",
    };
  }

  const targetSpec = sanitizeTargetSpec(payload.target_spec);
  if (!targetSpec) {
    return null;
  }

  if (type === "drag") {
    const destinationType = payload.destination_type === "here" ? "here" : "named";
    const destinationName = destinationType === "named" ? sanitizeName(payload.destination_name) : null;
    const sourceChannelName = sanitizeName(payload.source_channel_name);

    if (destinationType === "named" && !destinationName) {
      return null;
    }

    return {
      type,
      targetSpec,
      targetName: targetSpec.names[0] ?? targetSpec.source,
      destinationType,
      destinationName,
      sourceChannelName: sourceChannelName || null,
      transcript: normalizeText(transcript),
      rawTranscript: transcript,
      confidence,
      matchType: "ai",
    };
  }

  if (type === "role-add" || type === "role-remove") {
    const roleName = sanitizeName(payload.role_name);
    if (!roleName) {
      return null;
    }

    return {
      type,
      targetSpec,
      targetName: targetSpec.names[0] ?? targetSpec.source,
      roleName,
      transcript: normalizeText(transcript),
      rawTranscript: transcript,
      confidence,
      matchType: "ai",
    };
  }

  return {
    type,
    targetSpec,
    targetName: targetSpec.names[0] ?? targetSpec.source,
    transcript: normalizeText(transcript),
    rawTranscript: transcript,
    confidence,
    matchType: "ai",
  };
}

function buildInterpreterPrompt(transcript, options) {
  const context = options.context;
  return JSON.stringify({
    transcript,
    wake_word: options.wakeWord,
    require_wake_word: options.requireWakeWord,
    speaker_name: context.speakerName,
    controller_name: context.controllerName,
    known_member_names: context.memberNames,
    known_voice_channel_names: context.voiceChannelNames,
    known_role_names: context.roleNames,
    supported_commands: [
      "lock the vc",
      "unlock the vc",
      "mute <target>",
      "unmute <target>",
      "kick/disconnect <target>",
      "drag/move/bring/send <target> here",
      "drag/move/bring/send <target> to <voice channel>",
      "drag/move everyone/all/us from <voice channel> to here",
      "give <target> <role> role",
      "remove <role> role from <target>"
    ],
    instructions: [
      "Correct noisy speech-to-text aggressively when the intended command is obvious.",
      "Return JSON only.",
      "If this is not a command for the bot, return {\"recognized\":false}.",
      "Use type kick for disconnect/remove-from-voice commands.",
      "Use target_spec.kind channel with source all/everyone/everybody/us/we for group moves.",
      "Use destination_type here or named.",
      "Do not invent members, channels, or roles outside the transcript and provided context.",
      "Prefer the closest known channel/member/role names when the transcript is slightly wrong."
    ]
  });
}

async function interpretViaGroq(transcript, options) {
  const response = await fetch(config.GROQ_COMMAND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.GROQ_COMMAND_MODEL,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You convert noisy Discord voice-command transcripts into strict JSON commands for a moderation bot. Supported types are lock, unlock, drag, mute, unmute, kick, role-add, and role-remove. Return only valid JSON.",
        },
        {
          role: "user",
          content: buildInterpreterPrompt(transcript, options),
        },
      ],
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Command interpreter failed: ${body}`);
  }

  const data = JSON.parse(body);
  const content = stripJsonFences(data?.choices?.[0]?.message?.content ?? "");
  if (!content) {
    return null;
  }

  return sanitizeAiCommand(JSON.parse(content), transcript);
}

async function interpretVoiceCommand(transcript, options = {}) {
  const parserFallback = parseVoiceCommand(transcript, options);

  if (!config.hasGroqStt || config.AI_COMMAND_INTERPRETER_ENABLED === false) {
    return parserFallback;
  }

  try {
    const aiCommand = await interpretViaGroq(transcript, options);
    return aiCommand || parserFallback;
  } catch (error) {
    console.warn("[MOON] AI command interpretation failed, falling back.", error?.message ?? error);
    return parserFallback;
  }
}

module.exports = {
  getGuildInterpreterContext,
  interpretVoiceCommand,
};

