# Threadline — Grokathon Demo Script

**Runtime: ~3:00.** Written for two presenters (P1, P2); collapse to one voice by merging lines.
**Screens needed:** ① the YouTube live stream, ② an X post thread, ③ threadline.up.railway.app.

---

## COLD OPEN — the stream, sound ON (0:00–0:20)

*(Start ON the live broadcast. Say nothing for four seconds. Let the judges hear the news bed, see Mara and Derek at the desk, the lime ticker crawling.)*

**P1:** Everything you're looking at is generated. The anchors. The debate. The floor reporter. The street interviews. The music. Nobody wrote this rundown — it's a television channel that produces itself, live, twenty-four hours a day.

**P2:** And it's covering something real: prediction markets our users are trading *right now*. This is Threadline.

---

## THE PROBLEM (0:20–0:45)

**P1:** Prediction markets have three chronic failures. Nobody creates markets, because writing a resolvable question is work. Resolution ends in flame wars. And every book gets gamed by burner accounts.

**P2:** We attacked all three — and every fix uses something only the xAI stack can do.

---

## LOOP DEMO — post to market (0:45–1:25)

*(Switch to X. A post making a falsifiable claim. Reply "market this" — or show the prepared reply from earlier.)*

**P1:** I reply "market this" to any post on X. Grok reads the claim, hardens it into a resolvable yes-or-no question with explicit criteria and a deadline — creation cost: one reply.

*(Switch to threadline.up.railway.app — the market page, live chart moving.)*

**P2:** Here's the market. Live odds, real order flow. But look at what you trade with — because this is the part nobody else has.

**P1:** Your balance is your **karma**: a function of your account's age, post history, and *median* impressions. My ten-year account seeds thousands of credits. A fresh burner seeds one hundred.

**P2:** Run the math: fifty burner accounts buy less pressure than *one* real person. The cost of manipulating this market is denominated in the one thing you can't purchase — accumulated public identity. Sybil resistance isn't a moderation policy here. It's arithmetic.

---

## THE CHANNEL (1:25–2:25)

*(Back to the stream. Time this loosely to whatever segment is airing — every segment demos itself.)*

**P1:** And because every market starts as a public argument, we gave the arguments a home. A full broadcast network, six recurring cast members, faces locked so they never drift.

**P2:** Mara and Derek anchor from a shared desk — that two-shot is one image, composed from their portraits with Grok's multi-image editing. Omar reports from the floor. Maya and Grant — the bull and the bear — fight it out in the two-box over whichever contract the book can't decide. April does the forecast: what settles when, delivered as weather.

**P1:** The copy is written by Grok against the live book — real prices, real traders, real deltas. The faces are Grok Imagine video with native lip-sync, and takes run twenty-five seconds using the brand-new video *extension* API. The voices are the Grok realtime voice API. The street interviews are one-shot text-to-video — a new stranger with a new opinion, every rotation.

**P2:** And two segments are pulling live data on air: "The Room" runs x_search and puts real posts on screen — receipts, not vibes. "Reality Check" runs web_search against the contract closest to resolution.

**P1:** Every viewer sees the same second of the same broadcast — one program clock — and the whole channel simulcasts to YouTube. If the book moves eight points, the show interrupts itself. Breaking news, caused by *you* trading.

---

## CLOSE (2:25–3:00)

*(Stream stays up. Point at it.)*

**P2:** Everything here is one stack: grok-4.3 writes the claim extraction, the resolution research, and every word of the show. Grok Imagine generates the cast, the b-roll, the two-shot, the video — and extends it. The realtime API speaks it. X search grounds it.

**P1:** Threadline. Reply "market this" to any post — your karma is already funded, the desk will cover your trade, and if you're wrong, Grant Ellison will explain why on television.

**P2:** It's live now — threadline dot up dot railway dot app, and the stream link is on our X. Come argue with the bear.

---

## JUDGE Q&A CRIB

- **"Is the money real?"** No — karma credits are non-transferable, non-purchasable, non-cashable. Zero regulatory surface. The scarcity is identity, not currency.
- **"How do markets resolve?"** Search-grounded resolution with sources shown, plus an honest UNRESOLVABLE state instead of a forced call. Settlement is authenticated (CRON_SECRET) — never a public endpoint.
- **"How much of the show is canned?"** None. Segments are written seconds before air against the live book; the wire segments show posts pulled at air time. Kill the seed data and the show reports an empty book.
- **"Video costs?"** The main dial is take length and NEWS_VIDEO=0 falls back to voice-over-graphics. Takes are budgeted per-word and silence-trimmed with ffmpeg, so we don't pay for dead air.
- **"Why is the debate fair?"** Both champions render from one prompt template (only identity tokens differ — verified mechanically), get equal beats and equal citation density. Presentation can't move the price.
- **"What's xAI-specific?"** grok-4.3 (Responses API + function calling), x_search + web_search tools, Grok Imagine image + **multi-image editing** (`images: [...]` on /images/edits) + video with native lip-sync + **/videos/extensions**, realtime voice (eve/sal/ara/leo/rex). The bot flow runs on the X API.

## PRE-DEMO CHECKLIST (15 min before)

1. Stream health: encoder running, YouTube live at `youtube.com/channel/UCw_kvCgcbFqmFgc1Uxy7UhQ/live` (arm Control Room FIRST, then start encoder).
2. `threadline.up.railway.app` loads; pick a market page with a lively chart to have open.
3. A prepared X post + "market this" reply (or do it live if the bot poll is running).
4. Viewer tab of `/live` with sound already unmuted, as backup if YouTube hiccups.
5. `NEWS_VIDEO=1` on Railway; check xAI credits.
