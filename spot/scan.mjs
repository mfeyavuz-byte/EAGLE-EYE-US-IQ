// Spot tarama — bist-bot'un scanOne mantığının ABD uyarlaması.
// Günlük mum = sinyal, haftalık mum = üst trend. Varsa Alpaca canlı fiyatı son mumu günceller.
import { getSignals, enrichData, getHigherTrend } from "../core/engine.mjs";
import { fetchDaily, fetchWeekly } from "../data/yahoo.mjs";
import { nyDate, sessionFraction } from "../data/market.mjs";

const env = (k, d) => (process.env[k] != null && process.env[k] !== "" ? +process.env[k] : d);
export const CFG = {
  MIN_CONF: env("MIN_CONF", 65),        // güven barı
  MIN_ADX: env("MIN_ADX", 20),          // trend gücü barı
  MAX_RSI_BUY: env("MAX_RSI_BUY", 63),  // geç/aşırı-alım girişi ele
  MIN_DVOL: env("MIN_DVOL", 50e6),      // günlük ort. işlem hacmi ($) — ABD için 50M$
  CONC: env("CONC", 8),
};

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
export async function analyze(sym, { live = null, spyRet60 = 0 } = {}) {
  const daily = applyLive(await fetchDaily(sym), live);
  if (daily.length < 60) return null;
  const ed = enrichData(daily);
  const last = ed[ed.length - 1];
  if (!last) return null;
  const weekly = await fetchWeekly(sym);
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
  return {
    sym, price, live: !!live, signal: k.final, confidence: k.confidence, adx: Math.round(k.adx || 0),
    rsi: last.rsi != null ? Math.round(last.rsi) : null, htf: k.higherTrend, htfNote: k.htfNote || "",
    dip: k.dipSignal ? (k.dipSignal.score || 1) : 0, stopLoss, target1, target2,
    rr, atr: last.atr > 0 ? +last.atr.toFixed(2) : null, mod: k.mod, entryHint: k.entryHint,
    waitReasons: k.waitReasons, dollarVol: Math.round(avgVol * price), volPace,
    ret60: +ret60.toFixed(1), rs60: +(ret60 - spyRet60).toFixed(1),   // SPY'a göre göreli güç
  };
}

// Kalite filtresi — bist-bot ile aynı kurallar, eşikler ABD için ayarlanabilir (env).
export function passes(a) {
  if (!a || a.signal === "NÖTR") return false;
  if (a.dollarVol < CFG.MIN_DVOL) return false;
  const isDip = a.dip > 0;
  if (a.confidence < CFG.MIN_CONF) return false;
  if (!isDip && a.adx < CFG.MIN_ADX) return false;
  if (!isDip && a.htfNote.includes("⚠")) return false;
  if (!isDip && a.signal === "AL" && a.htf === "ASAGI") return false;
  if (a.signal === "SAT" && a.htf === "YUKARI") return false;
  if (!isDip && a.signal === "AL" && a.volPace < 0.7) return false;   // hacim kuruması = teyitsiz AL (seans temposuna göre)
  if (!isDip && a.signal === "AL" && (a.rsi || 0) >= CFG.MAX_RSI_BUY) return false;
  return true;
}

export async function scanAll(symbols, { liveMap = {}, spyRet60 = 0 } = {}) {
  const out = [];
  let ok = 0;
  for (let i = 0; i < symbols.length; i += CFG.CONC) {
    const batch = symbols.slice(i, i + CFG.CONC);
    const res = await Promise.all(batch.map(s => analyze(s, { live: liveMap[s], spyRet60 }).catch(() => null)));
    res.forEach(a => { if (a) ok++; if (passes(a)) out.push(a); });
  }
  out.sort((a, b) => a.signal !== b.signal ? (a.signal === "AL" ? -1 : 1) : b.confidence - a.confidence);
  return { signals: out, analyzed: ok };
}

export async function spyReturn60() {
  const d = await fetchDaily("SPY");
  return { ret60: +ret(d, 60).toFixed(1), rows: d };
}
