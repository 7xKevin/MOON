const { config } = require("./config");

function createAgentError(message, details) {
  return Object.assign(new Error(message), { details });
}

function extractFirstJsonObject(input) {
  const source = String(input ?? "");
  const start = source.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return null;
}

function normalizeList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set();
  const result = [];
  for (const value of values) {
    const item = String(value ?? "").trim();
    if (!item) {
      continue;
    }

    const key = item.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result.slice(0, 8);
}

function buildTargetSpec(argumentsObject) {
  const scope = String(argumentsObject?.target_scope ?? "").trim().toLowerCase();
  const targetNames = normalizeList(argumentsObject?.target_names);

  if (["me", "myself", "self", "speaker"].includes(scope)) {
    return { kind: "single", source: "me", names: ["me"] };
  }

  if (["current_channel", "all", "everyone", "everybody", "us"].includes(scope)) {
    return {
      kind: "channel",
      source: scope === "us" ? "us" : "all",
      names: [],
    };
  }

  if (targetNames.length) {
    return {
      kind: targetNames.length > 1 ? "list" : "single",
      source: targetNames.join(" and "),
      names: targetNames,
    };
  }

  return null;
}

function buildAgentCommand(decision, transcript, metadata = {}) {
  const action = String(decision?.action ?? "").trim().toLowerCase();
  const argumentsObject = decision?.arguments ?? {};
  const confidence = Number(decision?.confidence ?? 0.5);
  const base = {
    transcript,
    rawTranscript: transcript,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    matchType: "agent",
    understandingSource: "agent",
    understandingProvider: metadata.provider ?? "",
    understandingModel: metadata.model ?? "",
    agentThought: String(decision?.thought ?? "").trim(),
  };

  if (action === "ask_clarification") {
    return {
      type: "clarify",
      message: String(decision?.message ?? argumentsObject?.message ?? "Please clarify the command.").trim() || "Please clarify the command.",
      ...base,
    };
  }

  if (action === "no_op") {
    return null;
  }

  if (action === "lock" || action === "unlock" || action === "spam-stop") {
    return { type: action, ...base };
  }

  if (action === "soundboard") {
    const soundName = String(argumentsObject?.sound_name ?? "").trim();
    return soundName ? { type: "soundboard", soundName, ...base } : null;
  }

  if (action === "say" || action === "spam") {
    const channelName = String(argumentsObject?.channel_name ?? "").trim();
    const message = String(argumentsObject?.message ?? "").trim();
    return channelName && message ? { type: action, channelName, message, ...base } : null;
  }

  if (action === "mention") {
    const channelName = String(argumentsObject?.channel_name ?? "").trim();
    const targetSpec = buildTargetSpec(argumentsObject);
    return channelName && targetSpec
      ? { type: "mention", channelName, targetSpec, targetName: targetSpec.names[0] ?? targetSpec.source, ...base }
      : null;
  }

  if (action === "call") {
    const targetSpec = buildTargetSpec(argumentsObject);
    const channelName = String(argumentsObject?.channel_name ?? "").trim() || null;
    return targetSpec
      ? {
          type: "call",
          channelName,
          targetSpec,
          targetName: targetSpec.names[0] ?? targetSpec.source,
          ...base,
        }
      : null;
  }

  if (action === "drag") {
    const targetSpec = buildTargetSpec(argumentsObject);
    const destinationType = String(argumentsObject?.destination_type ?? "").trim().toLowerCase();
    const destinationName = String(argumentsObject?.destination_name ?? "").trim() || null;
    const sourceChannelName = String(argumentsObject?.source_channel_name ?? "").trim() || null;
    if (!targetSpec) {
      return null;
    }

    const normalizedDestinationType = destinationType === "here" ? "here" : destinationName ? "named" : null;
    if (!normalizedDestinationType) {
      return null;
    }

    return {
      type: "drag",
      targetSpec,
      targetName: targetSpec.names[0] ?? targetSpec.source,
      destinationType: normalizedDestinationType,
      destinationName,
      sourceChannelName,
      ...base,
    };
  }

  if (["mute", "unmute", "kick"].includes(action)) {
    const targetSpec = buildTargetSpec(argumentsObject);
    return targetSpec
      ? {
          type: action,
          targetSpec,
          targetName: targetSpec.names[0] ?? targetSpec.source,
          ...base,
        }
      : null;
  }

  if (action === "role-add" || action === "role-remove") {
    const targetSpec = buildTargetSpec(argumentsObject);
    const roleName = String(argumentsObject?.role_name ?? "").trim();
    return targetSpec && roleName
      ? {
          type: action,
          targetSpec,
          targetName: targetSpec.names[0] ?? targetSpec.source,
          roleName,
          ...base,
        }
      : null;
  }

  return null;
}

