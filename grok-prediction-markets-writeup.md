# Threadline

**Turn any post into a prediction market. Your balance is your account history. Two synthetic champions argue it out, live.**

xAI Grokathon — August 8, 2026

---

## One-liner

Reply "market this" to any post on X. In two seconds there's a live prediction market on the claim — funded by your account's karma, not your wallet, and argued in real time by two recurring synthetic champions who cite the actual humans making each case.

---

## The thesis

Prediction markets have three chronic failures. This project attacks all three, and each fix uses something only this stack can do.

| Failure | Why it happens | Our answer |
|---|---|---|
| **Nobody creates markets** | Authoring an unambiguous resolvable question is real work | Claim extraction + question hardening from a single mention. Creation cost → zero. |
| **Resolution is a fight** | Reality is messier than the question anticipated | Search-grounded resolution with sources shown, plus an explicit *unresolvable* state instead of a guess |
| **Empty books / Sybil attacks** | New markets have no liquidity; fake accounts manufacture consensus | Karma seeding. Every arriving account is already funded, and fake accounts are structurally poor. |

The third one is the centerpiece.

---

## Karma as collateral

Your starting balance is a function of your public history on X — account age, post count, median impressions.

```
seed = 100 × (1 + log₁₀(1 + age_years))
           × (1 + log₁₀(1 + post_count))
           × (1 + log₁₀(1 + median_impressions))
```

Log-scaled, capped at roughly **50:1 max-to-min**, so it's a real spread without being an oligarchy. Use **median** impressions rather than total — total rewards volume, median rewards actually being read.

### Why this matters

A ten-year account with 40k posts seeds around **8,000 credits**. A fresh burner seeds at the floor, **~100**.

> Fifty burner accounts buy you 5,000 credits of buying pressure — less than one real long-tenured participant. **The cost of manipulating this market is denominated in something you cannot purchase: accumulated public identity.**

Three consequences worth stating explicitly:

- **Sybil resistance is structural**, not a moderation problem
- **No regulatory surface** — nothing purchasable, transferable, or cashable
- **No cold start** — liquidity exists on day zero because participants arrive pre-funded from history that predates the product

### The obvious objection, and the fix

*Karma measures reach and tenure, not being right. A loud 2015 account with terrible judgment gets a fat balance.*

Correct. So:

> **Karma is the seed, not the score.**

Balance from launch forward is P&L. High-karma accounts with bad calibration bleed out within a week and stop moving prices. Low-karma accounts that are consistently right compound into influence they could never have bought with tenure.

**The market converts reach into accuracy as its ongoing weighting function** — the correction X itself lacks.

---

## The live debate

Two recurring synthetic champions, visually identical across every market the system creates. Not deepfakes of real people — the *arguments* are real and attributed, the *messengers* are not.

Names and character treatment are deliberately owned by the livestream workstream. The market-flow bot is a single, separate X account.

### Why synthetic, not real faces

Generating a real identifiable person delivering a thesis is a deepfake even when the position is genuinely theirs — putting words in a named individual's mouth, in a betting product, automatically, at scale. One misattributed nuance and you've manufactured a quote that spreads as video.

It's also worse product design. A different face every market is incoherent; two consistent champions build recognition by the third market.

> **The platform synthesizes. It never ventriloquizes.**

### Where the content comes from

- Each thesis is assembled from the **strongest actual posts** on that side, ranked by argument quality — not engagement. Sorting by likes gets you the dunk, not the argument.
- **Real handles cited on screen** and linked as each point lands. Credit goes to the humans; no human is depicted.
- Getting cited as the strongest case for a side is a status object → shares from exactly the people whose participation improves the market.

### Latency architecture

Video generation is **not** real-time. Do not attempt a continuously generated debate stream. Split by latency budget:

| Layer | Timing | Notes |
|---|---|---|
| **Audio** | Real-time | Two custom voices, streaming speech. Carries the argument. |
| **Video** | Composited | Pre-generated character loops from locked reference images — idle, speaking, reacting |
| **Evidence cuts** | Pre-rendered at market creation | Clips or source posts, shown when a champion cites |

It's a *live debate* in the sense that matters: arguments generate in real time and respond to market state.

### What makes it not decoration

The stream reacts to the market:

- Price swings → the losing champion must address why
- New strong argument appears on X → incorporated within a cycle, attributed on screen
- The stream is a live rendering of the disagreement's current state, not a video attached to a card

---

## The symmetry constraint

**This is the intellectual core of the project.**

Vividness moves probability estimates. Availability bias is among the most robust findings in judgment research: make one outcome concrete and easy to picture, leave the other abstract, and people systematically overweight the vivid one.

> If YES is rendered warm and cinematic and NO is rendered flat, you have not illustrated the market. **You have moved its price.**

