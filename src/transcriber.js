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
    preferredSttProvider: overrides.preferredSttProvider ?? (config.hasGroqStt ? "groq" : "local"),
    groqSttModel: overrides.groqSttModel ?? config.GROQ_STT_MODEL,
    whisperLanguage: overrides.whisperLanguage ?? config.WHISPER_LANGUAGE,
    whisperPrompt: overrides.whisperPrompt ?? config.WHISPER_PROMPT,
    whisperTemperature: overrides.whisperTemperature ?? config.WHISPER_TEMPERATURE,
    whisperBeamSize: overrides.whisperBeamSize ?? config.WHISPER_BEAM_SIZE,
    whisperBestOf: overrides.whisperBestOf ?? config.WHISPER_BEST_OF,
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

  try {
    if (settings.preferredSttProvider === "groq" && config.hasGroqStt) {
      try {
        return await transcribeViaGroq(wavBuffer, settings);
      } catch (error) {
        console.warn("[MOON] Groq transcription failed, falling back.", error?.details ?? error);
      }
    }

    if (isWhisperServerReady()) {
      try {
        return await transcribeViaServer(wavBuffer, settings);
      } catch (error) {
        console.warn("[MOON] Whisper server request failed, falling back to CLI.", error?.details ?? error);
      }
    }

    if (config.hasLocalWhisper) {
      return await runWhisperCpp(wavBuffer, outputBasePath, settings);
    }

    if (config.hasGroqStt) {
      return await transcribeViaGroq(wavBuffer, settings);
    }

    throw createTranscriptionError(
      "Speech transcription failed.",
      "No speech provider is available. Configure GROQ_API_KEY or local whisper.cpp.",
      "transcriber"
    );
  } finally {
    await cleanupTranscriptionFiles(outputBasePath);
  }
}

module.exports = {
  transcribePcmBuffer,
};

