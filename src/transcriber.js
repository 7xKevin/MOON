const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");
const { config } = require("./config");

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

      reject(
        Object.assign(new Error("Speech transcription failed."), {
          command,
          details: stderr || stdout,
        })
      );
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
    return await runWhisperCpp(wavPath, outputBasePath);
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
