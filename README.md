# Threadline core

**Every argument has odds.** Threadline is the market engine, karma seeding,
and X mention bot for the Grokathon build.
Video is intentionally outside this service: consume `market.created`,
`market.trade.executed`, and `market.resolved` events from the SSE endpoint to
drive the live-debate renderer.

## Run it

```bash
npm install
cp .env.example .env
npm run dev
```

`GET /health` verifies the service. The app works without external credentials:
use the API with source-post details supplied in the request. Add `XAI_API_KEY`
to use structured Grok extraction and X credentials to enable the live bot.

## Core endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /` / `GET /markets/:marketId` | Local market index and interactive market page. |
| `GET /portfolio` | Linked X trader's open positions and mark-to-market wallet view. |
| `GET /api/portfolio` | JSON version of the linked trader portfolio. |
| `GET /api/markets/:marketId/history` | Price history used by the live YES-probability chart. |
| `POST /api/markets/:marketId/analysis` | Search X and cache a deeper Grok market pulse with source links and feed posts. |
| `POST /api/markets` | Validate/extract a claim and create a market. |
| `GET /api/markets/:marketId` | Market state, LMSR price, and the caller's position. |
| `POST /api/markets/:marketId/trades` | Spend non-transferable karma credits on YES or NO. |
| `POST /api/markets/:marketId/sells` | Sell held YES or NO shares back to the LMSR for current proceeds. |
| `POST /api/markets/:marketId/resolve` | Resolve YES/NO or mark unresolvable. |
| `GET /api/accounts/:xUserId` | Get/create a karma account from public-history inputs. |
| `GET /api/me` | Read the locally linked X trader wallet. |
| `GET /auth/x/start` | Authorize the market bot with OAuth 2.0 + PKCE. |
| `GET /auth/x/connect/start` | Link a trader's X account and seed their karma wallet. |
| `POST /internal/jobs/poll-x` | Poll bot mentions and reply to “market this”. |
| `GET /events` | SSE feed for the video/debate layer. |

The local market page uses a short-lived session after a trader links their X
account. Viewing markets is public, but buy and sell routes use that server-side
session and never accept a caller-supplied wallet ID. Each X user ID maps to one
local Threadline Karma account, so its balance and open positions persist across
all Threadline markets while the local SQLite database is retained. Removing the
local database resets the hackathon demo state.
`/internal/jobs/poll-x` requires `Authorization: Bearer $CRON_SECRET` when the
secret is configured.

## X setup

1. Rotate the client secret that was pasted into chat, then set the replacement
   in your deployment secret manager as `X_CLIENT_SECRET`.
2. In the X developer console, register the exact callback URL from
   `X_REDIRECT_URI`, and enable OAuth 2.0 authorization-code flow.
3. Visit `/auth/x/start` and authorize the market bot account with
   `tweet.read users.read tweet.write offline.access`.
4. Schedule `POST /internal/jobs/poll-x` every minute. The endpoint uses the
   mentions timeline, creates a market only for messages containing
   `market this`, and replies once with the market URL.

The OAuth callback saves bot tokens in the local, git-ignored SQLite database
for the hackathon. For a production deployment, replace this with encrypted
persistent refresh-token storage in a managed secret store.

## Market design

Trades use a binary LMSR automated market maker. Users choose a credit budget;
the engine solves for the number of outcome shares that budget buys. Holders can
also sell any portion of the shares they own at the current AMM price; proceeds
reflect market movement and slippage. It never allows negative balances or short
positions. On YES/NO resolution, each winning remaining share pays one credit.
An **unresolvable** market refunds a trader's remaining positive net spend and
does not alter calibration.

For the local hackathon view, the server also emits a small **clearly labeled
demo market pulse** every 12 seconds. These points are marked `DEMO` in the
history API, do not represent users or volume, and exist only to make a fresh
local market visibly live. The page surfaces liquidity depth and recent
average price movement as market metrics.

Grok turns a qualifying source post into a constrained binary question,
resolution rules, deadline, and short source synopsis in one structured
creation pass. When someone first opens the market, it additionally searches
recent and historical X discussion to generate a cached Market AI analysis:
observed signals, catalysts, counter-signals, what to watch, and a tweet-style
feed of search-verified posts. The feed has a manual Refresh control for a new
pulse. This X context is never a forecast, trading recommendation, or
resolution source.

Karma is a capped, public-history-derived seed, not a truth score. The default
score uses account age, total post count, and a median of up to 100 sampled
public post impressions. Missing impression samples receive a conservative
fallback factor rather than fabricated reach.

On a market page, **Link your X account** authorizes the trader with the
minimal `tweet.read users.read` scopes, derives that frozen seed, and displays
the underlying public-history inputs. The bot uses a separate OAuth flow with
posting permission.

## Event contract for video

Events look like:

```json
{"type":"market.trade.executed","marketId":"…","payload":{"outcome":"YES","priceYes":0.61}}
```

The video worker can react to price movement without participating in market
settlement. Its generated clips must remain presentation-symmetric; the engine
does not select visual treatments.
