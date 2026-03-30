const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

let whisperServerReady = false;

async function resolveServerBinary(config) {
  const candidates = [
    config.WHISPER_SERVER_PATH,
    config.WHISPER_CPP_PATH ? path.join(path.dirname(config.WHISPER_CPP_PATH), "whisper-server") : null,
    config.WHISPER_CPP_PATH ? path.join(path.dirname(config.WHISPER_CPP_PATH), "whisper-whisper-server") : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("Could not find a whisper.cpp server binary. Expected whisper-server next to whisper-cli.");
}

async function waitForServerReady(serverUrl, child, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  const probeUrl = new URL(serverUrl);
  probeUrl.pathname = "/";
  probeUrl.search = "";

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("Whisper server exited before becoming ready.");
    }

    try {
      await fetch(probeUrl, { method: "GET" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw new Error("Timed out waiting for the Whisper server to start.");
}

async function startWhisperServer(config) {
  if (!(config.SERVICE_MODE === "bot" || config.SERVICE_MODE === "all")) {
    return null;
  }

  let binaryPath;

  try {
    binaryPath = await resolveServerBinary(config);
  } catch (error) {
    console.warn(`[MOON] ${error.message} Falling back to whisper-cli per command.`);
    whisperServerReady = false;
    return null;
  }

  const args = [
    "-m",
    config.WHISPER_MODEL_PATH,
    "-l",
    config.WHISPER_LANGUAGE,
    "--host",
    "127.0.0.1",
    "--port",
    String(config.WHISPER_SERVER_PORT),
  ];

  const child = spawn(binaryPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[MOON][whisper] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[MOON][whisper] ${chunk}`);
  });

  child.on("error", (error) => {
    whisperServerReady = false;
    console.error("[MOON] Whisper server failed to start", error);
  });

  child.on("exit", () => {
    whisperServerReady = false;
  });

  await waitForServerReady(config.whisperServerUrl, child);
  whisperServerReady = true;

  const shutdown = () => {
    whisperServerReady = false;
    if (child.exitCode === null) {
      child.kill();
    }
  };

  process.once("exit", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return {
    child,
    shutdown,
  };
}

module.exports = {
  isWhisperServerReady: () => whisperServerReady,
  startWhisperServer,
};
