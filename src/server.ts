import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GrokClaimExtractor, UnavailableClaimExtractor } from "./services/claim-extractor.js";
import { GrokMarketAnalysisGenerator, UnavailableMarketAnalysisGenerator } from "./services/market-analysis.js";
import { GrokMarketSummaryGenerator, UnavailableMarketSummaryGenerator } from "./services/market-summary.js";
import { GrokMarketResolver, UnavailableMarketResolver } from "./services/market-resolution.js";
import { EventBus } from "./services/event-bus.js";
import { MarketService } from "./services/market-service.js";
import { PostgresStore } from "./infrastructure/postgres-store.js";
import { BotRegistry, XOAuthService } from "./integrations/x-oauth.js";
import { XBotService } from "./services/x-bot-service.js";
import { SessionStore } from "./services/session-store.js";
import { DemoMarketPulse } from "./services/demo-market-pulse.js";
import { mountBroadcast } from "./broadcast/mount.js";

const config = loadConfig();
const store = new PostgresStore(config.databaseUrl);
await store.migrate();
const events = new EventBus();
const extractor = config.xaiApiKey
  ? new GrokClaimExtractor(config.xaiApiKey, config.xaiModel)
  : new UnavailableClaimExtractor();
const summaries = config.xaiApiKey
  ? new GrokMarketSummaryGenerator(config.xaiApiKey, config.xaiModel)
  : new UnavailableMarketSummaryGenerator();
const analyses = config.xaiApiKey
  ? new GrokMarketAnalysisGenerator(config.xaiApiKey, config.xaiModel)
  : new UnavailableMarketAnalysisGenerator();
const resolver = config.xaiApiKey
  ? new GrokMarketResolver(config.xaiApiKey, config.xaiModel)
  : new UnavailableMarketResolver();
const markets = new MarketService(store, extractor, events, summaries, analyses, resolver);
const sessions = new SessionStore();
const bots = new BotRegistry(
  (await store.getBotCredentials())
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

// The live channel rides on the same server so the whole product is one
// origin. Off by default because it generates video; BROADCAST=1 turns it on.
const broadcast =
  process.env.BROADCAST === "1"
    ? mountBroadcast({
        app,
        server,
        engineUrl: config.appUrl,
        log: (message) => console.log(`[live] ${message}`),
      })
    : undefined;
if (broadcast) console.log(`Live channel on ${config.appUrl}/live`);

function shutdown(): void {
  broadcast?.stop();
  demoPulse.stop();
  server.close(() => {
    void store.close().finally(() => process.exit(0));
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
