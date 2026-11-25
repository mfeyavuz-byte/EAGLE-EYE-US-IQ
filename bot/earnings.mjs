// BİLANÇO STRADDLE — yalnız ALIM: aynı vadede ATM call + ATM put birlikte alınır (yön tahmini yok; büyük hareket bahsi).
// Mantık: opsiyonların fiyatladığı hareket (straddle maliyeti ÷ hisse fiyatı) o hissenin SON 4 bilançodaki gerçek
// tepkisinin ortalamasından belirgin düşükse (oran ≤ 0.8) straddle "ucuz" → AL. Pahalıysa listelenir, önerilmez.
// Zamanlama: bugün kapanış sonrası (amc) ya da yarın açılış öncesi (bmo) açıklayanlar → bugün 15:00–15:50 NY'de alınır,
//   tepki günü 10:00 NY'de satılır (çıkış mesajı + sanal pozisyon kapanışı). Saat Nasdaq'ta yoksa Yahoo zaman damgası.
// Evren: piyasa değeri ≥ $20 milyar, botun evrenindeki hisseler, en çok 12 aday. Sanal hesapta (paper) gerçek emir.
// ⚠ Geriye dönük test: Actions → "Bilanço straddle testi" (research/earnings.mjs, Alpaca geçmiş opsiyon fiyatları).
import { nyParts } from "../data/market.mjs";

export const ER = { CHEAP: 0.8, MIN_MCAP: 20e9, MAX: 12, EXIT_MIN: 600 };

// Geçmiş tepki: her açıklama günü D için max(|D/D−1|, |D+1/D|) — saat bilinmediğinden iki olasılığın büyüğü
export function realizedMoves(daily, dates) {
  const ds = daily.map(r => nyParts(new Date(r.ts)).date), out = [];
  for (const D of dates) {
    const i = ds.indexOf(D);
    if (i < 1) continue;
    const a = Math.abs(daily[i].close / daily[i - 1].close - 1), b = i + 1 < daily.length ? Math.abs(daily[i + 1].close / daily[i].close - 1) : 0;
    out.push(Math.max(a, b));
  }
  return out;
}

// ATM straddle: her iki bacağı kotasyonlu, dayanağa en yakın strike. Dönüş: { K, cost, occC, occP, spread } | null
export function atmStraddle(calls, puts, S) {
  const mid = o => (o && o.bid > 0 && o.ask >= o.bid ? (o.bid + o.ask) / 2 : null);
  const ks = (calls || []).map(c => c.strike).filter(K => mid(calls.find(c => c.strike === K)) && mid((puts || []).find(p => p.strike === K)))
    .sort((a, b) => Math.abs(a - S) - Math.abs(b - S));
  if (!ks.length) return null;
  const K = ks[0], c = calls.find(x => x.strike === K), p = puts.find(x => x.strike === K);
  const cost = mid(c) + mid(p), spr = (c.ask - c.bid) + (p.ask - p.bid);
  return { K, cost: +(cost + 0.3 * spr).toFixed(2), occC: c.sym, occP: p.sym, spread: spr / cost, cMid: mid(c), pMid: mid(p) };
}

// Yahoo bilanço zaman damgası (sn) → { date, when: "bmo"|"amc" }
export function yahooTiming(ts) {
  if (!ts) return null;
  const { date, mins } = nyParts(new Date(ts * 1e3));
  return { date, when: mins < 720 ? "bmo" : "amc" };
}

