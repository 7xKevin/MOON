const http = require("node:http");
const { config } = require("./config");
const { createBot } = require("./bot");
const { createSettingsStore } = require("./settingsStore");
const { createWebApp } = require("./web");

function startBotHealthServer() {
  if (!(config.SERVICE_MODE === "bot" || config.SERVICE_MODE === "all")) {
    return null;
  }

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, mode: "bot" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("MOON bot is running.");
    });

    server.listen(config.PORT, config.HOST, () => {
      console.log(`[MOON] Bot health server listening on ${config.HOST}:${config.PORT}`);
      resolve(server);
    });
  });
}

async function main() {
  const store = createSettingsStore(config);
  await store.init();

  const runners = [];

  if (config.SERVICE_MODE === "bot" || config.SERVICE_MODE === "all") {
    runners.push(startBotHealthServer());
    const bot = createBot({ config, store });
    runners.push(bot.start());
  }

  if (config.SERVICE_MODE === "web" || config.SERVICE_MODE === "all") {
    const web = createWebApp({ config, store });
    runners.push(web.start());
  }

  await Promise.all(runners);
}

main().catch((error) => {
  console.error("[MOON] Fatal startup error", error);
  process.exit(1);
});