function buildMessages(transcript, context) {
  const system = [
    "You are MOON, a Discord voice-control agent.",
    "You must reason over live Discord context and choose the best single action.",
    "Never invent users, channels, roles, sounds, or actions outside the provided context.",
    "Prefer exact names from known_members, roles, text_channels, voice_channels, and soundboard_sounds.",
    "Use recent_experience to repeat choices that already worked in this session and avoid choices that recently failed.",
    "If the request is ambiguous or unsafe, choose ask_clarification instead of guessing.",
    "Return JSON only.",
    "Allowed actions: lock, unlock, mute, unmute, kick, drag, role-add, role-remove, say, mention, call, spam, spam-stop, soundboard, ask_clarification, no_op.",
    "For target_scope use one of: me, current_channel, named_users.",
    "For drag destination_type use one of: here, named.",
    "For role actions, choose the closest exact member name from known_members and the closest exact role from roles.",
    "For call actions, if the target user is clear and the speaker is already in voice, do not ask clarification just because channel_name is omitted. Use the session text channel by default and the speaker's current voice channel as the destination.",
  ].join(" ");

  const user = {
    transcript,
    context,
    required_output_schema: {
      thought: "short reasoning string",
      action: "lock|unlock|mute|unmute|kick|drag|role-add|role-remove|say|mention|call|spam|spam-stop|soundboard|ask_clarification|no_op",
      confidence: 0.0,
      message: "only for ask_clarification",
      arguments: {
        target_scope: "me|current_channel|named_users",
        target_names: ["names when needed"],
        destination_type: "here|named",
        destination_name: "voice channel name when needed",
        source_channel_name: "voice channel name when needed",
        channel_name: "text channel name when needed",
        role_name: "role name when needed",
        sound_name: "soundboard sound name when needed",
        message: "message text when needed"
      }
    },
    examples: [
      {
        transcript: "moon move me to general",
        output: {
          thought: "speaker wants to be moved to General",
          action: "drag",
          confidence: 0.93,
          arguments: {
            target_scope: "me",
            destination_type: "named",
            destination_name: "General"
          }
        }
      },
      {
        transcript: "moon mention aditya and equinox in general chat",
        output: {
          thought: "speaker wants to mention two named users in a text channel",
          action: "mention",
          confidence: 0.9,
          arguments: {
            target_scope: "named_users",
            target_names: ["aditya", "equinox"],
            channel_name: "general chat"
          }
        }
      },
      {
        transcript: "moon call aditya",
        output: {
          thought: "speaker wants to call Aditya into the speaker's current voice channel and the default session text channel is enough",
          action: "call",
          confidence: 0.93,
          arguments: {
            target_scope: "named_users",
            target_names: ["aditya"]
          }
        }
      },
      {
        transcript: "moon give tgff sai admin role",
        output: {
          thought: "speaker wants the member TGFF SAI to receive the Admin role",
          action: "role-add",
          confidence: 0.92,
          arguments: {
            target_scope: "named_users",
            target_names: ["TGFF SAI"],
            role_name: "admin"
          }
        }
      }
    ]
  };

  return {
    system,
    user,
  };
}

