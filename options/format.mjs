// Opsiyon mesaj biçimleri (Telegram, düz metin).
const pct = (v, d = 0) => (v == null ? "—" : (v * 100).toFixed(d) + "%");
const usd = v => (v == null || !isFinite(v) ? "∞" : "$" + Math.round(v).toLocaleString("en-US"));
const sg = (v, d = 1) => (v >= 0 ? "+" : "") + v.toFixed(d);
const trDate = iso => new Date(iso + "T12:00:00Z").toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "2-digit" });

export function fmtLegs(i) {
  return i.legs.map(l => `${l.side > 0 ? "AL" : "SAT"} ${l.K}${l.type}`).join(" / ");
}

export function fmtVol(v) {
  const L = [
    `IV30 ${pct(v.iv30)} · HV20 ${pct(v.hv20)} · HV60 ${pct(v.hv60)} · IV/HV ${v.ivhv ? v.ivhv.toFixed(2) : "—"}`,
    `Rejim: ${v.regime.toUpperCase()}${v.rank != null ? ` · IV rank ${v.rank} · yüzdelik ${v.pct}` : ` · (IV geçmişi ${v.histN} gün — rank için ≥20 gerekir)`}`,
  ];
  const x = [];
  if (v.termRatio) x.push(`vade yapısı ${v.termRatio.toFixed(2)}${v.termRatio > 1.1 ? " (TERS ⚠)" : ""}`);
  if (v.skew != null) x.push(`skew ${sg(v.skew * 100)}`);
  if (v.expMove) x.push(`beklenen hareket ±$${v.expMove.usd.toFixed(2)} (±${pct(v.expMove.pct, 1)}, ${v.expMove.dte}g)`);
  if (x.length) L.push(x.join(" · "));
  if (v.earnDays != null && v.earnDays >= 0) L.push(`📅 Bilanço ${Math.round(v.earnDays)} gün sonra`);
  return L.join("\n");
}

export function fmtIdea(i, sym, n = null) {
  const credit = i.debit < 0;
  const L = [
    `${n ? n + ") " : ""}🎯 ${sym} — ${i.tr} · ${trDate(i.expDate)} (${i.dte}g)`,
    `${fmtLegs(i)} @ ${Math.abs(i.debit).toFixed(2)} ${credit ? "kredi" : "borç"}`,
    `Maks kâr ${usd(i.maxProfit)} · maks zarar ${usd(i.maxLoss)} · başabaş ${i.breakevens.map(b => "$" + b).join(" / ")}`,
    `Kâr olasılığı %${Math.round(i.pop * 100)} (piyasa %${Math.round(i.popMkt * 100)}) · EV ${i.ev >= 0 ? "+" : ""}${usd(i.ev)} (riskin ${sg(i.edge * 100)}%)` +
      (Math.abs(i.evDir) >= 1 ? `\n  ↳ EV kaynağı: fiyatlama farkı (oynaklık/skew) ${i.evVol >= 0 ? "+" : ""}${usd(i.evVol)} · yön tahmini ${i.evDir >= 0 ? "+" : ""}${usd(i.evDir)}` : ""),
    `Kötü senaryo (en kötü %5 ort.) ${usd(i.cvar5)} · Δ ${sg(i.greeks.delta)} · Θ ${sg(i.greeks.theta, 2)}$/gün · Vega ${sg(i.greeks.vega, 2)}$`,
    `Likidite: min OI ${i.oiMin} · ort. spread %${(i.spreadAvg * 100).toFixed(1)}${i.earnInside ? " · ⚠ bilanço vade içinde" : ""}`,
    `Boyut: 1 kontrat riski ${usd(i.maxLoss)} → %2 kuralıyla en az ${usd(i.minAccount)} hesap${i.contracts > 0 ? ` (ayarlı hesapta ${i.contracts} kontrat)` : ""}`,
    `Yönetim: ${i.manage}`,
  ];
  return L.join("\n");
}

export function fmtAnalysis(res) {
  if (res.error) return `⚠ ${res.sym}: ${res.error}`;
  const L = [`📊 ${res.sym} OPSİYON ANALİZİ — $${res.S.toFixed(2)}`, fmtVol(res.vol), "", ...res.reasons.map(r => "• " + r)];
  if (res.ideas.length) {
    L.push(`\nEn iyi ${res.ideas.length} yapı (${res.considered} aday arasından):\n`);
    res.ideas.forEach((i, k) => L.push(fmtIdea(i, res.sym, k + 1), ""));
  } else L.push("", `⏸ ${res.note}`);
  L.push("ℹ Gecikmeli/yaklaşık zincir verisi. Emir öncesi canlı fiyatı kontrol et. ⚠ Yatırım tavsiyesi değildir.");
  return L.join("\n");
}

export function fmtDailyIdeas(list, header) {
  const L = [header, ""];
  list.forEach((x, k) => { L.push(fmtIdea(x.idea, x.sym, k + 1), `Neden: ${x.reasons.join(" · ")}`, ""); });
  if (!list.length) L.push("Bugün filtreleri geçen pozitif beklentili opsiyon yapısı yok. (Beklemek de bir pozisyondur.)", "");
  L.push("ℹ Kâr olasılığı/EV: kalın kuyruklu dağılım + gerçekleşen oynaklık + spread kayması. ⚠ Yatırım tavsiyesi değildir.");
  return L.join("\n");
}
