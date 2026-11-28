// SPY/QQQ/GLD/SLV — 15 DAKİKALIK İŞLEM PLANI (her çeyrek, nötrde de) + en yüksek hacimli 25 hisse için SAATLİK liste.
// Yalnız ALIM (call ya da put alımı). Trend: VWAP + EMA9/21 → CALL: son 30 dk tepesi + 0.1 ATR üstü giriş · PUT: dibi altı giriş ·
// R = max(ATR(5 dk), 30 dk aralığın yarısı) · hedef 2R. Kontrat seçimi ve kontrat sayısı ortak (contractIdea, /hesap).
import { pathToFileURL } from "node:url";
import { nyParts, isMarketOpen, fmtTR, nyTs, closeTsOf } from "../data/market.mjs";
import { intradayBars, liveQuotes, alpacaEnabled } from "../data/alpaca.mjs";
import { fetchChart, optionChain, riskFreeRate } from "../data/yahoo.mjs";
import { bs, impliedVol } from "../options/bs.mjs";
import { paritySpot } from "../options/chain.mjs";
import { popLong } from "./morning.mjs";
import { sendTG } from "./telegram.mjs";
import { loadFiles, READ_FAILED } from "./state.mjs";
import { macroEvents, nearEvent, fmtNear } from "./macro.mjs";
import { freshPrice } from "./liveaudit.mjs";
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

// ORTAK KONTRAT FİKRİ (15 dk fikri + ani hareket alarmı): yön + dayanak seviyeleri → likit kontrat, prim, opsiyonun stop/hedef
// karşılığı, olasılıklar. allow0: bugün vadeli (0DTE) kullanılabilir mi. Dönüş: { pick, expD, lines }
export async function contractIdea({ sym, dir, S, stop, target, r = 0.04, today, allow0 = false, timeStop = null, timeStopFn = null, mult = 1, multTag = null }) {
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
  const size = pick ? sizeLine(SIZING, pick.prem, pick.atStop, mult) : null;
  const L = [`   Giriş ${sym} ~${f2(S)} · Hedef ${f2(target)} · Stop ${f2(stop)} · süre ${ts} dk`];
  if (pick) L.push(`   Opsiyon hedefte ~$${f2(pick.atTgt)} · stopta ~$${f2(pick.atStop)}${Math.abs(pick.gap) > 0.003 ? " · ⚠ kotasyon bayat olabilir" : ""}`);
  if (size) L.push("   " + size + (multTag ? ` · ${multTag}` : ""));
  else if (pick && multTag) L.push(`   Adet ${mult === 1 ? "normal" : "×" + mult} — ${multTag}`);
  return { pick, expD, expClose, timeStop: ts, contract, size, lines: L };
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
  if (isOn(prefs, "plan15")) { ok = await sendTG(await buildPlans(new Date(), { ev }), { panel: "plan" }); console.log(`[15dk] plan ${ok ? "gönderildi" : "GÖNDERİLEMEDİ"}.`); }
  // Saatlik (10:30, 11:30 … 15:30 NY): en hacimli 25 hisse
  if (isOn(prefs, "saatlik") && (process.env.FORCE === "1" || (mins % 60 >= 30 && mins % 60 < 45 && mins >= 630))) {
    const h = await buildHourly(new Date()).catch(e => (console.error("[saatlik]", e?.message || e), null));
    if (h) console.log(`[saatlik] ${(await sendTG(h, { panel: "saatlik" })) ? "gönderildi" : "GÖNDERİLEMEDİ"}.`);
  }
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then(c => process.exit(c)).catch(e => { console.error("[15dk] hata:", e?.message || e); process.exit(1); });
}
