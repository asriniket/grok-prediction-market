import type { MarketPricePoint, MarketSnapshot } from "../domain/types.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]!);
}

function credits(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}¢`;
}

const styles = `
  :root { color-scheme: dark; --ink: #f5f1e8; --muted: #a59f98; --line: #2c2a29; --panel: #171615; --ground: #0d0d0d; --lime: #d5ff52; --coral: #ff7967; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--ground); color: var(--ink); font: 16px/1.45 Inter, ui-sans-serif, system-ui, sans-serif; }
  a { color: inherit; } button, input { font: inherit; }
  .shell { max-width: 1120px; margin: 0 auto; padding: 28px 22px 64px; }
  .nav { display: flex; justify-content: space-between; gap: 16px; align-items: center; border-bottom: 1px solid var(--line); padding-bottom: 22px; }
  .brand { text-decoration: none; font-weight: 800; letter-spacing: -.06em; font-size: 24px; }.brand i { color: var(--lime); font-style: normal; }
  .tag { border: 1px solid var(--line); color: var(--muted); padding: 6px 10px; border-radius: 999px; font-size: 12px; }
  .eyebrow { color: var(--lime); font-weight: 700; letter-spacing: .1em; font-size: 12px; text-transform: uppercase; }
  .source { color: var(--muted); text-decoration: none; font-size: 14px; }.source:hover { color: var(--ink); }
  .market-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(300px, .65fr); gap: 20px; margin-top: 50px; }
  .hero, .panel, .market-card { background: var(--panel); border: 1px solid var(--line); border-radius: 18px; }
  .hero { padding: clamp(24px, 5vw, 52px); position: relative; overflow: hidden; }.hero:after { content: ""; width: 360px; height: 360px; border-radius: 100%; background: radial-gradient(circle, rgba(213,255,82,.14), transparent 68%); position: absolute; right: -120px; top: -170px; pointer-events: none; }
  h1 { position: relative; max-width: 760px; margin: 14px 0 22px; font-weight: 800; line-height: .98; letter-spacing: -.065em; font-size: clamp(40px, 6vw, 76px); }
  .criteria { position: relative; margin: 30px 0 0; padding: 20px; border-left: 2px solid var(--lime); background: #111110; color: var(--muted); }.criteria strong { display: block; color: var(--ink); margin-bottom: 8px; }
  .panel { padding: 24px; }.panel h2 { margin: 0; letter-spacing: -.04em; font-size: 21px; }
  .prices { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 20px 0; }.price { padding: 17px; border-radius: 13px; border: 1px solid var(--line); }.price.yes { background: rgba(213,255,82,.09); border-color: rgba(213,255,82,.35); }.price.no { background: rgba(255,121,103,.08); border-color: rgba(255,121,103,.25); }.price b { display: block; font-size: 33px; letter-spacing: -.06em; }.price span { color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: .09em; }
  .wallet { color: var(--muted); background: #111110; border: 1px solid var(--line); padding: 13px; border-radius: 11px; margin: 16px 0; font-size: 14px; }.wallet b { color: var(--ink); }
  .trade-form { display: grid; gap: 10px; }.outcomes { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }.outcome { border: 1px solid var(--line); color: var(--ink); background: #22201f; cursor: pointer; padding: 13px; border-radius: 10px; font-weight: 800; }.outcome.active.yes { background: var(--lime); color: #101108; border-color: var(--lime); }.outcome.active.no { background: var(--coral); color: #1d0d0b; border-color: var(--coral); }
  input { width: 100%; color: var(--ink); background: #111110; border: 1px solid var(--line); padding: 13px; border-radius: 10px; }.trade { border: 0; border-radius: 10px; cursor: pointer; background: var(--ink); color: #111; padding: 13px; font-weight: 800; }.trade:disabled { opacity: .55; cursor: wait; }.notice { min-height: 20px; color: var(--muted); font-size: 13px; margin: 2px 0 0; }.notice.error { color: var(--coral); }.notice.ok { color: var(--lime); }
  .chart-panel { grid-column: 1 / -1; padding: 24px; }.chart-head { display:flex; align-items:end; justify-content:space-between; gap:16px; margin-bottom: 16px; }.chart-head h2 { margin:0; letter-spacing:-.04em; font-size:22px; }.chart-head p { margin:0; color:var(--muted); font-size:13px; }.chart-wrap { height: 245px; position:relative; border-radius:13px; overflow:hidden; background:#111110; border:1px solid var(--line); }.chart-wrap:before { content:""; position:absolute; inset:0; pointer-events:none; opacity:.5; background:repeating-linear-gradient(to bottom, transparent 0, transparent 60px, var(--line) 61px); }.chart-wrap canvas { width:100%; height:100%; display:block; position:relative; }.chart-labels { display:flex; justify-content:space-between; color:var(--muted); font-size:11px; margin-top:9px; }.quick-spend { display:flex; gap:7px; }.quick-spend button { cursor:pointer; border:1px solid var(--line); border-radius:999px; background:#181716; color:var(--muted); font-size:12px; padding:5px 9px; }
  .facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin-top: 20px; background: var(--line); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }.fact { background: var(--panel); padding: 16px; }.fact span { display: block; color: var(--muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }.fact b { display: block; margin-top: 6px; font-size: 14px; }
  .list { margin-top: 42px; display: grid; gap: 14px; }.market-card { padding: 24px; text-decoration: none; display: block; transition: transform .16s ease, border-color .16s ease; }.market-card:hover { transform: translateY(-2px); border-color: #6a6a65; }.market-card h2 { margin: 8px 0 18px; letter-spacing: -.04em; line-height: 1.07; font-size: clamp(24px, 4vw, 40px); }.market-card .prices { margin: 0; max-width: 360px; }.empty { color: var(--muted); padding: 48px 0; }
  @media (max-width: 760px) { .market-grid { grid-template-columns: 1fr; margin-top: 28px; }.facts { grid-template-columns: 1fr; }.shell { padding-inline: 15px; }.nav { padding-bottom: 16px; } }
`;

function layout(content: string, title: string): string {
  return `<!doctype html>
  <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Threadline</title><style>${styles}</style></head>
  <body><main class="shell"><nav class="nav"><a href="/" class="brand">thread<i>line</i></a><span class="tag">play credits · no cash-out</span></nav>${content}</main></body></html>`;
}

export function marketIndexPage(markets: MarketSnapshot[]): string {
  const cards = markets.length === 0
    ? `<p class="empty">No markets yet. Mention the bot with <b>market this</b> to create the first one.</p>`
    : markets.map(({ market, priceYes, priceNo }) => `
      <a class="market-card" href="/markets/${market.id}">
        <span class="eyebrow">Open market · closes ${new Date(market.closesAt).toLocaleDateString()}</span>
        <h2>${escapeHtml(market.question)}</h2>
        <div class="prices"><div class="price yes"><span>YES</span><b>${percent(priceYes)}</b></div><div class="price no"><span>NO</span><b>${percent(priceNo)}</b></div></div>
      </a>`).join("");
  return layout(`<section class="list"><div><span class="eyebrow">Prediction markets from X conversations</span><h1 style="font-size:clamp(42px,7vw,84px);margin-bottom:8px">Every argument has odds.</h1><p style="color:var(--muted);max-width:620px">Threadline turns public arguments into live markets. Your account history seeds play credits; your trades move the odds.</p></div>${cards}</section>`, "Markets");
}

export function marketPage(snapshot: MarketSnapshot, walletBalance: number | null, history: MarketPricePoint[]): string {
  const { market } = snapshot;
  const author = `@${market.sourcePost.authorHandle}`;
  const balance = walletBalance === null ? "Wallet unavailable" : `${credits(walletBalance)} credits`;
  const criteria = market.resolutionCriteria.map((criterion) => escapeHtml(criterion)).join(" ");
  return layout(`
    <section class="market-grid" id="market" data-market-id="${market.id}" data-trader-id="${market.sourcePost.authorId}">
      <article class="hero">
        <span class="eyebrow">${market.status === "OPEN" ? "Open market" : escapeHtml(market.status)}</span>
        <h1>${escapeHtml(market.question)}</h1>
        <a class="source" href="${escapeHtml(market.sourcePost.url)}" target="_blank" rel="noreferrer">Source post by ${escapeHtml(author)} ↗</a>
        <div class="criteria"><strong>Resolution criteria</strong>${criteria}</div>
        <div class="facts"><div class="fact"><span>Closes</span><b>${new Date(market.closesAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</b></div><div class="fact"><span>Liquidity</span><b>${credits(market.liquidityB)} credits</b></div><div class="fact"><span>Source</span><b>${escapeHtml(author)}</b></div></div>
      </article>
      <aside class="panel">
        <h2>Take a position</h2>
        <div class="prices"><div class="price yes"><span>YES</span><b id="yes-price">${percent(snapshot.priceYes)}</b></div><div class="price no"><span>NO</span><b id="no-price">${percent(snapshot.priceNo)}</b></div></div>
        <div class="wallet">Demo wallet · ${escapeHtml(author)}<br><b id="wallet-balance">${balance}</b></div>
        <form class="trade-form" id="trade-form"><div class="outcomes"><button class="outcome yes active" type="button" data-outcome="YES">YES</button><button class="outcome no" type="button" data-outcome="NO">NO</button></div><label for="credits" style="color:var(--muted);font-size:13px">Play credits to spend</label><input id="credits" type="number" min="1" max="1000" value="25" required><div class="quick-spend"><button type="button" data-spend="10">10</button><button type="button" data-spend="25">25</button><button type="button" data-spend="100">100</button></div><button class="trade" type="submit">Buy YES</button><p class="notice" id="notice">Trades settle in play credits only.</p></form>
      </aside>
      <section class="panel chart-panel"><div class="chart-head"><div><span class="eyebrow">Live market signal</span><h2>YES probability</h2></div><p id="chart-value">${percent(snapshot.priceYes)} now</p></div><div class="chart-wrap"><canvas id="price-chart" aria-label="YES price history chart"></canvas></div><div class="chart-labels"><span>Market open</span><span>Live</span></div></section>
    </section>
    <script>
      (() => {
        const root = document.getElementById('market'); const id = root.dataset.marketId; const userId = root.dataset.traderId;
        let outcome = 'YES'; let points = ${JSON.stringify(history)}; const form = document.getElementById('trade-form'); const notice = document.getElementById('notice'); const chart = document.getElementById('price-chart');
        const money = value => new Intl.NumberFormat('en-US', {maximumFractionDigits: 0}).format(value) + ' credits';
        const drawChart = () => { const ctx = chart.getContext('2d'); const bounds = chart.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1; chart.width = Math.max(1, Math.round(bounds.width * ratio)); chart.height = Math.max(1, Math.round(bounds.height * ratio)); ctx.scale(ratio, ratio); const width = bounds.width; const height = bounds.height; ctx.clearRect(0, 0, width, height); const values = points.length ? points.map(point => point.priceYes) : [.5]; const padding = 18; const x = index => padding + (width - padding * 2) * (values.length === 1 ? 0 : index / (values.length - 1)); const y = value => padding + (1 - value) * (height - padding * 2); const area = ctx.createLinearGradient(0, 0, 0, height); area.addColorStop(0, 'rgba(213,255,82,.32)'); area.addColorStop(1, 'rgba(213,255,82,0)'); ctx.beginPath(); values.forEach((value, index) => index === 0 ? ctx.moveTo(x(index), y(value)) : ctx.lineTo(x(index), y(value))); ctx.lineTo(x(values.length - 1), height - padding); ctx.lineTo(x(0), height - padding); ctx.closePath(); ctx.fillStyle = area; ctx.fill(); ctx.beginPath(); values.forEach((value, index) => index === 0 ? ctx.moveTo(x(index), y(value)) : ctx.lineTo(x(index), y(value))); ctx.strokeStyle = '#d5ff52'; ctx.lineWidth = 2.5; ctx.stroke(); const last = values[values.length - 1]; ctx.beginPath(); ctx.arc(x(values.length - 1), y(last), 4, 0, Math.PI * 2); ctx.fillStyle = '#d5ff52'; ctx.fill(); document.getElementById('chart-value').textContent = Math.round(last * 100) + '¢ now'; };
        const refresh = async () => { const [response, account, history] = await Promise.all([fetch('/api/markets/' + id + '?userId=' + encodeURIComponent(userId)), fetch('/api/accounts/' + encodeURIComponent(userId)), fetch('/api/markets/' + id + '/history')]); if (!response.ok) return; const data = await response.json(); document.getElementById('yes-price').textContent = Math.round(data.priceYes * 100) + '¢'; document.getElementById('no-price').textContent = Math.round(data.priceNo * 100) + '¢'; if (account.ok) { const value = await account.json(); document.getElementById('wallet-balance').textContent = money(value.account.availableBalance); } if (history.ok) { points = (await history.json()).points; drawChart(); } };
        document.querySelectorAll('[data-outcome]').forEach(button => button.addEventListener('click', () => { outcome = button.dataset.outcome; document.querySelectorAll('[data-outcome]').forEach(candidate => candidate.classList.toggle('active', candidate === button)); form.querySelector('.trade').textContent = 'Buy ' + outcome; }));
        document.querySelectorAll('[data-spend]').forEach(button => button.addEventListener('click', () => { document.getElementById('credits').value = button.dataset.spend; }));
        form.addEventListener('submit', async event => { event.preventDefault(); const button = form.querySelector('.trade'); const credits = Number(document.getElementById('credits').value); button.disabled = true; notice.className = 'notice'; notice.textContent = 'Placing trade…'; try { const response = await fetch('/api/markets/' + id + '/trades', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({userId, outcome, credits}) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error?.message || 'Trade failed'); notice.className = 'notice ok'; notice.textContent = 'Bought ' + payload.trade.shares.toFixed(1) + ' ' + outcome + ' shares.'; await refresh(); } catch (error) { notice.className = 'notice error'; notice.textContent = error.message; } finally { button.disabled = false; } });
        const events = new EventSource('/events'); events.addEventListener('market.trade.executed', event => { const data = JSON.parse(event.data); if (data.marketId === id) refresh(); }); events.addEventListener('market.resolved', event => { const data = JSON.parse(event.data); if (data.marketId === id) refresh(); });
        window.addEventListener('resize', drawChart); drawChart();
      })();
    </script>`, market.question);
}
