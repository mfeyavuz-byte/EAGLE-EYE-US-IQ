// CANLI VERİ DENETİMİ — fikirlerin gerçekten ANLIK veriyle üretildiğini ölçer ve Telegram'a yazar.
// Her seans günü ilk taramada (09:35 NY sonrası) otomatik + /veri komutuyla istendiğinde. Ölçülenler:
//   1) Alpaca IEX son işlem yaşı (SPY, QQQ)           → ≤ 60 sn olmalı
//   2) Alpaca 1 dk mum yaşı (SPY)                      → ≤ 3 dk (ani hareket alarmı bunu kullanır)
//   3) Yahoo SPY fiyatı: yaşı ve Alpaca ile farkı      → yaş ≤ 2 dk, fark ≤ %0.10
//   4) Yahoo opsiyon zinciri (SPY): zincirin ima ettiği dayanak fiyatı canlıdan ne kadar geride → ≤ %0.15
//   5) VIX: Yahoo ^VIX 15 dk gecikmeli (Cboe) → gün içi skorda canlı vekil VIXY (Alpaca) kullanılır; yaşı ölçülür
//   6) Taramanın canlı fiyat kapsamı (st.data)
// Bilinen sabit gecikmeler (ücretsiz veri sınırları) açıkça yazılır: Alpaca SIP günlük mum 16 dk (bugünün kapanışı canlı
// fiyatla değiştirilir), ES/NQ vadeli 10 dk (sabah mesajında ön piyasa SPY/QQQ canlı fiyatı tercih edilir).
import { liveQuotes, intradayBars, alpacaEnabled } from "../data/alpaca.mjs";
import { quoteNow, optionChain } from "../data/yahoo.mjs";
import { paritySpot } from "../options/chain.mjs";
import { isRegularHours, fmtTR } from "../data/market.mjs";

export const FRESH_MS = 5 * 60e3;
// Canlı fiyat ancak zaman damgası varsa ve taze ise kullanılır; değilse null (çağıran yedeğe düşer)
export const freshPrice = (q, now = Date.now(), maxMs = FRESH_MS) => (q?.price > 0 && q.ts && now - q.ts <= maxMs ? q.price : null);
export const ageTxt = ms => (ms == null || !isFinite(ms) ? "—" : ms < 90e3 ? `${Math.max(0, Math.round(ms / 1e3))} sn` : ms < 5400e3 ? `${Math.round(ms / 60e3)} dk` : `${(ms / 3600e3).toFixed(1)} sa`);

// Saf değerlendirme (test edilebilir): ölçümler → satırlar + sorunlar
export function judgeAudit(m, open = true) {
  const L = [], bad = [];
  const row = (ok, txt) => { L.push(`${ok == null ? "•" : ok ? "✅" : "⚠"} ${txt}`); if (ok === false) bad.push(txt); };
  const lim = (v, max) => (open && v != null ? v <= max : null);
  for (const s of ["SPY", "QQQ"]) {
    const a = m.iex?.[s];
    row(a ? lim(a.ageMs, 60e3) : (m.alpaca ? false : null), a ? `Alpaca IEX ${s} $${a.price} · son işlem ${ageTxt(a.ageMs)} önce` : m.alpaca ? `Alpaca IEX ${s}: veri gelmedi` : `Alpaca anahtarı yok → canlı fiyat Yahoo'dan`);
  }
  if (m.alpaca) row(m.barAgeMs != null ? lim(m.barAgeMs, 180e3) : false, `Alpaca 1 dk mum (SPY): son mum ${ageTxt(m.barAgeMs)} önce`);
  if (m.yahoo) row(open ? lim(m.yahoo.ageMs, 120e3) && (m.diffPct == null || Math.abs(m.diffPct) <= 0.1) : null,
    `Yahoo SPY $${m.yahoo.price} · ${ageTxt(m.yahoo.ageMs)} önce${m.diffPct != null ? ` · Alpaca ile fark %${m.diffPct.toFixed(2)}` : ""}`);
  else row(false, "Yahoo SPY fiyatı alınamadı");
  if (m.parityGap != null) row(open ? Math.abs(m.parityGap) <= 0.0015 : null, `Opsiyon zinciri (Yahoo SPY): ima ettiği fiyat canlıdan %${(m.parityGap * 100).toFixed(2)} farklı${Math.abs(m.parityGap) > 0.0005 ? " → primler canlı fiyata göre yeniden hesaplanıyor" : ""}`);
  else row(false, "Opsiyon zinciri alınamadı");
  if (m.vixy) row(lim(m.vixy.ageMs, 300e3), `VIX canlı vekili VIXY $${m.vixy.price} · ${ageTxt(m.vixy.ageMs)} önce (Yahoo ^VIX 15 dk gecikmeli → gün içi skorda VIXY)`);
  else row(null, "VIX: Yahoo ^VIX (15 dk gecikmeli; Alpaca yoksa canlı vekil yok)");
  if (m.scan) row(open ? m.scan.live >= m.scan.of * 0.5 && (m.scan.med ?? 99) <= 30 : null, `Tarama: ${m.scan.live}/${m.scan.of} hissede canlı fiyat · medyan yaş ${m.scan.med ?? "—"} dk (az işlem gören hisselerde IEX seyrek)`);
  L.push("• Sabit gecikmeler (ücretsiz veri): Alpaca günlük mum 16 dk → bugünün kapanışı canlı fiyatla değiştirilir; ES/NQ vadeli 10 dk → sabah mesajında ön piyasa SPY/QQQ canlı fiyatı tercih edilir.");
  return { lines: L, bad };
}

