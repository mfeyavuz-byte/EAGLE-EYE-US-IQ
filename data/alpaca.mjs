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
      // ts: son işlemin zamanı (yoksa null — "şimdi" varsayılmaz; tazelik denetimi yanılmasın) · prev: önceki gün kapanışı
      if (typeof p === "number" && p > 0) out[sym] = { price: +p.toFixed(2), ts: Date.parse(t) || null, prev: s?.prevDailyBar?.c ?? null };
    }
  }
  return out;
}

// TOPLU GÜNLÜK MUM — tüm piyasa (SIP) verisi. Ücretsiz planda SIP ≥15 dk gecikmeli serbest:
// bitişi "şimdi − 16 dk" alırız → bugünün mumu 16 dk öncesine kadar tam hacimle gelir.
// 200 sembollük gruplar + sayfalama → ~1.200 hisse × 2 yıl ≈ 60–70 istek (Yahoo'da 1.200 istek olurdu).
// Dönüş: { SYM: [{ts, open, high, low, close, volume}] } — başarısız gruplar boş kalır (Yahoo'ya düşülür).
export async function dailyBars(symbols, years = 2) {
  const out = {};
  if (!alpacaEnabled()) return out;
  const start = new Date(Date.now() - years * 365.25 * 864e5).toISOString().slice(0, 10);
  const end = new Date(Date.now() - 16 * 60e3).toISOString();
  for (let i = 0; i < symbols.length; i += 200) {
    const chunk = symbols.slice(i, i + 200);
    let token = null, pages = 0;
    do {
      const u = `https://data.alpaca.markets/v2/stocks/bars?symbols=${encodeURIComponent(chunk.join(","))}&timeframe=1Day&start=${start}&end=${encodeURIComponent(end)}&limit=10000&adjustment=all&feed=sip${token ? "&page_token=" + encodeURIComponent(token) : ""}`;
      const j = await getJSON(u, 20000);
      if (!j) break;
      for (const [sym, bars] of Object.entries(j.bars || {})) {
        const arr = out[sym] || (out[sym] = []);
        for (const b of bars) arr.push({ ts: Date.parse(b.t), date: "", open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
      }
      token = j.next_page_token; pages++;
    } while (token && pages < 50);
  }
  return out;
}

// GEÇMİŞ OPSİYON MUMLARI (Şubat 2024'ten beri). symbols: OCC kontrat sembolleri (≤100). Ücretsiz plan "indicative"
// akışı: işlemler OPRA'dan türetilmiş. Geriye dönük testte kullanılır. 429'da bekleyip tekrar dener.
// Dönüş: { OCC: [{ d:"YYYY-MM-DD", o, h, l, c, v }] } | null (yetki/ağ hatası)
export async function optionBars(symbols, start, end) {
  if (!alpacaEnabled() || !symbols.length) return null;
  const out = {};
  let token = null, pages = 0;
  do {
    const u = `https://data.alpaca.markets/v1beta1/options/bars?symbols=${encodeURIComponent(symbols.slice(0, 100).join(","))}&timeframe=1Day&start=${start}&end=${end}&limit=10000${token ? "&page_token=" + encodeURIComponent(token) : ""}`;
    let j = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const ctrl = new AbortController(), tid = setTimeout(() => ctrl.abort(), 20000);
      try {
        const r = await fetch(u, { headers: HDR, signal: ctrl.signal });
        clearTimeout(tid);
        if (r.status === 429) { await new Promise(res => setTimeout(res, 3000 * (attempt + 1))); continue; }
        if (!r.ok) { console.error("[Alpaca opsiyon]", r.status, (await r.text().catch(() => "")).slice(0, 120)); return null; }
        j = await r.json(); break;
      } catch (e) { clearTimeout(tid); await new Promise(res => setTimeout(res, 2000)); }
    }
    if (!j) return null;
    for (const [sym, bars] of Object.entries(j.bars || {})) {
      const arr = out[sym] || (out[sym] = []);
      for (const b of bars) arr.push({ d: b.t.slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
    token = j.next_page_token; pages++;
  } while (token && pages < 20);
  return out;
}

// HABERLER (Benzinga akışı, Alpaca hesabıyla ücretsiz). Dönüş: [{ t, headline, source }] (yeniden eskiye) | []
export async function news(symbol, limit = 5) {
  if (!alpacaEnabled()) return [];
  const j = await getJSON(`https://data.alpaca.markets/v1beta1/news?symbols=${encodeURIComponent(symbol)}&limit=${limit}&sort=desc`);
  return (j?.news || []).map(n => ({ t: n.created_at, headline: String(n.headline || "").trim(), source: n.source || "" })).filter(n => n.headline);
}

// HABER ARŞİVİ (araştırma): [{ t, headline, symbols }] — sayfalı, en çok maxPages × 50 başlık
export async function newsRange(symbols, startIso, endIso, maxPages = 400) {
  const out = [];
  if (!alpacaEnabled()) return out;
  let token = null, pages = 0;
  do {
    const j = await getJSON(`https://data.alpaca.markets/v1beta1/news?symbols=${encodeURIComponent(symbols.join(","))}&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}&limit=50&sort=asc${token ? "&page_token=" + encodeURIComponent(token) : ""}`, 20000);
    if (!j) break;
    for (const n of j.news || []) if (n.headline) out.push({ t: n.created_at, headline: String(n.headline).trim(), symbols: n.symbols || [] });
    token = j.next_page_token;
    await new Promise(r => setTimeout(r, 350));                          // ücretsiz plan: ≤ 200 istek/dk
  } while (token && ++pages < maxPages);
  return out;
}

// Piyasa açık mı? (resmî tatilleri bilir). Alpaca yoksa null → çağıran saat hesabına düşer.
// Bugün işlem günü mü? (resmî tatiller dahil) true/false | null (Alpaca yok/erişilemedi)
// GÜN İÇİ MUM (IEX, gerçek zamanlı) — { SYM: [{ts, open, high, low, close, volume}] }. startIso: ISO zaman damgası.
export async function intradayBars(symbols, startIso, timeframe = "5Min") {
  const out = {};
  if (!alpacaEnabled()) return out;
  let token = null, pages = 0;
  do {
    const j = await getJSON(`https://data.alpaca.markets/v2/stocks/bars?symbols=${encodeURIComponent(symbols.join(","))}&timeframe=${timeframe}&start=${encodeURIComponent(startIso)}&limit=10000&feed=iex${token ? "&page_token=" + encodeURIComponent(token) : ""}`);
    if (!j) return pages ? out : null;                                   // ilk sayfa alınamadı → null (çağıran ayırt eder)
    for (const [s, arr] of Object.entries(j.bars || {}))
      (out[s] ||= []).push(...(arr || []).map(b => ({ ts: Date.parse(b.t), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0 })));
    token = j.next_page_token;
  } while (token && ++pages < 5);
  return out;
}

// Seans saatleri (erken kapanış dahil): { open: "09:30", close: "13:00" } | null (işlem günü değil) | undefined (bilinmiyor)
const calCache = new Map();
export async function calendarDay(dateIso) {
  if (!alpacaEnabled()) return undefined;
  if (calCache.has(dateIso)) return calCache.get(dateIso);
  const j = await getJSON(`https://paper-api.alpaca.markets/v2/calendar?start=${dateIso}&end=${dateIso}`);
  if (!Array.isArray(j)) return undefined;
  const d = j.find(x => x.date === dateIso) || null, v = d ? { open: d.open, close: d.close } : null;
  calCache.set(dateIso, v);
  return v;
}

export async function isTradingDay(dateIso) {
  if (!alpacaEnabled()) return null;
  const j = await getJSON(`https://paper-api.alpaca.markets/v2/calendar?start=${dateIso}&end=${dateIso}`);
  return Array.isArray(j) ? j.some(d => d.date === dateIso) : null;
}

// { open, nextClose (ms) } | null — erken kapanış günleri (ör. Şükran Günü ertesi 13:00) dahil
export async function marketClock() {
  if (!alpacaEnabled()) return null;
  const j = await getJSON("https://paper-api.alpaca.markets/v2/clock");
  return j && typeof j.is_open === "boolean" ? { open: j.is_open, nextClose: Date.parse(j.next_close) || null } : null;
}

export async function alpacaClock() {
  if (!alpacaEnabled()) return null;
  const j = await getJSON("https://paper-api.alpaca.markets/v2/clock");
  return j && typeof j.is_open === "boolean" ? j.is_open : null;
}
