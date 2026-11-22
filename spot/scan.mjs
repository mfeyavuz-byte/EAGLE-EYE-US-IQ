// Spot tarama — bist-bot'un scanOne mantığının ABD uyarlaması.
// Günlük mum = sinyal, haftalık mum = üst trend. Varsa Alpaca canlı fiyatı son mumu günceller.
import { getSignals, enrichData, getHigherTrend } from "../core/engine.mjs";
import { fetchDaily, weeklyFromDaily } from "../data/yahoo.mjs";
import { readFileSync, existsSync } from "node:fs";
import { nyDate, sessionFraction } from "../data/market.mjs";
import { alpacaEnabled, dailyBars } from "../data/alpaca.mjs";

const env = (k, d) => (process.env[k] != null && process.env[k] !== "" ? +process.env[k] : d);
// ABD eşikleri (Kasım 2026 tam evren taraması: BIST eşikleriyle 1.328 hissenin 414'ü geçiyordu, 348'i SAT).
// Motorun güveni ABD'de yüksek kümeleniyor (AL medyanı ~89) → ayırt edici olan göreli güç, trend teyidi ve hacim.
export const CFG = {
  MIN_CONF: env("MIN_CONF", 75),          // AL güven barı
  MIN_CONF_SAT: env("MIN_CONF_SAT", 80),  // SAT güven barı
  MIN_ADX: env("MIN_ADX", 20),            // AL trend gücü
  MIN_ADX_SAT: env("MIN_ADX_SAT", 25),    // SAT trend gücü
  MAX_RSI_BUY: env("MAX_RSI_BUY", 63),    // geç/aşırı-alım girişi ele
  MIN_RSI_SAT: env("MIN_RSI_SAT", 30),    // zaten aşırı satılmışa geç SAT verme (tahliye dibi)
  MIN_DVOL: env("MIN_DVOL", 50e6),        // günlük ort. işlem hacmi ($)
  CONC: env("CONC", 8),
};

// Sıralama puanı: güven + trend gücü + göreli güç (sinyal yönünde) + hacim teyidi.
export function quality(a) {
  const dir = a.signal === "SAT" ? -1 : 1;
  return a.confidence + Math.min(a.adx || 0, 40) / 2 + Math.max(0, Math.min(30, dir * (a.rs60 || 0))) / 2 + Math.min(a.volPace || 0, 2) * 5;
}

const ret = (rows, n) => {
  if (rows.length <= n) return 0;
  const a = rows[rows.length - 1 - n].close, b = rows[rows.length - 1].close;
  return a ? (b - a) / a * 100 : 0;
};

// Canlı fiyatı (aynı NY günündeyse) son günlük muma uygula.
function applyLive(daily, live) {
  if (!live || !daily.length) return daily;
  const last = daily[daily.length - 1];
  if (nyDate(new Date(last.ts)) !== nyDate(new Date(live.ts))) return daily;
  const p = live.price;
  daily[daily.length - 1] = { ...last, close: p, high: Math.max(last.high, p), low: Math.min(last.low, p) };
  return daily;
}

// Motor stop/hedefi hep ALIŞ yönüne göre verir. SAT (kısa) için fiyat etrafında aynala.
export function orientLevels(price, signal, { stopLoss, target1, target2 }) {
  if (signal !== "SAT") return { stopLoss, target1, target2 };
  const flip = v => (v == null ? v : +(2 * price - v).toFixed(2));
  return { stopLoss: flip(stopLoss), target1: flip(target1), target2: flip(target2) };
}

// Tek sembolün TAM analizi (filtresiz) — /hisse komutu ve tarama bunu kullanır.
// Bu çalışmada çekilen günlük mumlar (opsiyon tarafı HV için yeniden kullanır → tekrar istek yok)
export const dailyCache = new Map();

// Evren: spot/universe.json (S&P 500 + Nasdaq, likidite filtreli; haftalık yenilenir). Yoksa symbols.json.
export function loadUniverse() {
  const u = new URL("./universe.json", import.meta.url), f = new URL("./symbols.json", import.meta.url);
  if (existsSync(u)) { const j = JSON.parse(readFileSync(u, "utf8")); return { symbols: j.symbols, meta: j.meta || {}, updated: j.updated }; }
  return { symbols: JSON.parse(readFileSync(f, "utf8")), meta: {}, updated: null };
}

