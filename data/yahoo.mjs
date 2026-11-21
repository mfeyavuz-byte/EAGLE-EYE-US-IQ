// Yahoo Finance (resmî değil, anahtarsız).
//  - chart: günlük mum (haftalık mum günlükten türetilir → istek sayısı yarıya iner)
//  - options: opsiyon zinciri + temel kotasyon (temettü, bilanço tarihi) — yfinance'in kullandığı
//    standart çerez + crumb oturumuyla.
// FAIL-SAFE: her hatada boş/null döner; 429/5xx'te artan beklemeyle yeniden dener.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Yahoo sembol biçimi: BRK.B → BRK-B
export const toYahoo = s => s.replace(/\./g, "-");

let session = null;          // { cookie, crumb }
let sessionPromise = null;
async function getSession() {
  if (session) return session;
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    try {
      const r = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
      const cookie = (r.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).join("; ");
      if (!cookie) return null;
      const c = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie } });
      const crumb = c.ok ? (await c.text()).trim() : "";
      if (!crumb || crumb.length > 40 || crumb.includes("<")) return null;
      session = { cookie, crumb };
      return session;
    } catch { return null; } finally { sessionPromise = null; }
  })();
  return sessionPromise;
}

// ORTAK FREN: 429 gelince TÜM istekler birlikte bekler (her istek ayrı ayrı yüklenip sınırı uzatmasın).
// Çok fazla 429 birikirse bu run'da Yahoo'ya istek kesilir (hızlı başarısızlık) → bot çökmez, eksik veriyle devam eder.
let coolUntil = 0, strikes = 0;
export const yahooHealth = () => ({ strikes, cooling: Math.max(0, coolUntil - Date.now()) });

async function yget(url, { auth = false, timeout = 10000, tries = 3 } = {}) {
  for (let a = 0; a < tries; a++) {
    if (strikes >= 25) return null;                                   // devre kesici açık
    const wait = coolUntil - Date.now();
    if (wait > 0) await sleep(wait);
    let u = url, headers = { "User-Agent": UA, Accept: "application/json" };
    if (auth) {
      const s = await getSession();
      if (!s) return null;
      u += (u.includes("?") ? "&" : "?") + "crumb=" + encodeURIComponent(s.crumb);
      headers.Cookie = s.cookie;
    }
    for (const host of ["query1", "query2"]) {
      const ctrl = new AbortController(), tid = setTimeout(() => ctrl.abort(), timeout);
      try {
        const r = await fetch(u.replace("://query1.", `://${host}.`), { headers, signal: ctrl.signal });
        clearTimeout(tid);
        if (r.status === 401 && auth) { session = null; break; }        // crumb süresi doldu → yenile
        if (r.status === 429) { strikes++; coolUntil = Math.max(coolUntil, Date.now() + Math.min(60e3, 3e3 * strikes)); break; }
        if (r.status >= 500) { await sleep(800 * (a + 1)); continue; }
        if (!r.ok) return null;                                        // 404 vb. → sembol yok
        if (strikes > 0) strikes -= 0.25;                              // başarı → fren yavaşça gevşer
        return await r.json();
      } catch { clearTimeout(tid); }
    }
  }
  return null;
}

function parseChart(j) {
  const n = j?.chart?.result?.[0];
  if (!n?.timestamp?.length) return [];
  const q = n.indicators.quote[0], rows = [];
  n.timestamp.forEach((ts, i) => {
    if (q.close[i] == null) return;
    const c = +q.close[i];
    rows.push({
      ts: ts * 1e3, date: "",
      open: +(+(q.open[i] ?? c)).toFixed(4), high: +(+(q.high[i] ?? c)).toFixed(4),
      low: +(+(q.low[i] ?? c)).toFixed(4), close: +c.toFixed(4), volume: q.volume[i] ?? 0,
    });
  });
  return rows;
}

export async function fetchChart(sym, interval = "1d", range = "2y") {
  const j = await yget(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(toYahoo(sym))}?interval=${interval}&range=${range}&includePrePost=false`);
  return parseChart(j);
}
export const fetchDaily = sym => fetchChart(sym, "1d", "2y");

// Günlük mumdan haftalık mum (ISO hafta, Pazartesi başlangıç).
export function weeklyFromDaily(daily) {
  const out = [];
  let cur = null, key = null;
  for (const d of daily) {
    const dt = new Date(d.ts), day = (dt.getUTCDay() + 6) % 7;            // 0 = Pazartesi
    const k = Math.floor((d.ts - day * 864e5) / 864e5);                    // haftanın Pazartesi günü
    if (k !== key) { if (cur) out.push(cur); key = k; cur = { ...d }; }
    else { cur.high = Math.max(cur.high, d.high); cur.low = Math.min(cur.low, d.low); cur.close = d.close; cur.volume += d.volume || 0; }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------- Opsiyon ----------
const mapOpt = o => ({
  strike: o.strike, bid: o.bid ?? 0, ask: o.ask ?? 0, last: o.lastPrice ?? 0,
  oi: o.openInterest ?? 0, vol: o.volume ?? 0, yIV: o.impliedVolatility ?? null, sym: o.contractSymbol,
});

// Dönüş: { quote:{price, divYield, earningsTs, marketCap}, expirations:[unix sn], exp, calls, puts } | null
export async function optionChain(sym, expiration = null) {
  const j = await yget(`https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(toYahoo(sym))}${expiration ? "?date=" + expiration : ""}`, { auth: true });
  const r = j?.optionChain?.result?.[0];
  if (!r || !r.quote) return null;
  const q = r.quote, o = r.options?.[0] || {};
  const now = Date.now() / 1e3;
  const earn = [q.earningsTimestampStart, q.earningsTimestamp, q.earningsTimestampEnd].filter(t => t && t > now - 864e2).sort((a, b) => a - b)[0] || null;
  return {
    quote: {
      price: q.regularMarketPrice ?? null,
      divYield: (q.trailingAnnualDividendYield ?? (q.dividendYield != null ? q.dividendYield / 100 : 0)) || 0,
      earningsTs: earn, marketCap: q.marketCap ?? null, type: q.quoteType,
    },
    expirations: r.expirationDates || [],
    exp: o.expirationDate ?? null,
    calls: (o.calls || []).map(mapOpt),
    puts: (o.puts || []).map(mapOpt),
  };
}

// Risksiz faiz: 13 haftalık Hazine bonosu (^IRX, % cinsinden). Alınamazsa %4.
export async function riskFreeRate() {
  const rows = await fetchChart("^IRX", "1d", "5d");
  const v = rows.length ? rows[rows.length - 1].close / 100 : null;
  return v && v > 0 && v < 0.2 ? v : 0.04;
}