So both sides are generated from a single scaffold with only the position swapped:

- Same character template and visual grammar
- Same voice register and delivery energy
- Same runtime per turn
- Same citation density
- Same emotional register

When one side genuinely has weaker material, that shows as **fewer citations** — never as a less appealing messenger.

Optional, and strong: log the prompt pair for every market as a public artifact. Anyone can audit whether a market was framed fairly. **Generation transparency as market integrity.**

---

## System flow

**1. Trigger** — "Market this" on any post. Grok extracts the falsifiable claim and rewrites it as a resolvable question with explicit criteria.

**2. Hardening** *(stretch)* — Adversarial agents attack the question hunting for readings that break it. Every hostile interpretation found gets folded into resolution criteria before launch.

**3. Creation** — Market live in ~2s, card in a generating state. **Never gate creation on rendering.**

**4. Funding** — Handle → karma → seed balance. Running P&L thereafter.

**5. Trading** — LMSR or fixed-spread AMM. **Do not build an order book tonight.**

**6. Debate** — Champions assembled, streamed, attributed, symmetric.

**7. Resolution** — Search-grounded with sources shown. Explicit *unresolvable* state when evidence is contested. The losing champion concedes which specific claim failed — the most shareable artifact the system produces, and the seed of a calibration record.

---

## Build order

Roughly ten hours. Order matters more than scope.

### Now — 30 minutes, before anything else
- [ ] Generate and **lock** both champion reference images. Regenerating mid-build causes drift and collapses the consistency claim on stage.
- [ ] Pick the flagship market.

### By 2:00 PM — the spine *(submittable on its own)*
- [ ] Fake X client, seeded with real posts pulled via search
- [ ] Market this → claim extraction → resolvable question
- [ ] Karma seeding across ~10 real handles
- [ ] Betting works, price moves

### By 5:00 PM — the differentiator
- [ ] Champions render, both sides
- [ ] Audio debate plays
- [ ] Attribution visible on screen
- [ ] Flagship market pre-generated end to end

### By 7:00 PM — hard feature freeze
- [ ] Devpost skeleton submitted
- [ ] Resolution flow, even if manually triggered

### 7:00–9:00 PM — the demo, not the product
- [ ] Rehearse the run three times
- [ ] Record a full backup video
- [ ] Pre-generate everything the live demo touches

### 9:00–10:30 PM
Polish and submit. Nothing new.

### Cut order when you slip
Live generation (pre-render all) → resolution flow → question hardening → multi-market support

**Never cut:** karma seeding · symmetric champions · attribution

---

## The three-minute demo

1. **Judge picks a live argument on X.** Tag it. Market exists in two seconds.
2. **"Your balance isn't money — it's your account."** Show a judge's karma seed beside a burner's. Deliver the Sybil line.
3. **Cut to the flagship market**, debate running. Both champions, both cited, both symmetric.
4. **The bias beat.** Show a deliberately asymmetric pair — one champion warm and well-lit, the other flat. Let the room feel themselves lean. Then the symmetric version:

   > *"Presentation is a price-affecting surface. We had to design the debaters to be equally persuasive, or the video would set the price instead of reporting it."*

5. **Resolution.** Winning branch, losing champion concedes the specific failed claim, sources on screen.

Step 4 is what wins the room. It's the moment you're demonstrably not building AI decoration on a familiar product.

---

## Anticipated questions

**Isn't this gambling?**
Non-purchasable, non-transferable, no cash out. Balances derive from public account history.

**Doesn't karma reward loudness?**
Yes — which is why it's the seed, not the score. P&L is the ongoing weighting function.

**Rich get richer?**
Only if the rich are right. That's the mechanism working as designed.

**Why do you need video at all?**
Distribution — a market nobody sees has no traders, and video is what travels on X. And because presentation moves prices whether or not you design for it, so we designed for it.

**Is this just Polymarket with AI?**
Polymarket's real costs are question authorship and resolution. Both collapse here. And the market is a social object created by a gesture inside the argument, not a page you have to go visit.

---

## Judging criteria fit

**Usefulness** — Attacks the three failures that actually kill prediction markets. Sybil resistance without KYC is a real unsolved problem.

**Technical complexity** — Claim extraction from casual language · log-scaled karma from account history · AMM pricing · argument-quality ranking over engagement ranking · consistent-character generation via reference-to-video · real-time streaming voice · search-grounded resolution with contested-evidence handling.

**Most Users** — Every market is a public object with cited handles. Being named as the strongest argument for a side is a status object people share.

---

## Content guardrails

- No generation of real identifiable people. Markets about specific individuals are depicted symbolically — venue, object, consequence.
- Attribution always visible; arguments credited to real handles.
- Explicit unresolvable state rather than a confident wrong resolution.
- Symmetric generation enforced at the scaffold level, not by eye.
