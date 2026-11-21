// Alpaca ücretsiz plan — IEX canlı son işlem fiyatı + piyasa saati (tatiller dahil).
// OPSİYONEL: ALPACA_KEY_ID / ALPACA_SECRET_KEY yoksa her şey sessizce atlanır, bot Yahoo ile çalışır.
// Not: IEX tek bir borsadır → hacmi tüm piyasanın küçük bir kısmı. Bu yüzden SADECE fiyat kullanılır.
const KEY = process.env.ALPACA_KEY_ID || "";
const SECRET = process.env.ALPACA_SECRET_KEY || "";
const HDR = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SECRET, Accept: "application/json" };

export const alpacaEnabled = () => !!(KEY && SECRET);

async function getJSON(url, timeout = 10000) {
  const ctrl = new AbortController(), tid = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: HDR, signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) { console.error("[Alpaca]", r.status, url.split("?")[0]); return null; }
    return await r.json();
  } catch (e) { clearTimeout(tid); console.error("[Alpaca]", e.message); return null; }
}

// { SYM: { price, ts } } — sembolleri 100'lük gruplarla çeker.
export async function liveQuotes(symbols) {
  const out = {};
  if (!alpacaEnabled()) return out;
  for (let i = 0; i < symbols.length; i += 100) {
    const chunk = symbols.slice(i, i + 100).join(",");
    const j = await getJSON(`https://data.alpaca.markets/v2/stocks/snapshots?symbols=${encodeURIComponent(chunk)}&feed=iex`);
    if (!j) continue;
    for (const [sym, s] of Object.entries(j)) {
      const p = s?.latestTrade?.p, t = s?.latestTrade?.t;
      if (typeof p === "number" && p > 0) out[sym] = { price: +p.toFixed(2), ts: Date.parse(t) || Date.now() };
    }
  }
  return out;
}

// Piyasa açık mı? (resmî tatilleri bilir). Alpaca yoksa null → çağıran saat hesabına düşer.
export async function alpacaClock() {
  if (!alpacaEnabled()) return null;
  const j = await getJSON("https://paper-api.alpaca.markets/v2/clock");
  return j && typeof j.is_open === "boolean" ? j.is_open : null;
}