const pc = x => (x == null ? "—" : `%${(x * 100).toFixed(1)}`);
// deps: { earningsOn, reportDates, optionChain, fetchDaily, inUniverse(sym) }
export async function buildEarnings(today, nextDay, deps) {
  const rows = [...(await deps.earningsOn(today).catch(() => [])).map(r => ({ ...r, d: today })),
    ...(await deps.earningsOn(nextDay).catch(() => [])).map(r => ({ ...r, d: nextDay }))]
    .filter(r => r.mcap >= ER.MIN_MCAP && deps.inUniverse(r.sym)).sort((a, b) => b.mcap - a.mcap).slice(0, ER.MAX * 2);
  const res = [];
  for (const r of rows) {
    if (res.length >= ER.MAX) break;
    const ch0 = await deps.optionChain(r.sym).catch(() => null);
    if (!ch0?.quote?.price) continue;
    const yt = yahooTiming(ch0.quote.earningsTs), when = r.time || (yt?.date === r.d ? yt.when : null);
    // Uygun olanlar: bugün kapanış sonrası ya da yarın açılış öncesi → tepki günü = yarın
    if (!((r.d === today && when === "amc") || (r.d === nextDay && when === "bmo"))) continue;
    const S = ch0.quote.price;
    const ex = (ch0.expirations || []).map(e => ({ e, d: new Date(e * 1e3).toISOString().slice(0, 10) })).find(x => x.d >= nextDay);
    if (!ex) continue;
    const ch = ex.e === ch0.exp ? ch0 : await deps.optionChain(r.sym, ex.e).catch(() => null);
    const st = ch && atmStraddle(ch.calls, ch.puts, S);
    if (!st || st.spread > 0.15) continue;                                   // spread geniş → gerçek maliyet belirsiz, alma
    const dates = (await deps.reportDates(r.sym).catch(() => [])).filter(d => d < today);
    const moves = realizedMoves(await deps.fetchDaily(r.sym).catch(() => []), dates);
    const real = moves.length >= 2 ? moves.reduce((a, b) => a + b, 0) / moves.length : null;
    const implied = st.cost / S, ratio = real ? implied / real : null;
    res.push({ sym: r.sym, when, S, exp: ex.d, expTs: ex.e, reactD: nextDay, ...st, implied, real, ratio, n: moves.length, cheap: ratio != null && ratio <= ER.CHEAP });
  }
  const buys = res.filter(x => x.cheap), skip = res.filter(x => !x.cheap);
  const L = [`🎯 BİLANÇO STRADDLE — ${today} (yalnız ALIM: aynı vadede ATM call + ATM put)`];
  if (!res.length) L.push("Bugün kapanış sonrası / yarın açılış öncesi açıklayan uygun (≥ $20 milyar, likit opsiyonlu) hisse yok.");
  for (const x of buys) L.push("", `🟢 STRADDLE AL ${x.sym} (${x.when === "amc" ? "bugün kapanış sonrası" : "yarın açılış öncesi"}) · $${x.S.toFixed(2)}`,
    `   ${x.sym} ${x.K}C + ${x.K}P · vade ${x.exp} · maliyet ~$${x.cost} (×100 = $${Math.round(x.cost * 100)})`,
    `   Fiyatlanan hareket ${pc(x.implied)} · son ${x.n} bilançonun ort. tepkisi ${pc(x.real)} · oran ${x.ratio.toFixed(2)} (≤ ${ER.CHEAP} = ucuz)`,
    `   Çıkış: ${x.reactD} 10:00 NY'de iki bacağı birlikte sat (çıkış mesajı gelir). Başabaş: hisse ±${pc(x.implied)} hareket etmeli.`);
  if (skip.length) L.push("", "Pahalı/yetersiz veri → önerilmez: " + skip.map(x => `${x.sym} ${pc(x.implied)} vs ${pc(x.real)}`).join(" · "));
  L.push("", "⚠ En kötü durumda straddle maliyetinin büyük kısmı kaybedilir (tepki küçük kalırsa). Geriye dönük test: Actions → \"Bilanço straddle testi\". Yatırım tavsiyesi değildir.");
  return { text: L.join("\n"), buys, all: res };
}

// Çıkış değeri: iki bacağın orta fiyatı toplamı − %30 spread | null
export function straddleValue(ch, occC, occP) {
  const c = (ch?.calls || []).find(o => o.sym === occC), p = (ch?.puts || []).find(o => o.sym === occP);
  if (!c || !p || !(c.bid > 0) || !(p.bid > 0)) return null;
  const mid = (c.bid + c.ask) / 2 + (p.bid + p.ask) / 2, spr = (c.ask - c.bid) + (p.ask - p.bid);
  return Math.max(0, mid - 0.3 * spr);
}

export function fmtEarnBook(closed) {
  if (!closed?.length) return "🎯 Bilanço straddle karnesi: henüz kapanmış işlem yok.";
  const n = closed.length, w = closed.filter(x => x.ret > 0).length, avg = closed.reduce((a, x) => a + x.ret, 0) / n;
  return `🎯 Bilanço straddle karnesi: ${n} işlem · kazanan %${Math.round(w / n * 100)} · ort. ${avg >= 0 ? "+" : ""}${(avg * 100).toFixed(1)}%`;
}
