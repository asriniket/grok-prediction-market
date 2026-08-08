# Karma Markets core

The market engine, karma seeding, and X mention bots for the Grokathon build.
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
| `POST /api/markets` | Validate/extract a claim and create a market. |
| `GET /api/markets/:marketId` | Market state, LMSR price, and the caller's position. |
| `POST /api/markets/:marketId/trades` | Spend non-transferable karma credits on YES or NO. |
| `POST /api/markets/:marketId/resolve` | Resolve YES/NO or mark unresolvable. |
| `GET /api/accounts/:xUserId` | Get/create a karma account from public-history inputs. |
| `GET /auth/x/start` | Authorize the market bot with OAuth 2.0 + PKCE. |
| `POST /internal/jobs/poll-x` | Poll bot mentions and reply to “market this”. |
| `GET /events` | SSE feed for the video/debate layer. |

Requests are authenticated only by the X user id in the initial hackathon API.
Put an application session in front of the public endpoints before deploying.
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

The OAuth callback holds bot tokens in the running process for the demo. For a
production deployment, configure the access/refresh tokens using a managed
secret store and implement encrypted persistent refresh-token storage.

## Market design

Trades use a binary LMSR automated market maker. Users choose a credit budget;
the engine solves for the number of outcome shares that budget buys. It never
allows negative balances or short positions. On YES/NO resolution, each winning
share pays one credit. An **unresolvable** market refunds every trader's exact
spend and does not alter calibration.

Karma is a capped, public-history-derived seed, not a truth score. The default
score uses account age, total post count, and a median of up to 100 sampled
public post impressions. Missing impression samples receive a conservative
fallback factor rather than fabricated reach.

## Event contract for video

Events look like:

```json
{"type":"market.trade.executed","marketId":"…","payload":{"outcome":"YES","priceYes":0.61}}
```

The video worker can react to price movement without participating in market
settlement. Its generated clips must remain presentation-symmetric; the engine
does not select visual treatments.
