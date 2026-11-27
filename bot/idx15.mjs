// SPY / QQQ — 15 DAKİKADA BİR GÜN İÇİ OPSİYON FİKRİ (yalnız ALIM: call ya da put alımı; opsiyon satışı/açığa satış YOK).
// Seans içinde 09:45–15:45 NY arası her çeyrek saatte (TR kışın 17:45–23:45) tek mesaj: iki ETF için yön + kontrat + hedef/stop.
// Yön skoru (5 dk mumlar): VWAP üstü/altı · EMA9/EMA21 · açılış aralığı (ilk 30 dk) kırılımı · son 15 dk ivmesi ·
//   günlük trend (20 günlük ort.) · VIX gün içi değişimi · aşırı RSI(5 dk) cezası. |skor| ≥ 3 → CALL/PUT, değilse NÖTR (işlem yok).
// Seviyeler: risk R = max(1.5 × ATR(5 dk), fiyatın %0.15'i) · stop = giriş ∓ R · hedef = giriş ± 2R (risk/ödül 1:2) · zaman stopu.
// Olasılık DÜRÜST verilir: kaymasız fiyatta hedefin stoptan önce gelme olasılığı R/(R+2R) = %33; vadede kâr olasılığı log-normal.
// ⚠ Geriye dönük test edilmedi (ücretsiz geçmiş gün içi opsiyon verisi yok) → yalnız fikirdir.
import { pathToFileURL } from "node:url";
import { nyParts, isMarketOpen, isRegularHours, fmtTR, nyTs, closeTsOf } from "../data/market.mjs";
import { intradayBars, liveQuotes, alpacaEnabled } from "../data/alpaca.mjs";
import { fetchChart, fetchDaily, quoteNow, optionChain, riskFreeRate } from "../data/yahoo.mjs";
import { bs, impliedVol } from "../options/bs.mjs";
import { paritySpot } from "../options/chain.mjs";
import { popLong } from "./morning.mjs";
import { sendTG } from "./telegram.mjs";
import { loadFiles, saveFiles, READ_FAILED } from "./state.mjs";
import { IDEA_FILES, HORIZON, addIdea, settleIdeas, ideaStats, fmtIdeaStats } from "./ideabook.mjs";
import { macroEvents, fmtMacroDay, nearEvent, fmtNear } from "./macro.mjs";
import { freshPrice, ageTxt, FRESH_MS } from "./liveaudit.mjs";
import { paperBuy, warnPaperFail } from "./optpaper.mjs";
import { TUNE_FILE, tunedValue } from "./tune.mjs";
import { pushOpenLocal, ideaId } from "./exits.mjs";
import { tradePlan, fmtPlan, fmtPlanLine } from "./plans.mjs";
import { gexFor, fmtGex } from "./gex.mjs";
import { readInternals, fmtInternals } from "./setuplive.mjs";
import { PREFS_FILE, isOn, sizeLine } from "./prefs.mjs";
import { loadUniverse } from "../spot/scan.mjs";

export const IDX = { SYMS: ["SPY", "QQQ"], START: 585, END: 950, ODTE_UNTIL: 870, MIN_SCORE: 3, R_ATR: 1.5, R_MIN: 0.0015, RR: 2, SLIP: 0.3, MAX_SPREAD: 0.15 };
const YR = 365 * 864e5;

export { nyTs };                                                   // (data/market.mjs'e taşındı; eski içe aktarımlar için)
// Zaman stopu (dk): taban süre, ama kapanışa en geç 5 dk kala biter (erken kapanış günleri dahil)
export const capStop = (base, closeMs, now = Date.now()) => Math.max(5, Math.min(base, Math.floor((closeMs - now) / 60e3) - 5));