export async function analyze(sym, { live = null, spyRet60 = 0, daily: pre = null } = {}) {
  const daily = applyLive(pre && pre.length >= 60 ? pre : await fetchDaily(sym), live);
  dailyCache.set(sym, daily);
  if (daily.length < 60) return null;
  const ed = enrichData(daily);
  const last = ed[ed.length - 1];
  if (!last) return null;
  const weekly = weeklyFromDaily(daily);                    // üst trend: günlükten türetilmiş haftalık
  const k = getSignals(ed, getHigherTrend(weekly), weekly);
  if (!k) return null;
  const prev = daily.slice(-21, -1);                       // bugünün (kısmi) mumu hariç son 20 gün
  const avgVol = prev.length ? prev.reduce((a, b) => a + (b.volume || 0), 0) / prev.length : 0;
  // Hacim temposu: bugünkü hacim / (ortalama × seansın geçen kısmı). Bugünün mumu değilse frac = 1.
  const isToday = nyDate(new Date(last.ts)) === nyDate();
  const frac = isToday ? sessionFraction() : 1;
  const volPace = avgVol ? +((last.volume || 0) / (avgVol * frac)).toFixed(2) : 0;
  const ret60 = ret(daily, 60);
  const price = last.close;
  const rr = k.target1 && k.stopLoss && price > k.stopLoss ? +((k.target1 - price) / (price - k.stopLoss)).toFixed(2) : 0;
  const { stopLoss, target1, target2 } = orientLevels(price, k.final, k);
  const a = {
    sym, price, live: !!live, signal: k.final, confidence: k.confidence, adx: Math.round(k.adx || 0),
    rsi: last.rsi != null ? Math.round(last.rsi) : null, htf: k.higherTrend, htfNote: k.htfNote || "",
    dip: k.dipSignal ? (k.dipSignal.score || 1) : 0, stopLoss, target1, target2,
    rr, atr: last.atr > 0 ? +last.atr.toFixed(2) : null, mod: k.mod, entryHint: k.entryHint,
    waitReasons: k.waitReasons, dollarVol: Math.round(avgVol * price), volPace,
    ret60: +ret60.toFixed(1), rs60: +(ret60 - spyRet60).toFixed(1),   // SPY'a göre göreli güç
  };
  a.passed = passes(a);   // opsiyon motoru yalnızca filtreyi geçen sinyale yön verir
  return a;
}

// Kalite filtresi — bist-bot ile aynı kurallar, eşikler ABD için ayarlanabilir (env).
export function passes(a) {
  if (!a || a.signal === "NÖTR") return false;
  if (a.dollarVol < CFG.MIN_DVOL) return false;
  const isDip = a.dip > 0;
  if (a.signal === "SAT") {
    // SAT: yalnızca teyitli düşüş — haftalık trend AŞAĞI, güçlü trend, SPY'dan zayıf, henüz aşırı satılmamış.
    if (a.confidence < CFG.MIN_CONF_SAT) return false;
    if (a.htf !== "ASAGI") return false;
    if (a.adx < CFG.MIN_ADX_SAT) return false;
    if ((a.rs60 ?? 0) >= 0) return false;
    if ((a.rsi ?? 50) < CFG.MIN_RSI_SAT) return false;
    return true;
  }
  if (a.confidence < CFG.MIN_CONF) return false;
  if (isDip) return true;                                            // dip dönüşü: trend/göreli güç şartı yok
  if (a.adx < CFG.MIN_ADX) return false;
  if (a.htfNote.includes("⚠")) return false;
  if (a.htf === "ASAGI") return false;
  if ((a.rs60 ?? 0) <= 0) return false;                              // AL: SPY'dan güçlü olmalı (göreli güç)
  if (a.volPace < 0.7) return false;                                 // hacim kuruması = teyitsiz AL (seans temposuna göre)
  if ((a.rsi || 0) >= CFG.MAX_RSI_BUY) return false;
  return true;
}

export async function scanAll(symbols, { liveMap = {}, spyRet60 = 0 } = {}) {
  const out = [], all = [];
  let ok = 0;
  // Alpaca varsa tüm mumlar toplu çekilir (~60 istek); yoksa/eksikse sembol başına Yahoo.
  const bulk = alpacaEnabled() ? await dailyBars(symbols) : {};
  const nBulk = Object.keys(bulk).length;
  if (alpacaEnabled()) console.log(`Alpaca toplu mum: ${nBulk}/${symbols.length} sembol`);
  const conc = nBulk ? 32 : CFG.CONC;                       // toplu veride iş CPU'da → yüksek eşzamanlılık
  for (let i = 0; i < symbols.length; i += conc) {
    const batch = symbols.slice(i, i + conc);
    const res = await Promise.all(batch.map(s => analyze(s, { live: liveMap[s], spyRet60, daily: bulk[s] }).catch(() => null)));
    res.forEach(a => { if (a) { ok++; all.push(a); } if (passes(a)) out.push(a); });
  }
  out.forEach(a => { a.q = +quality(a).toFixed(1); });
  out.sort((a, b) => a.signal !== b.signal ? (a.signal === "AL" ? -1 : 1) : b.q - a.q);
  return { signals: out, analyzed: ok, all };
}

export async function spyReturn60() {
  const d = await fetchDaily("SPY");
  dailyCache.set("SPY", d);
  return { ret60: +ret(d, 60).toFixed(1), rows: d };
}
