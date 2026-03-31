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

async function convertPcmToWav(inputPath, outputPath) {
  await runProcess(ffmpegPath, [
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-i",
    inputPath,
    "-af",
    "loudnorm=I=-16:LRA=11:TP=-1.5",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    "-y",
    outputPath,
  ]);
}

async function transcribeViaGroq(wavPath) {
  const wavBuffer = await fs.readFile(wavPath);
  const form = new FormData();
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "command.wav");
  form.append("model", config.GROQ_STT_MODEL);
  form.append("language", config.WHISPER_LANGUAGE);
  form.append("prompt", config.WHISPER_PROMPT);
  form.append("temperature", String(config.WHISPER_TEMPERATURE));
  form.append("response_format", "text");

  const response = await fetch(config.GROQ_STT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.GROQ_API_KEY}`,
    },
    body: form,
  });

  const body = await response.text();
  if (!response.ok) {
    throw createTranscriptionError("Speech transcription failed.", body, config.GROQ_STT_URL);
  }

  return body.trim();
}

async function transcribeViaServer(wavPath) {
  const wavBuffer = await fs.readFile(wavPath);
  const form = new FormData();
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "command.wav");
  form.append("model", "whisper-1");
  form.append("language", config.WHISPER_LANGUAGE);
  form.append("prompt", config.WHISPER_PROMPT);
  form.append("temperature", String(config.WHISPER_TEMPERATURE));
  form.append("response_format", "text");

  const response = await fetch(config.whisperServerUrl, {
    method: "POST",
    body: form,
  });

  const body = await response.text();
  if (!response.ok) {
    throw createTranscriptionError("Speech transcription failed.", body, config.whisperServerUrl);
  }

  return body.trim();
}

async function runWhisperCpp(wavPath, outputBasePath) {
  await runProcess(config.WHISPER_CPP_PATH, [
    "-m",
    config.WHISPER_MODEL_PATH,
    "-f",
    wavPath,
    "-l",
    config.WHISPER_LANGUAGE,
    "-bs",
    String(config.WHISPER_BEAM_SIZE),
    "-bo",
    String(config.WHISPER_BEST_OF),
    "-tp",
    String(config.WHISPER_TEMPERATURE),
    "--prompt",
    config.WHISPER_PROMPT,
    "-nt",
    "-otxt",
    "-of",
    outputBasePath,
  ]);

  const transcriptPath = `${outputBasePath}.txt`;
  const transcript = await fs.readFile(transcriptPath, "utf8");
  return transcript.trim();
}

async function transcribePcmBuffer(pcmBuffer) {
  await fs.mkdir(config.TEMP_DIR, { recursive: true });

  const jobId = randomUUID();
  const rawPath = path.join(config.TEMP_DIR, `${jobId}.pcm`);
  const wavPath = path.join(config.TEMP_DIR, `${jobId}.wav`);
  const outputBasePath = path.join(config.TEMP_DIR, `${jobId}`);

  try {
    await fs.writeFile(rawPath, pcmBuffer);
    await convertPcmToWav(rawPath, wavPath);

    if (config.hasGroqStt) {
      try {
        return await transcribeViaGroq(wavPath);
      } catch (error) {
        console.warn("[MOON] Groq transcription failed, falling back.", error?.details ?? error);
      }
    }

    if (isWhisperServerReady()) {
      try {
        return await transcribeViaServer(wavPath);
      } catch (error) {
        console.warn("[MOON] Whisper server request failed, falling back to CLI.", error?.details ?? error);
      }
    }

    if (config.hasLocalWhisper) {
      return await runWhisperCpp(wavPath, outputBasePath);
    }

    throw createTranscriptionError(
      "Speech transcription failed.",
      "No speech provider is available. Configure GROQ_API_KEY or local whisper.cpp.",
      "transcriber"
    );
  } finally {
    await Promise.allSettled([
      fs.unlink(rawPath),
      fs.unlink(wavPath),
      fs.unlink(`${outputBasePath}.txt`),
      fs.unlink(`${outputBasePath}.json`),
      fs.unlink(`${outputBasePath}.srt`),
      fs.unlink(`${outputBasePath}.vtt`),
      fs.unlink(`${outputBasePath}.csv`),
      fs.unlink(`${outputBasePath}.wts`),
    ]);
  }
}

module.exports = {
  transcribePcmBuffer,
};