const ema = (xs, n) => { const k = 2 / (n + 1); let e = xs[0]; for (let i = 1; i < xs.length; i++) e = xs[i] * k + e * (1 - k); return e; };
function rsi(xs, n = 14) {
  if (xs.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = xs[i] - xs[i - 1]; d > 0 ? (g += d) : (l -= d); }
  g /= n; l /= n;
  for (let i = n + 1; i < xs.length; i++) { const d = xs[i] - xs[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

// Saf hesap (test edilebilir). bars: bugünün seans 5 dk mumları (eskiden yeniye). S: anlık fiyat.
// daily: { prevClose, sma20 } · vix: { now, prev } | null
export function idxSignal(bars, S, daily, vix) {
  if (!bars?.length || !(S > 0)) return null;
  const C = bars.map(b => b.close), why = [];
  let pv = 0, v = 0;
  for (const b of bars) { const w = b.volume || 1; pv += (b.high + b.low + b.close) / 3 * w; v += w; }
  const vwap = pv / v;
  const trs = bars.map((b, i) => Math.max(b.high - b.low, i ? Math.abs(b.high - bars[i - 1].close) : 0, i ? Math.abs(b.low - bars[i - 1].close) : 0));
  const atr = trs.slice(-12).reduce((a, x) => a + x, 0) / Math.min(12, trs.length);
  const or = bars.length >= 6 ? bars.slice(0, 6) : null;
  const orh = or ? Math.max(...or.map(b => b.high)) : null, orl = or ? Math.min(...or.map(b => b.low)) : null;
  const r14 = rsi(C), e9 = ema(C, 9), e21 = ema(C, 21);
  let s = 0;
  if (S > vwap * 1.0005) { s += 1; why.push("VWAP üstü"); } else if (S < vwap * 0.9995) { s -= 1; why.push("VWAP altı"); }
  if (C.length >= 9) { if (e9 > e21) { s += 1; why.push("EMA9 > EMA21"); } else if (e9 < e21) { s -= 1; why.push("EMA9 < EMA21"); } }
  if (or) { if (S > orh) { s += 1; why.push("açılış aralığı yukarı kırıldı"); } else if (S < orl) { s -= 1; why.push("açılış aralığı aşağı kırıldı"); } }
  if (C.length >= 4) {
    const d = S - C[C.length - 4];
    if (d > 0.5 * atr) { s += 1; why.push("son 15 dk yükseliş ivmesi"); } else if (d < -0.5 * atr) { s -= 1; why.push("son 15 dk düşüş ivmesi"); }
  }
  if (daily?.prevClose && daily?.sma20) {
    if (daily.prevClose > daily.sma20) { s += 0.5; why.push("günlük trend yukarı"); } else { s -= 0.5; why.push("günlük trend aşağı"); }
  }
  if (vix?.now && vix?.prev) {
    // k: VIX eşdeğeri çarpanı (Yahoo ^VIX = 1; canlı vekil VIXY ≈ VIX'in yarısı kadar oynar → 2)
    const ch = (vix.now / vix.prev - 1) * (vix.k || 1);
    if (ch > 0.05) { s -= 1; why.push(`VIX ≈ +%${(ch * 100).toFixed(0)} (korku artıyor)`); } else if (ch < -0.05) { s += 0.5; why.push(`VIX ≈ −%${(-ch * 100).toFixed(0)}`); }
  }
  if (r14 != null && s >= IDX.MIN_SCORE && r14 > 75) { s -= 1; why.push(`RSI(5dk) ${r14.toFixed(0)} aşırı alım — kovalamayın`); }
  if (r14 != null && s <= -IDX.MIN_SCORE && r14 < 25) { s += 1; why.push(`RSI(5dk) ${r14.toFixed(0)} aşırı satım — kovalamayın`); }
  const dir = s >= IDX.MIN_SCORE ? "C" : s <= -IDX.MIN_SCORE ? "P" : null;
  const R = Math.max(IDX.R_ATR * atr, IDX.R_MIN * S), sg = dir === "P" ? -1 : 1;
  return {
    dir, score: s, why, S, vwap, orh, orl, atr, rsi: r14, R,
    stop: dir ? +(S - sg * R).toFixed(2) : null, target: dir ? +(S + sg * IDX.RR * R).toFixed(2) : null,
    dayChg: daily?.prevClose ? S / daily.prevClose - 1 : null,
  };
}

// Kontrat seçimi: vade zinciri + kesin kalan süre (16:00 NY) ile kendi IV/delta hesabımız. Dönüş: kontrat | null
export function pickIdxContract(legs, type, S, T, r, q, delta) {
  const c = legs.filter(o => o.bid > 0 && o.ask >= o.bid && Math.abs(o.strike / S - 1) < 0.03).map(o => {
    const mid = (o.bid + o.ask) / 2, iv = impliedVol(type, mid, S, o.strike, T, r, q);
    const g = iv ? bs(type, S, o.strike, T, r, q, iv) : null;
    return { K: o.strike, bid: o.bid, ask: o.ask, mid, iv, delta: g?.delta ?? null, spread: (o.ask - o.bid) / mid, sym: o.sym };
  }).filter(o => o.iv && o.delta != null && o.spread <= IDX.MAX_SPREAD)
    .sort((a, b) => Math.abs(Math.abs(a.delta) - delta) - Math.abs(Math.abs(b.delta) - delta))[0];
  return c || null;
}

const trD = d => (d ? d.slice(8, 10) + "." + d.slice(5, 7) : "—");
const f2 = x => (x == null || !isFinite(x) ? "—" : x.toFixed(2));
const pct = x => (x == null ? "—" : (x >= 0 ? "+" : "−") + "%" + Math.abs(x * 100).toFixed(Math.abs(x) < 0.1 ? 2 : 0));

async function oneSymbol(sym, ctx) {
  const { today, sessStart, mins, r, vix, live, intra } = ctx;
  let bars = (intra[sym] || []).filter(b => b.ts >= sessStart);
  if (bars.length < 3) bars = (await fetchChart(sym, "5m", "1d").catch(() => [])).filter(b => b.ts >= sessStart);
  const drows = (await fetchDaily(sym).catch(() => [])).filter(b => b.ts < sessStart - 3600e3);
  const closes = drows.map(b => b.close);
  const daily = closes.length >= 20 ? { prevClose: closes.at(-1), sma20: closes.slice(-20).reduce((a, x) => a + x, 0) / 20 } : { prevClose: closes.at(-1) ?? null, sma20: null };
  // Fiyat: Alpaca IEX canlı son işlem (≤ 5 dk) → yoksa son 5 dk mumun kapanışı. Yaşı mesaja yazılır.
  const now = Date.now(), lp = freshPrice(live[sym], now), lastBar = bars.at(-1);
  const S = lp ?? lastBar?.close;
  const ageMs = lp ? now - live[sym].ts : lastBar ? now - lastBar.ts - 5 * 60e3 : null;
  const dataLine = `   Veri: ${lp ? "Alpaca IEX canlı" : alpacaEnabled() ? "son 5 dk mum (canlı fiyat yok)" : "Yahoo (Nasdaq gerçek zamanlı)"} · fiyat ${ageTxt(ageMs)} önce${ageMs > FRESH_MS ? " · ⚠ BAYAT VERİ — fikre güvenme" : ""}`;
  const sig = idxSignal(bars, S, daily, vix);
  if (!sig) return { sym, text: null };
  const head = `${sym} $${f2(S)} · gün ${pct(sig.dayChg)} · VWAP ${f2(sig.vwap)}${sig.rsi != null ? ` · RSI(5dk) ${sig.rsi.toFixed(0)}` : ""}`;
  // Bayat veriyle işlem fikri VERİLMEZ (karneye de girmez)
  if (sig.dir && isRegularHours() && ageMs > FRESH_MS)
    { console.log(`[15dk] ${sym}: ${sig.dir} çıktı ama fiyat ${ageTxt(ageMs)} eski → fikir verilmedi`); return { sym, sig: { ...sig, dir: null }, text: null }; }
  if (!sig.dir) { console.log(`[15dk] ${sym}: nötr (skor ${sig.score}) · ${sig.why.join(" · ")}`); return { sym, sig, text: null }; }

  // Vade: 14:30 NY'ye kadar 0DTE, sonrası sonraki vade (son saatlerde 0DTE zaman kaybı çok sert)
  // 0DTE yalnız kapanışa > 90 dk varken (erken kapanış günü 13:00 NY dahil); zaman stopu kapanışa göre kısalır
  const toClose = (ctx.closeToday - now) / 60e3;
  const c = await contractIdea({ sym, dir: sig.dir, S, stop: sig.stop, target: sig.target, r, today, allow0: toClose > 90,
    timeStopFn: exp0 => capStop(exp0 ? 45 : 90, ctx.closeToday, now) });
  console.log(`[15dk] ${sym} ${sig.dir} skor ${sig.score} · ${sig.why.join(" · ")} · ${dataLine.trim()}`);
  const L = [`${sig.dir === "C" ? "🟢" : "🔴"} ${sym} ${sig.dir === "C" ? "CALL" : "PUT"} AL — ${c.contract}`, ...c.lines];
  return { sym, sig, pick: c.pick, expD: c.expD, expClose: c.expClose, tstop: c.timeStop, text: L.join("\n") };
}

// ORTAK KONTRAT FİKRİ (15 dk fikri + ani hareket alarmı): yön + dayanak seviyeleri → likit kontrat, prim, opsiyonun stop/hedef
// karşılığı, olasılıklar. allow0: bugün vadeli (0DTE) kullanılabilir mi. Dönüş: { pick, expD, lines }
export async function contractIdea({ sym, dir, S, stop, target, r = 0.04, today, allow0 = false, timeStop = null, timeStopFn = null }) {
  const first = await optionChain(sym).catch(() => null);
  const exps = (first?.expirations || []).map(e => ({ e, d: new Date(e * 1e3).toISOString().slice(0, 10) }));
  const ex = allow0 ? exps.find(x => x.d === today) ?? exps.find(x => x.d > today) : exps.find(x => x.d > today);
  let pick = null, expClose = null;
  if (ex) {
    const ch = ex.e === first.exp ? first : await optionChain(sym, ex.e).catch(() => null);
    expClose = await closeTsOf(ex.d);                                  // GERÇEK vade kapanışı (erken kapanış günü 13:00)
    const T = Math.max(60e3, expClose - Date.now()) / YR;
    const q = Math.min(0.05, first?.quote?.divYield || 0);
    // Opsiyon kotasyonları dayanaktan birkaç dk gecikmeli olabilir → IV/delta, zincirin kendi ima ettiği fiyatla (parite) hesaplanır;
    // stop/hedef aynı mesafeyle o fiyata taşınır (aksi halde 0DTE'de IV ve olasılıklar ciddi bozulur).
    const So = ch ? paritySpot([{ T, calls: ch.calls, puts: ch.puts }], S, r, q) ?? S : S;
    pick = ch ? pickIdxContract(dir === "C" ? ch.calls : ch.puts, dir, So, T, r, q, ex.d === today ? 0.45 : 0.5) : null;
    if (pick) {
      // CANLI FİYATA GÖRE PRİM: IV zincirin kendi anından (So) çıkarıldı; prim CANLI dayanak fiyatıyla (S) yeniden fiyatlanır
      // (+ spread payı). Zincir canlıdan geride kaldıysa eski prim gösterilmez.
      pick.gap = So / S - 1;
      pick.chainPrem = +(pick.mid + IDX.SLIP * (pick.ask - pick.bid)).toFixed(2);
      pick.prem = Math.abs(pick.gap) > 0.0005 ? +(bs(dir, S, pick.K, T, r, q, pick.iv).price + IDX.SLIP * (pick.ask - pick.bid)).toFixed(2) : pick.chainPrem;
      const T2 = Math.max(5 * 60e3, T * YR - 30 * 60e3) / YR;           // seviyeye ~30 dk'da varıldığı varsayımı
      pick.atStop = bs(dir, stop, pick.K, T2, r, q, pick.iv).price;
      pick.atTgt = bs(dir, target, pick.K, T2, r, q, pick.iv).price;
      pick.pop = popLong(dir, S, pick.K, pick.prem, T, pick.iv);
    }
  }
  const expD = ex?.d;
  if (timeStopFn) timeStop = timeStopFn(expD === today);
  // SADE MESAJ: kontrat (başlıkta) · giriş / hedef / stop / süre · opsiyonun hedefte ve stopta tahmini değeri
  const ts = timeStop ?? (expD === today ? 45 : 90);
  const contract = pick ? `${expD === today ? "0DTE" : trD(expD)} ${pick.K}${dir} ~$${f2(pick.prem)}` : "kontrat yok (dayanakla izle)";
  const size = pick ? sizeLine(SIZING, pick.prem, pick.atStop) : null;
  const L = [`   Giriş ${sym} ~${f2(S)} · Hedef ${f2(target)} · Stop ${f2(stop)} · süre ${ts} dk`];
  if (pick) L.push(`   Opsiyon hedefte ~$${f2(pick.atTgt)} · stopta ~$${f2(pick.atStop)}${Math.abs(pick.gap) > 0.003 ? " · ⚠ kotasyon bayat olabilir" : ""}`);
  if (size) L.push("   " + size);
  return { pick, expD, expClose, timeStop: ts, contract, size, lines: L };
}

// extra: { ev: makro olaylar, pre: başa eklenecek satırlar (ör. dünkü karne) }
export async function buildIdx15(now = new Date(), extra = {}) {
  const { date: today, mins } = nyParts(now);
  const sessStart = nyTs(today, 9, 30);
  const [r, vq, live, intra] = await Promise.all([
    riskFreeRate().catch(() => 0.04),
    quoteNow("^VIX").catch(() => null),
    alpacaEnabled() ? liveQuotes([...IDX.SYMS, "VIXY"]).catch(() => ({})) : {},
    alpacaEnabled() ? intradayBars(IDX.SYMS, new Date(sessStart).toISOString()).then(x => x || {}).catch(() => ({})) : {},
  ]);
  // Gün içi VIX: Yahoo ^VIX 15 dk GECİKMELİ → Alpaca'da canlı VIXY varsa skor onunla (VIX eşdeğerine çevrilerek)
  const vy = live.VIXY, vyFresh = freshPrice(vy, now.getTime()) && vy.prev > 0;
  const vix = vyFresh ? { now: vy.price, prev: vy.prev, k: 2, src: "canlı VIXY" } : vq ? { now: vq.price, prev: vq.prevClose, k: 1, src: "^VIX 15 dk gecikmeli" } : null;
  const ctx = { today, sessStart, mins, r, vix, live, intra, closeToday: await closeTsOf(today) };
  const parts = [];
  for (const sym of IDX.SYMS) parts.push(await oneSymbol(sym, ctx).catch(e => ({ sym, text: `${sym}: hata (${e?.message || e})` })));
  const hh = String(Math.floor(mins / 60)).padStart(2, "0"), mm = String(mins % 60).padStart(2, "0");
  // Yalnız işlem fikri varsa mesaj (nötr/bayat → mesaj yok)
  const ideas = parts.filter(p => p.text);
  const near = fmtNear(nearEvent(extra.ev, now.getTime()), now.getTime());
  const text = ideas.length ? [`⏱ ${hh}:${mm} NY (${fmtTR(now).split(" ")[1]?.slice(0, 5) || ""} TR)`, ...(near ? [near] : []), ...ideas.map(p => p.text)].join("\n") : null;
  return { text, parts };
}

// ---------- 15 DK (SPY/QQQ/GLD/SLV) + SAATLİK (en yüksek hacimli 25 hisse) İŞLEM PLANLARI ----------
// Kontrat sayısı için hesap bilgisi (/hesap) — süreç başında ayarlanır
let SIZING = null;
export const setSizing = p => { SIZING = p?.acct ? p : null; };
export const PLAN = { SYMS15: ["SPY", "QQQ", "GLD", "SLV"], TOP_N: 25 };
let _top = null;
export function topLiquid(n = PLAN.TOP_N) {                         // evrendeki en yüksek dolar hacimli hisseler
  if (_top) return _top;
  const U = loadUniverse();
  return (_top = Object.entries(U.meta || {}).filter(([, m]) => m?.dv > 0).sort((x, y) => y[1].dv - x[1].dv).slice(0, n).map(([sym]) => sym));
}
// Seansın tamamlanmış 5 dk mumları + taze canlı fiyat
async function sessionBars(syms, sessStart, now) {
  let bars = {}, live = {};
  if (alpacaEnabled()) {
    [bars, live] = await Promise.all([intradayBars(syms, new Date(sessStart).toISOString(), "5Min").then(x => x || {}).catch(() => ({})), liveQuotes(syms).catch(() => ({}))]);
  }
  for (const s of syms) if (!(bars[s]?.length > 2)) bars[s] = await fetchChart(s, "5m", "1d").catch(() => []);
  const out = {};
  for (const s of syms) out[s] = { bars: (bars[s] || []).filter(b => b.ts >= sessStart && b.ts + 300e3 <= now), S: freshPrice(live[s], now, 120e3) };
  return out;
}

export async function buildPlans(now = new Date(), extra = {}) {
  const t = now.getTime(), { date: today, mins } = nyParts(now), sessStart = nyTs(today, 9, 30);
  const closeToday = await closeTsOf(today), toClose = (closeToday - t) / 60e3, r = await riskFreeRate().catch(() => 0.04);
  const data = await sessionBars(PLAN.SYMS15, sessStart, t);
  const blocks = [];
  for (const sym of PLAN.SYMS15) {
    const p = tradePlan(data[sym].bars, data[sym].S);
    if (!p) { blocks.push(`${sym}: veri yok`); continue; }
    let contract = null;
    if (p.trend !== "→") {
      const side = p.trend === "↑" ? p.call : p.put;
      const c = await contractIdea({ sym, dir: p.trend === "↑" ? "C" : "P", S: side.entry, stop: side.stop, target: side.target, r, today, allow0: toClose > 90 }).catch(() => null);
      if (c?.pick) contract = c.contract + (c.size ? ` · ${c.size.replace("Boyut: ", "")}` : "");
    }
    const gx = (sym === "SPY" || sym === "QQQ") ? fmtGex(await gexFor(sym, p.S, t).catch(() => null)) : null;
    blocks.push(fmtPlan(sym, p, contract) + (gx ? "\n" + gx : ""));
  }
  const near = fmtNear(nearEvent(extra.ev, t), t), inn = fmtInternals(readInternals(t));
  const hm = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  return [`⏱ ${hm} NY (${fmtTR(now).split(" ")[1]?.slice(0, 5) || ""} TR)`, ...(inn ? [inn] : []), ...(near ? [near] : []), ...blocks].join("\n");
}

export async function buildHourly(now = new Date()) {
  // En hacimli 40'tan hareket eden (plan riski fiyatın ≥ %0.1'i) ilk 25 — satın alma bekleyen/kıpırdamayan hisseler elenir
  const t = now.getTime(), { date: today, mins } = nyParts(now), syms = topLiquid(PLAN.TOP_N + 15);
  const data = await sessionBars(syms, nyTs(today, 9, 30), t);
  const lines = syms.map(s => ({ s, p: tradePlan(data[s].bars, data[s].S) }))
    .filter(x => x.p && (x.p.call.entry - x.p.call.stop) / x.p.S >= 0.001).slice(0, PLAN.TOP_N).map(x => fmtPlanLine(x.s, x.p));
  const hm = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  return lines.length ? [`🕐 ${hm} NY · En hacimli ${lines.length} hisse (↑/↓ eğilim · h hedef · s stop)`, ...lines].join("\n") : null;
}

// Çıkış kodu: 0 = gönderildi · 3 = seans dışı · 1 = gönderilemedi
async function main() {
  const { mins, wd } = nyParts();
  if (process.env.FORCE !== "1") {
    if (wd === "Sat" || wd === "Sun" || mins < IDX.START || mins >= IDX.END) { console.log("[15dk] seans penceresi dışında."); return 3; }
    if (!(await isMarketOpen())) { console.log("[15dk] piyasa kapalı (tatil)."); return 3; }
    if ((await closeTsOf(nyParts().date)) - Date.now() < 10 * 60e3) { console.log("[15dk] kapanışa < 10 dk."); return 3; }
  }
  const pf = await loadFiles([PREFS_FILE]).catch(() => READ_FAILED), prefs = pf === READ_FAILED ? null : pf[PREFS_FILE];
  setSizing(prefs);                                                            // /hesap → kontrat sayısı
  const ev = await macroEvents().catch(() => []);
  let ok = true;
  if (isOn(prefs, "plan15")) { ok = await sendTG(await buildPlans(new Date(), { ev })); console.log(`[15dk] plan ${ok ? "gönderildi" : "GÖNDERİLEMEDİ"}.`); }
  // Saatlik (10:30, 11:30 … 15:30 NY): en hacimli 25 hisse
  if (isOn(prefs, "saatlik") && (process.env.FORCE === "1" || (mins % 60 >= 30 && mins % 60 < 45 && mins >= 630))) {
    const h = await buildHourly(new Date()).catch(e => (console.error("[saatlik]", e?.message || e), null));
    if (h) console.log(`[saatlik] ${(await sendTG(h)) ? "gönderildi" : "GÖNDERİLEMEDİ"}.`);
  }
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then(c => process.exit(c)).catch(e => { console.error("[15dk] hata:", e?.message || e); process.exit(1); });
}
