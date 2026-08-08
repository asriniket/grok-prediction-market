import express, { type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { AppError } from "./domain/errors.js";
import type { Outcome } from "./domain/types.js";
import { SqliteStore } from "./infrastructure/sqlite-store.js";
import { XOAuthService } from "./integrations/x-oauth.js";
import { EventBus } from "./services/event-bus.js";
import { MarketService } from "./services/market-service.js";
import { XBotService } from "./services/x-bot-service.js";
import { marketIndexPage, marketPage } from "./ui/market-pages.js";

const outcomeSchema = z.enum(["YES", "NO"]);
const historySchema = z.object({
  xUserId: z.string().min(1).max(64),
  handle: z.string().min(1).max(50),
  accountCreatedAt: z.string().datetime(),
  postCount: z.number().int().nonnegative(),
  impressionSamples: z.array(z.number().nonnegative()).max(100),
});
const sourcePostSchema = z.object({
  id: z.string().min(1).max(64),
  url: z.string().url(),
  text: z.string().min(1).max(25_000),
  authorId: z.string().min(1).max(64),
  authorHandle: z.string().min(1).max(50),
  createdAt: z.string().datetime(),
});
const claimSchema = z.object({
  question: z.string().min(12).max(240),
  resolutionCriteria: z.array(z.string().min(8).max(500)).min(1).max(5),
  closesAt: z.string().datetime(),
  rationale: z.string().min(1).max(500),
});

export interface AppDependencies {
  store: SqliteStore;
  events: EventBus;
  markets: MarketService;
  oauth: XOAuthService;
  xBots: XBotService;
  cronSecret?: string;
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => void handler(request, response).catch(next);
}

export function createApp(dependencies: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_request, response) => response.json({ ok: true }));

  app.get("/", (_request, response) => {
    const snapshots = dependencies.store.listMarkets(50).map((market) => dependencies.store.getMarketSnapshot(market.id));
    response.type("html").send(marketIndexPage(snapshots));
  });

  app.post("/api/accounts", (request, response) => {
    const result = dependencies.markets.createAccount(historySchema.parse(request.body));
    response.status(result.created ? 201 : 200).json(result);
  });

  app.get("/api/accounts/:xUserId", (request, response) => {
    const account = dependencies.store.getAccount(request.params.xUserId);
    if (!account) throw new AppError("Account not found", 404, "NOT_FOUND");
    response.json({ account });
  });

  app.post("/api/markets", asyncRoute(async (request, response) => {
    const body = z.object({
      sourcePost: sourcePostSchema,
      creatorUserId: z.string().min(1).max(64),
      claim: claimSchema.optional(),
      liquidityB: z.number().finite().optional(),
    }).parse(request.body);
    const result = await dependencies.markets.createMarket(body);
    response.status(result.created ? 201 : 200).json({ ...result, snapshot: dependencies.store.getMarketSnapshot(result.market.id) });
  }));

  app.get("/api/markets", (request, response) => {
    const limitResult = z.coerce.number().int().min(1).max(100).safeParse(request.query.limit ?? 50);
    if (!limitResult.success) throw new AppError("limit must be between 1 and 100", 422, "INVALID_QUERY");
    response.json({ markets: dependencies.store.listMarkets(limitResult.data).map((market) => dependencies.store.getMarketSnapshot(market.id)) });
  });

  app.get("/api/markets/:marketId", (request, response) => {
    const userId = typeof request.query.userId === "string" ? request.query.userId : undefined;
    response.json(dependencies.store.getMarketSnapshot(request.params.marketId, userId));
  });

  app.get("/api/markets/:marketId/history", (request, response) => {
    const limit = z.coerce.number().int().min(2).max(500).catch(240).parse(request.query.limit ?? 240);
    response.json({ points: dependencies.store.getPriceHistory(request.params.marketId, limit) });
  });

  app.post("/api/markets/:marketId/trades", (request, response) => {
    const body = z.object({ userId: z.string().min(1).max(64), outcome: outcomeSchema, credits: z.number().finite().positive() }).parse(request.body);
    const trade = dependencies.markets.trade({ marketId: request.params.marketId, ...body });
    response.status(201).json({ trade, snapshot: dependencies.store.getMarketSnapshot(request.params.marketId, body.userId) });
  });

  app.post("/api/markets/:marketId/resolve", (request, response) => {
    const body = z.object({ outcome: outcomeSchema.nullable(), sources: z.array(z.string().url()).max(10) }).parse(request.body);
    const market = dependencies.markets.resolve({ marketId: request.params.marketId, outcome: body.outcome as Outcome | null, sources: body.sources });
    response.json({ market, snapshot: dependencies.store.getMarketSnapshot(market.id) });
  });

  app.get("/markets/:marketId", (request, response) => {
    const snapshot = dependencies.store.getMarketSnapshot(request.params.marketId, dependencies.store.getMarket(request.params.marketId)?.sourcePost.authorId);
    const account = dependencies.store.getAccount(snapshot.market.sourcePost.authorId);
    response.type("html").send(marketPage(snapshot, account?.availableBalance ?? null, dependencies.store.getPriceHistory(snapshot.market.id)));
  });

  app.get("/auth/x/start", (_request, response) => {
    response.redirect(dependencies.oauth.start());
  });

  app.get("/auth/x/callback", asyncRoute(async (request, response) => {
    const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(request.query);
    const result = await dependencies.oauth.complete(query.code, query.state);
    response.type("html").send(`<main><h1>Market bot connected</h1><p>@${result.username} can now receive market-this mentions while this service is running.</p></main>`);
  }));

  app.post("/internal/jobs/poll-x", asyncRoute(async (request, response) => {
    if (dependencies.cronSecret && request.get("authorization") !== `Bearer ${dependencies.cronSecret}`) {
      throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
    }
    response.json(await dependencies.xBots.poll());
  }));

  app.get("/events", (request, response) => {
    response.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    response.flushHeaders();
    response.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    const unsubscribe = dependencies.events.subscribe((event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 25_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      response.end();
    });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = error instanceof AppError
      ? error
      : error instanceof ZodError
        ? new AppError("Request validation failed", 422, "INVALID_REQUEST")
        : new AppError("Internal server error", 500, "INTERNAL_ERROR");
    if (appError.status >= 500) console.error(error);
    response.status(appError.status).json({ error: { code: appError.code, message: appError.message } });
  });

  return app;
}
