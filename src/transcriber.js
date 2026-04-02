const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");
const { config } = require("./config");
const { isWhisperServerReady } = require("./whisperServer");

function createTranscriptionError(message, details, command) {
  return Object.assign(new Error(message), {
    details,
    command,
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(createTranscriptionError("Speech transcription failed.", stderr || stdout, command));
    });
  });
}

function convertPcmToWavBuffer(pcmBuffer) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-i",
      "pipe:0",
      "-af",
      "loudnorm=I=-16:LRA=11:TP=-1.5",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "pipe:1",
    ], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks = [];
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
        return;
      }

      reject(createTranscriptionError("Speech transcription failed.", stderr, ffmpegPath));
    });

    child.stdin.on("error", () => {
      // ffmpeg may close stdin early if it aborts; close path is handled above.
    });

    child.stdin.end(pcmBuffer);
  });
}

function resolveTranscriberSettings(overrides = {}) {
  return {
    preferredSttProvider:
      overrides.preferredSttProvider ??
      (config.hasGroqStt ? "groq" : config.hasDeepgramStt ? "deepgram" : config.hasAssemblyAiStt ? "assemblyai" : "local"),
    groqEnabled: overrides.groqEnabled ?? config.hasGroqStt,
    deepgramEnabled: overrides.deepgramEnabled ?? config.hasDeepgramStt,
    assemblyAiEnabled: overrides.assemblyAiEnabled ?? config.hasAssemblyAiStt,
    localWhisperEnabled: overrides.localWhisperEnabled ?? config.hasLocalWhisper,
    groqSttModel: overrides.groqSttModel ?? config.GROQ_STT_MODEL,
    deepgramSttModel: overrides.deepgramSttModel ?? config.DEEPGRAM_STT_MODEL,
    assemblyAiSttModel: overrides.assemblyAiSttModel ?? config.ASSEMBLYAI_STT_MODEL,
    whisperLanguage: overrides.whisperLanguage ?? config.WHISPER_LANGUAGE,
    whisperPrompt: overrides.whisperPrompt ?? config.WHISPER_PROMPT,
    whisperTemperature: overrides.whisperTemperature ?? config.WHISPER_TEMPERATURE,
    whisperBeamSize: overrides.whisperBeamSize ?? config.WHISPER_BEAM_SIZE,
    whisperBestOf: overrides.whisperBestOf ?? config.WHISPER_BEST_OF,
    keyterms: Array.isArray(overrides.keyterms) ? overrides.keyterms.filter(Boolean).slice(0, 64) : [],
  };
}

async function buildAudioFormData(wavBuffer, model, settings) {
  const form = new FormData();
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "command.wav");
  form.append("model", model);
  form.append("language", settings.whisperLanguage);
  form.append("prompt", settings.whisperPrompt);
  form.append("temperature", String(settings.whisperTemperature));
  form.append("response_format", "text");
  return form;
}

async function transcribeViaHttpEndpoint(url, wavBuffer, settings, options = {}) {
  const form = await buildAudioFormData(wavBuffer, options.model, settings);
  const response = await fetch(url, {
    method: "POST",
    headers: options.headers,
    body: form,
  });

  const body = await response.text();
  if (!response.ok) {
    throw createTranscriptionError("Speech transcription failed.", body, url);
  }

  return body.trim();
}

async function transcribeViaGroq(wavBuffer, settings) {
  return transcribeViaHttpEndpoint(config.GROQ_STT_URL, wavBuffer, settings, {
    model: settings.groqSttModel,
    headers: {
      Authorization: `Bearer ${config.GROQ_API_KEY}`,
    },
  });
}

