const { config } = require("./config");
const { createBot } = require("./bot");
const { createSettingsStore } = require("./settingsStore");
const { createWebApp } = require("./web");

async function main() {
  const store = createSettingsStore(config);
  await store.init();

  const runners = [];

  if (config.SERVICE_MODE === "bot" || config.SERVICE_MODE === "all") {
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
