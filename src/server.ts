import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GrokClaimExtractor, UnavailableClaimExtractor } from "./services/claim-extractor.js";
import { EventBus } from "./services/event-bus.js";
import { MarketService } from "./services/market-service.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { BotRegistry, XOAuthService } from "./integrations/x-oauth.js";
import { XBotService } from "./services/x-bot-service.js";
import { SessionStore } from "./services/session-store.js";
import { DemoMarketPulse } from "./services/demo-market-pulse.js";

const config = loadConfig();
const store = new SqliteStore(config.databasePath);
const events = new EventBus();
const extractor = config.xaiApiKey
  ? new GrokClaimExtractor(config.xaiApiKey, config.xaiModel)
  : new UnavailableClaimExtractor();
const markets = new MarketService(store, extractor, events);
const sessions = new SessionStore();
const bots = new BotRegistry(
  store.getBotCredentials()
    ?? (process.env.X_BOT_USER_ID && process.env.X_BOT_ACCESS_TOKEN
      ? { userId: process.env.X_BOT_USER_ID, accessToken: process.env.X_BOT_ACCESS_TOKEN }
      : undefined),
);
const oauth = new XOAuthService(
  config,
  bots,
  (credentials) => store.saveBotCredentials(credentials),
  (history) => markets.createAccount(history),
);
const xBots = new XBotService(store, bots, markets, config.appUrl);
const app = createApp({ store, events, markets, oauth, xBots, sessions, cronSecret: config.cronSecret });
const demoPulse = new DemoMarketPulse(store, markets);
demoPulse.start();

const server = app.listen(config.port, () => {
  console.log(`Threadline listening on ${config.appUrl}`);
});

function shutdown(): void {
  demoPulse.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