// Ölçüm (ağ) → metin
export async function liveAudit(st = {}, now = Date.now()) {
  const open = isRegularHours(new Date(now)), m = { alpaca: alpacaEnabled() };
  const live = m.alpaca ? await liveQuotes(["SPY", "QQQ", "VIXY"]).catch(() => ({})) : {};
  m.iex = {};
  for (const s of ["SPY", "QQQ"]) if (live[s]) m.iex[s] = { price: live[s].price, ageMs: live[s].ts ? now - live[s].ts : null };
  if (live.VIXY) m.vixy = { price: live.VIXY.price, ageMs: live.VIXY.ts ? now - live.VIXY.ts : null };
  if (m.alpaca) {
    const b = await intradayBars(["SPY"], new Date(now - 30 * 60e3).toISOString(), "1Min").catch(() => null);
    const last = b?.SPY?.at(-1);
    m.barAgeMs = last ? now - last.ts - 60e3 : null;                 // mum zamanı = başlangıç; kapanışı +1 dk
  }
  const y = await quoteNow("SPY", now).catch(() => null);
  if (y) m.yahoo = { price: y.price, ageMs: y.time ? now - y.time : null };
  const S = freshPrice(live.SPY, now) ?? y?.price;
  if (S && y?.price && live.SPY?.price) m.diffPct = (live.SPY.price / y.price - 1) * 100;
  const ch = await optionChain("SPY").catch(() => null);
  if (ch && S) {
    const T = Math.max(1 / 365, ((ch.exp || 0) + 20 * 3600 - now / 1e3) / (365 * 86400));
    const So = paritySpot([{ T, calls: ch.calls, puts: ch.puts }], S, 0.04, 0.012);
    m.parityGap = So ? So / S - 1 : null;
  }
  if (st.data) m.scan = { live: st.data.live, of: st.data.of, med: st.data.medAgeMin };
  const { lines, bad } = judgeAudit(m, open);
  const head = `🔎 CANLI VERİ DENETİMİ — ${fmtTR(new Date(now))} TR${open ? "" : " (seans KAPALI: yaşların eski olması normal)"}`;
  const verdict = !open ? "Seans dışında ölçüldü — seans içinde tekrar: /veri" : bad.length ? `⚠ ${bad.length} sorun: fikirler bu kaynaklarda gecikmeli veriyle üretilmiş olabilir.` : "✅ SONUÇ: tüm fikirler anlık canlı veriyle üretiliyor.";
  return { text: [head, ...lines, "", verdict].join("\n"), bad, open };
}
