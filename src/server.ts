import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GrokClaimExtractor, UnavailableClaimExtractor } from "./services/claim-extractor.js";
import { EventBus } from "./services/event-bus.js";
import { MarketService } from "./services/market-service.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { BotRegistry, XOAuthService } from "./integrations/x-oauth.js";
import { XBotService } from "./services/x-bot-service.js";

const config = loadConfig();
const store = new SqliteStore(config.databasePath);
const events = new EventBus();
const extractor = config.xaiApiKey
  ? new GrokClaimExtractor(config.xaiApiKey, config.xaiModel)
  : new UnavailableClaimExtractor();
const markets = new MarketService(store, extractor, events);
const bots = new BotRegistry(
  process.env.X_BOT_USER_ID && process.env.X_BOT_ACCESS_TOKEN
    ? { userId: process.env.X_BOT_USER_ID, accessToken: process.env.X_BOT_ACCESS_TOKEN }
    : undefined,
);
const oauth = new XOAuthService(config, bots);
const xBots = new XBotService(store, bots, markets, config.appUrl);
const app = createApp({ store, events, markets, oauth, xBots, cronSecret: config.cronSecret });

const server = app.listen(config.port, () => {
  console.log(`Karma Markets listening on ${config.appUrl}`);
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
