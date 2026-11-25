// SPY / QQQ — 15 DAKİKADA BİR GÜN İÇİ OPSİYON FİKRİ (yalnız ALIM: call ya da put alımı; opsiyon satışı/açığa satış YOK).
// Seans içinde 09:45–15:45 NY arası her çeyrek saatte (TR kışın 17:45–23:45) tek mesaj: iki ETF için yön + kontrat + hedef/stop.
// Yön skoru (5 dk mumlar): VWAP üstü/altı · EMA9/EMA21 · açılış aralığı (ilk 30 dk) kırılımı · son 15 dk ivmesi ·
//   günlük trend (20 günlük ort.) · VIX gün içi değişimi · aşırı RSI(5 dk) cezası. |skor| ≥ 3 → CALL/PUT, değilse NÖTR (işlem yok).
// Seviyeler: risk R = max(1.5 × ATR(5 dk), fiyatın %0.15'i) · stop = giriş ∓ R · hedef = giriş ± 2R (risk/ödül 1:2) · zaman stopu.
// Olasılık DÜRÜST verilir: kaymasız fiyatta hedefin stoptan önce gelme olasılığı R/(R+2R) = %33; vadede kâr olasılığı log-normal.
// ⚠ Geriye dönük test edilmedi (ücretsiz geçmiş gün içi opsiyon verisi yok) → yalnız fikirdir.
import { pathToFileURL } from "node:url";
import { nyParts, isMarketOpen, fmtTR } from "../data/market.mjs";
import { intradayBars, liveQuotes, alpacaEnabled } from "../data/alpaca.mjs";
import { fetchChart, fetchDaily, quoteNow, optionChain, riskFreeRate } from "../data/yahoo.mjs";
import { bs, impliedVol } from "../options/bs.mjs";
import { paritySpot } from "../options/chain.mjs";
import { popLong } from "./morning.mjs";
import { sendTG } from "./telegram.mjs";

export const IDX = { SYMS: ["SPY", "QQQ"], START: 585, END: 950, ODTE_UNTIL: 870, MIN_SCORE: 3, R_ATR: 1.5, R_MIN: 0.0015, RR: 2, SLIP: 0.3, MAX_SPREAD: 0.15 };
const YR = 365 * 864e5;

// New York saatiyle dateIso günü h:m → UTC ms (yaz/kış saati otomatik)
export function nyTs(dateIso, h, m) {
  const [y, mo, d] = dateIso.split("-").map(Number);
  for (const off of [4, 5]) {
    const t = Date.UTC(y, mo - 1, d, h + off, m), p = nyParts(new Date(t));
    if (p.date === dateIso && p.mins === h * 60 + m) return t;
  }
  return Date.UTC(y, mo - 1, d, h + 5, m);
}

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
    const ch = vix.now / vix.prev - 1;
    if (ch > 0.05) { s -= 1; why.push(`VIX +%${(ch * 100).toFixed(0)} (korku artıyor)`); } else if (ch < -0.05) { s += 0.5; why.push(`VIX −%${(-ch * 100).toFixed(0)}`); }
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

const f2 = x => (x == null || !isFinite(x) ? "—" : x.toFixed(2));
const pct = x => (x == null ? "—" : (x >= 0 ? "+" : "−") + "%" + Math.abs(x * 100).toFixed(Math.abs(x) < 0.1 ? 2 : 0));

