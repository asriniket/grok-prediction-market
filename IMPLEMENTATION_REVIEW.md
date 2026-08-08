# Plan review and implementation decisions

This review treats the pitch document as a product hypothesis, not an API or
economic specification.

## Claims corrected before implementation

### Karma needs a mechanical cap

The original formula is unbounded. A ten-year / 40,000-post account contributes
only `100 × 2.041 × 5.602 = 1,143.6` credits before reach; reaching 8,000 needs
roughly a one-million-post median impression count. Neither the stated 8,000
example nor the stated 50:1 maximum follows from the formula alone.

The service uses that same logarithmic intuition but clamps the result to
**100–5,000 credits**, making the 50:1 claim true. Account age and post count
come from X's user object. Median impressions are calculated from up to 100
sampled public posts. A missing or unavailable sample gets no reach uplift.

This makes Sybil attacks more expensive, but does not make them impossible:
aged accounts can be bought, compromised, or coordinated. It is an influence
heuristic, not identity proof or fraud prevention.

### X access needs bot identity, not only an OAuth client

The supplied OAuth Client ID/Secret identifies this application. It cannot by
itself read a bot's mentions or post a reply. The one market-bot account needs
a user-context OAuth token with `tweet.read users.read tweet.write`; add
`offline.access` when a refresh token is required. The service implements
authorization-code + PKCE and accepts a provisioned bot token for a demo.

The X API exposes post-level public impression counts, while account creation
date and post count come from user fields. There is no account-level median
impression field, so any median must be sampled and calculated by the app.

### “Two seconds” is a target, not a guarantee

API lookups, model inference, and X posting are variable-latency services. The
bot creates no video synchronously and the core service emits events the moment
a market is created. The UI should show a generating debate card after that.
Do not promise a fixed end-to-end latency in the demo; describe it as an
optimistic path when upstream calls are warm.

### Resolution and compliance need narrower language

The engine requires a source URL for YES/NO resolution and has an unresolvable
outcome that refunds the exact trade spend. This is safer than a model deciding
truth. It does not make resolution automatically correct: disputed sources need
a human review queue before a public launch.

Non-transferable, non-cashable credits reduce financial-product risk, but do
not establish that there is “no regulatory surface.” That is jurisdiction- and
launch-specific legal advice, not an engineering conclusion.

## Implemented core

- Binary LMSR AMM with credit-budget buys, stable price math, no shorting, and
  no negative user balance. `b=200` carries a maximum platform subsidy of
  `b × ln(2)` credits per binary market.
- SQLite transactions for accounts, markets, positions, trades, settlement
  ledger, and X mention idempotency.
- Frozen public-history karma seed, then trading P&L only.
- Explicit YES / NO settlement and exact-spend refund for unresolvable markets.
- Grok structured-output claim extraction. It rejects vague questions and
  invented deadlines rather than fabricating resolution rules.
- Market-bot OAuth onboarding, mention polling, idempotent `market this`
  handling, X reply posting, and an SSE stream for the video worker.

## Deliberately deferred

- Encryption and refresh rotation for bot OAuth tokens. The hackathon build
  persists tokens in its git-ignored local SQLite database; deploy only with
  encrypted, secret-managed storage.
- User-session authentication and market-resolution authorization. The public
  hackathon endpoints are intentionally simple and are not production auth.
- Human resolution review, anti-abuse/rate limits, a queue, and a UI.
- Video/audio generation; subscribe to `GET /events` instead.

## Source documents

- [X OAuth 2.0 Authorization Code Flow with PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)
- [X API metrics](https://docs.x.com/x-api/fundamentals/metrics)
- [X API access and authentication](https://docs.x.com/x-api/getting-started/getting-access)
- [xAI Structured Outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)