async function transcribeViaDeepgram(wavBuffer, settings) {
  const url = new URL(config.DEEPGRAM_STT_URL);
  url.searchParams.set("model", settings.deepgramSttModel);
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("language", settings.whisperLanguage);
  for (const keyterm of settings.keyterms) {
    url.searchParams.append("keyterm", keyterm);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${config.DEEPGRAM_API_KEY}`,
      "Content-Type": "audio/wav",
    },
    body: wavBuffer,
  });

  const body = await response.text();
  if (!response.ok) {
    throw createTranscriptionError("Speech transcription failed.", body, url.toString());
  }

  const payload = JSON.parse(body);
  return payload?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim?.() ?? "";
}

async function uploadToAssemblyAi(wavBuffer) {
  const response = await fetch(`${config.ASSEMBLYAI_API_URL}/v2/upload`, {
    method: "POST",
    headers: {
      Authorization: config.ASSEMBLYAI_API_KEY,
      "Content-Type": "application/octet-stream",
    },
    body: wavBuffer,
  });

  const body = await response.text();
  if (!response.ok) {
    throw createTranscriptionError("Speech transcription failed.", body, `${config.ASSEMBLYAI_API_URL}/v2/upload`);
  }

  const payload = JSON.parse(body);
  return payload.upload_url;
}

async function transcribeViaAssemblyAi(wavBuffer, settings) {
  const uploadUrl = await uploadToAssemblyAi(wavBuffer);
  const transcriptRequest = {
    audio_url: uploadUrl,
    speech_models: [settings.assemblyAiSttModel],
    ...(settings.whisperLanguage === "auto"
      ? {
          language_detection: true,
        }
      : {
          language_code: settings.whisperLanguage,
        }),
  };

  if (settings.keyterms.length) {
    transcriptRequest.keyterms_prompt = settings.keyterms;
  }

  const response = await fetch(`${config.ASSEMBLYAI_API_URL}/v2/transcript`, {
    method: "POST",
    headers: {
      Authorization: config.ASSEMBLYAI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(transcriptRequest),
  });

  const body = await response.text();
  if (!response.ok) {
    throw createTranscriptionError("Speech transcription failed.", body, `${config.ASSEMBLYAI_API_URL}/v2/transcript`);
  }

  const { id } = JSON.parse(body);
  if (!id) {
    throw createTranscriptionError("Speech transcription failed.", "AssemblyAI did not return a transcript ID.", "assemblyai");
  }

  const pollingUrl = `${config.ASSEMBLYAI_API_URL}/v2/transcript/${id}`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const pollResponse = await fetch(pollingUrl, {
      headers: {
        Authorization: config.ASSEMBLYAI_API_KEY,
      },
    });

    const pollBody = await pollResponse.text();
    if (!pollResponse.ok) {
      throw createTranscriptionError("Speech transcription failed.", pollBody, pollingUrl);
    }

    const payload = JSON.parse(pollBody);
    if (payload.status === "completed") {
      return String(payload.text ?? "").trim();
    }

    if (payload.status === "error") {
      throw createTranscriptionError("Speech transcription failed.", payload.error ?? pollBody, pollingUrl);
    }
  }

  throw createTranscriptionError("Speech transcription failed.", "AssemblyAI transcription timed out.", pollingUrl);
}

async function transcribeViaServer(wavBuffer, settings) {
  return transcribeViaHttpEndpoint(config.whisperServerUrl, wavBuffer, settings, {
    model: "whisper-1",
  });
}

async function runWhisperCpp(wavBuffer, outputBasePath, settings) {
  const wavPath = `${outputBasePath}.wav`;
  await fs.writeFile(wavPath, wavBuffer);

  await runProcess(config.WHISPER_CPP_PATH, [
    "-m",
    config.WHISPER_MODEL_PATH,
    "-f",
    wavPath,
    "-l",
    settings.whisperLanguage,
    "-bs",
    String(settings.whisperBeamSize),
    "-bo",
    String(settings.whisperBestOf),
    "-tp",
    String(settings.whisperTemperature),
    "--prompt",
    settings.whisperPrompt,
    "-nt",
    "-otxt",
    "-of",
    outputBasePath,
  ]);

  const transcriptPath = `${outputBasePath}.txt`;
  const transcript = await fs.readFile(transcriptPath, "utf8");
  return transcript.trim();
}

async function cleanupTranscriptionFiles(outputBasePath) {
  await Promise.allSettled([
    fs.unlink(`${outputBasePath}.wav`),
    fs.unlink(`${outputBasePath}.txt`),
    fs.unlink(`${outputBasePath}.json`),
    fs.unlink(`${outputBasePath}.srt`),
    fs.unlink(`${outputBasePath}.vtt`),
    fs.unlink(`${outputBasePath}.csv`),
    fs.unlink(`${outputBasePath}.wts`),
  ]);
}

async function transcribePcmBuffer(pcmBuffer, overrides = {}) {
  await fs.mkdir(config.TEMP_DIR, { recursive: true });

  const jobId = randomUUID();
  const outputBasePath = path.join(config.TEMP_DIR, `${jobId}`);
  const wavBuffer = await convertPcmToWavBuffer(pcmBuffer);
  const settings = resolveTranscriberSettings(overrides);
  const providerOrder = [];

  const addProvider = (provider) => {
    if (!providerOrder.includes(provider)) {
      providerOrder.push(provider);
    }
  };

  if (settings.preferredSttProvider) {
    addProvider(settings.preferredSttProvider);
  }
  if (settings.groqEnabled && config.hasGroqStt) {
    addProvider("groq");
  }
  if (settings.deepgramEnabled && config.hasDeepgramStt) {
    addProvider("deepgram");
  }
  if (settings.assemblyAiEnabled && config.hasAssemblyAiStt) {
    addProvider("assemblyai");
  }
  if (settings.localWhisperEnabled && config.hasLocalWhisper) {
    addProvider("local");
  }

  try {
    for (const provider of providerOrder) {
      try {
        const startedAt = Date.now();
        if (provider === "groq") {
          const text = await transcribeViaGroq(wavBuffer, settings);
          return {
            text,
            provider,
            model: settings.groqSttModel,
            sttLatencyMs: Date.now() - startedAt,
          };
        }

        if (provider === "deepgram") {
          const text = await transcribeViaDeepgram(wavBuffer, settings);
          return {
            text,
            provider,
            model: settings.deepgramSttModel,
            sttLatencyMs: Date.now() - startedAt,
          };
        }

        if (provider === "assemblyai") {
          const text = await transcribeViaAssemblyAi(wavBuffer, settings);
          return {
            text,
            provider,
            model: settings.assemblyAiSttModel,
            sttLatencyMs: Date.now() - startedAt,
          };
        }

        if (provider === "local") {
          if (isWhisperServerReady()) {
            try {
              const text = await transcribeViaServer(wavBuffer, settings);
              return {
                text,
                provider,
                model: "whisper-server",
                sttLatencyMs: Date.now() - startedAt,
              };
            } catch (error) {
              console.warn("[MOON] Whisper server request failed, falling back to CLI.", error?.details ?? error);
            }
          }

          const text = await runWhisperCpp(wavBuffer, outputBasePath, settings);
          return {
            text,
            provider,
            model: config.WHISPER_MODEL_PATH ? path.basename(config.WHISPER_MODEL_PATH) : "whisper.cpp",
            sttLatencyMs: Date.now() - startedAt,
          };
        }
      } catch (error) {
        console.warn(`[MOON] ${provider} transcription failed, falling back.`, error?.details ?? error);
      }
    }

    throw createTranscriptionError(
      "Speech transcription failed.",
      "No speech provider is available. Configure a provider in MOON ADMIN or environment variables.",
      "transcriber"
    );
  } finally {
    await cleanupTranscriptionFiles(outputBasePath);
  }
}

module.exports = {
  transcribePcmBuffer,
};