async function oneSymbol(sym, ctx) {
  const { today, sessStart, mins, r, vix, live, intra } = ctx;
  let bars = (intra[sym] || []).filter(b => b.ts >= sessStart);
  if (bars.length < 3) bars = (await fetchChart(sym, "5m", "1d").catch(() => [])).filter(b => b.ts >= sessStart);
  const drows = (await fetchDaily(sym).catch(() => [])).filter(b => b.ts < sessStart - 3600e3);
  const closes = drows.map(b => b.close);
  const daily = closes.length >= 20 ? { prevClose: closes.at(-1), sma20: closes.slice(-20).reduce((a, x) => a + x, 0) / 20 } : { prevClose: closes.at(-1) ?? null, sma20: null };
  const S = live[sym]?.price ?? bars.at(-1)?.close;
  const sig = idxSignal(bars, S, daily, vix);
  if (!sig) return { sym, text: `${sym}: veri alınamadı.` };
  const head = `${sym} $${f2(S)} · gün ${pct(sig.dayChg)} · VWAP ${f2(sig.vwap)}${sig.rsi != null ? ` · RSI(5dk) ${sig.rsi.toFixed(0)}` : ""}`;
  if (!sig.dir) return { sym, sig, text: `${head}\n⚪ NÖTR (skor ${sig.score >= 0 ? "+" : ""}${sig.score}) — net yön yok → işlem yok, bekle.${sig.why.length ? `\n   ${sig.why.join(" · ")}` : ""}` };

  // Vade: 14:30 NY'ye kadar 0DTE, sonrası 1DTE (son saatlerde 0DTE zaman kaybı çok sert)
  const want0 = mins < IDX.ODTE_UNTIL;
  const first = await optionChain(sym).catch(() => null);
  const exps = (first?.expirations || []).map(e => ({ e, d: new Date(e * 1e3).toISOString().slice(0, 10) }));
  const ex = want0 ? exps.find(x => x.d === today) ?? exps.find(x => x.d > today) : exps.find(x => x.d > today);
  let pick = null, T = null, expD = ex?.d;
  if (ex) {
    const ch = ex.e === first.exp ? first : await optionChain(sym, ex.e).catch(() => null);
    T = Math.max(15 * 60e3, nyTs(ex.d, 16, 0) - Date.now()) / YR;
    const q = Math.min(0.05, first?.quote?.divYield || 0);
    // Opsiyon kotasyonları dayanaktan birkaç dk gecikmeli olabilir → IV/delta, zincirin kendi ima ettiği fiyatla (parite) hesaplanır;
    // stop/hedef aynı mesafeyle o fiyata taşınır (aksi halde 0DTE'de IV ve olasılıklar ciddi bozulur).
    const So = ch ? paritySpot([{ T, calls: ch.calls, puts: ch.puts }], S, r, q) ?? S : S;
    pick = ch ? pickIdxContract(sig.dir === "C" ? ch.calls : ch.puts, sig.dir, So, T, r, q, ex.d === today ? 0.45 : 0.5) : null;
    if (pick) {
      pick.prem = +(pick.mid + IDX.SLIP * (pick.ask - pick.bid)).toFixed(2);
      const T2 = Math.max(5 * 60e3, T * YR - 30 * 60e3) / YR;           // seviyeye ~30 dk'da varıldığı varsayımı
      pick.atStop = bs(sig.dir, So + (sig.stop - S), pick.K, T2, r, q, pick.iv).price;
      pick.atTgt = bs(sig.dir, So + (sig.target - S), pick.K, T2, r, q, pick.iv).price;
      pick.pop = popLong(sig.dir, So, pick.K, pick.prem, T, pick.iv);
    }
  }
  const lab = sig.dir === "C" ? "🟢 CALL AL" : "🔴 PUT AL";
  const L = [head, `${lab} — skor ${sig.score >= 0 ? "+" : ""}${sig.score} · ${sig.why.join(" · ")}`];
  L.push(`   Dayanak: giriş ~${f2(S)} · stop ${f2(sig.stop)} · hedef ${f2(sig.target)} (risk/ödül 1:${IDX.RR})`);
  if (pick) {
    const dte = expD === today ? "0DTE (bugün)" : `sonraki vade (${expD})`;
    L.push(`   Kontrat: ${sym} ${pick.K}${sig.dir} · ${dte} · delta ${Math.abs(pick.delta).toFixed(2)} · prim ~$${f2(pick.prem)} (spread %${(pick.spread * 100).toFixed(0)})`);
    L.push(`   Opsiyon: stop ≈ $${f2(pick.atStop)} (${pct(pick.atStop / pick.prem - 1)}) · hedef ≈ $${f2(pick.atTgt)} (${pct(pick.atTgt / pick.prem - 1)}) · zaman stopu ${expD === today ? "45" : "90"} dk`);
    L.push(`   Olasılık: hedefin stoptan önce gelmesi ≈ %33 (kuramsal, 1:2) · vadede kâr ${pick.pop != null ? "%" + Math.round(pick.pop * 100) : "—"}`);
  } else L.push("   Kontrat: likit 0DTE/1DTE kontrat bulunamadı (spread geniş ya da zincir alınamadı) → dayanak seviyeleriyle izle.");
  return { sym, sig, pick, text: L.join("\n") };
}

export async function buildIdx15(now = new Date()) {
  const { date: today, mins } = nyParts(now);
  const sessStart = nyTs(today, 9, 30);
  const [r, vq, live, intra] = await Promise.all([
    riskFreeRate().catch(() => 0.04),
    quoteNow("^VIX").catch(() => null),
    alpacaEnabled() ? liveQuotes(IDX.SYMS).catch(() => ({})) : {},
    alpacaEnabled() ? intradayBars(IDX.SYMS, new Date(sessStart).toISOString()).catch(() => ({})) : {},
  ]);
  const vix = vq ? { now: vq.price, prev: vq.prevClose } : null;
  const ctx = { today, sessStart, mins, r, vix, live, intra };
  const parts = [];
  for (const sym of IDX.SYMS) parts.push(await oneSymbol(sym, ctx).catch(e => ({ sym, text: `${sym}: hata (${e?.message || e})` })));
  const hh = String(Math.floor(mins / 60)).padStart(2, "0"), mm = String(mins % 60).padStart(2, "0");
  const text = [`⏱ SPY/QQQ 15 DK OPSİYON FİKRİ — ${hh}:${mm} NY · ${fmtTR(now)} TR`,
    vix ? `VIX ${f2(vix.now)} (${pct(vix.prev ? vix.now / vix.prev - 1 : null)})` : "VIX —", "",
    parts.map(p => p.text).join("\n\n"), "",
    `Yalnız ALIM (call/put alımı, opsiyon satışı yok). Kaynak: ${alpacaEnabled() ? "Alpaca IEX canlı" : "Yahoo"} + Yahoo opsiyon zinciri. Geriye dönük test edilmedi. ⚠ Yatırım tavsiyesi değildir.`].join("\n");
  return { text, parts };
}

// Çıkış kodu: 0 = gönderildi · 3 = saat/seans dışı (bir şey yapılmadı)
async function main() {
  const { mins, wd } = nyParts();
  if (process.env.FORCE !== "1") {
    if (wd === "Sat" || wd === "Sun" || mins < IDX.START || mins >= IDX.END) { console.log("[15dk] seans penceresi dışında."); return 3; }
    if (!(await isMarketOpen())) { console.log("[15dk] piyasa kapalı (tatil)."); return 3; }
  }
  const { text } = await buildIdx15();
  const ok = await sendTG(text);
  console.log(`[15dk] SPY/QQQ fikri ${ok ? "gönderildi" : "GÖNDERİLEMEDİ"}.`);
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then(c => process.exit(c)).catch(e => { console.error("[15dk] hata:", e?.message || e); process.exit(1); });
}