function buildDecisionSchema() {
  return {
    type: "object",
    properties: {
      thought: { type: "string", description: "Short reasoning string." },
      action: {
        type: "string",
        enum: [
          "lock", "unlock", "mute", "unmute", "kick", "drag", "role-add", "role-remove",
          "say", "mention", "call", "spam", "spam-stop", "soundboard", "ask_clarification", "no_op",
        ],
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      message: { type: ["string", "null"], description: "Only for ask_clarification." },
      arguments: {
        type: "object",
        properties: {
          target_scope: { type: ["string", "null"], enum: ["me", "current_channel", "named_users", null] },
          target_names: { type: "array", items: { type: "string" } },
          destination_type: { type: ["string", "null"], enum: ["here", "named", null] },
          destination_name: { type: ["string", "null"] },
          source_channel_name: { type: ["string", "null"] },
          channel_name: { type: ["string", "null"] },
          role_name: { type: ["string", "null"] },
          sound_name: { type: ["string", "null"] },
          message: { type: ["string", "null"] },
        },
        required: ["target_names"],
        additionalProperties: false,
      },
    },
    required: ["thought", "action", "confidence", "arguments"],
    additionalProperties: false,
  };
}

function resolveAgentSettings(overrides = {}) {
  const groqEnabled = overrides.groqEnabled ?? Boolean(config.GROQ_API_KEY);
  const geminiEnabled = overrides.geminiEnabled ?? Boolean(config.GEMINI_API_KEY);
  const availableProviders = [];

  if (groqEnabled && config.GROQ_API_KEY) {
    availableProviders.push("groq");
  }
  if (geminiEnabled && config.GEMINI_API_KEY) {
    availableProviders.push("gemini");
  }

  return {
    preferredProvider: String(overrides.preferredProvider ?? config.AGENT_PROVIDER ?? availableProviders[0] ?? "groq").trim().toLowerCase(),
    availableProviders,
    groqModel: String(overrides.groqModel ?? config.GROQ_AGENT_MODEL).trim(),
    groqUrl: String(overrides.groqUrl ?? config.GROQ_AGENT_URL).trim(),
    geminiModel: String(overrides.geminiModel ?? config.GEMINI_AGENT_MODEL).trim(),
    geminiUrl: String(overrides.geminiUrl ?? config.GEMINI_AGENT_URL).trim(),
  };
}

async function requestGroqDecision(transcript, context, controller, settings) {
  const { system, user } = buildMessages(transcript, context);

  const response = await fetch(settings.groqUrl, {
    method: "POST",
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${config.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: settings.groqModel,
      temperature: 0.1,
      max_tokens: 600,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw createAgentError("Agent request failed.", body);
  }

  const payload = JSON.parse(body);
  const content = payload?.choices?.[0]?.message?.content;
  const jsonText = extractFirstJsonObject(content);
  if (!jsonText) {
    throw createAgentError("Agent response did not contain JSON.", content);
  }

  return {
    provider: "groq",
    model: settings.groqModel,
    decision: JSON.parse(jsonText),
  };
}

async function requestGeminiDecision(transcript, context, controller, settings) {
  const { system, user } = buildMessages(transcript, context);
  const endpoint = `${settings.geminiUrl}/${encodeURIComponent(settings.geminiModel)}:generateContent`;

  const response = await fetch(endpoint, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "x-goog-api-key": config.GEMINI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${system}\n\n${JSON.stringify(user)}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseJsonSchema: buildDecisionSchema(),
      },
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw createAgentError("Agent request failed.", body);
  }

  const payload = JSON.parse(body);
  const content = payload?.candidates?.[0]?.content?.parts?.map((part) => part?.text ?? "").join("").trim();
  if (!content) {
    throw createAgentError("Agent response did not contain content.", body);
  }

  return {
    provider: "gemini",
    model: settings.geminiModel,
    decision: JSON.parse(content),
  };
}

async function interpretVoiceCommand(transcript, context, overrides = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.AGENT_TIMEOUT_MS);

  try {
    const settings = resolveAgentSettings(overrides);
    const providerOrder = [];
    const addProvider = (provider) => {
      if (settings.availableProviders.includes(provider) && !providerOrder.includes(provider)) {
        providerOrder.push(provider);
      }
    };

    addProvider(settings.preferredProvider);
    for (const provider of settings.availableProviders) {
      addProvider(provider);
    }

    let lastError = null;
    for (const provider of providerOrder) {
      try {
        const result = provider === "gemini"
          ? await requestGeminiDecision(transcript, context, controller, settings)
          : await requestGroqDecision(transcript, context, controller, settings);
        return buildAgentCommand(result.decision, transcript, {
          provider: result.provider,
          model: result.model,
        });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? createAgentError("No agent provider is available.", "no-agent-provider");
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createAgentError("Agent request timed out.", "timeout");
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  interpretVoiceCommand,
};
