// SPOT SİNYAL KARNESİ — gönderilen her AL/SAT sinyali fiyatı ve SPY ile kaydedilir; sonraki günlerde
// sinyal yönündeki getiri ve SPY'a göre fazla getiri izlenir. Haftalık raporda (Cuma kapanış öncesi) özetlenir.
// Amaç: geriye dönük testin canlıda da tutup tutmadığını görmek.
export const MAX_SPOT = 600;

export function logSignals(book, signals, date, spyPx) {
  for (const s of signals) {
    if (book.some(b => b.sym === s.sym && b.d === date && b.sig === s.signal)) continue;
    book.push({ sym: s.sym, sig: s.signal, d: date, px: s.price, spy: spyPx ?? null, conf: s.confidence });
  }
  if (book.length > MAX_SPOT) book.splice(0, book.length - MAX_SPOT);
}

// price(sym) → güncel fiyat | null. Dönüş: her kayıt için { ...b, ret (sinyal yönünde), ex (SPY'a göre) }
export function score(book, price, spyNow) {
  const out = [];
  for (const b of book) {
    const p = price(b.sym);
    if (!(p > 0) || !(b.px > 0)) continue;
    const dir = b.sig === "SAT" ? -1 : 1;
    const raw = p / b.px - 1, spyRet = b.spy && spyNow ? spyNow / b.spy - 1 : 0;
    out.push({ ...b, now: p, ret: dir * raw, ex: dir * (raw - spyRet) });
  }
  return out;
}

const pc = v => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
export function fmtSpotReport(scored, fromDate, title = "📈 SPOT SİNYAL KARNESİ") {
  const g = scored.filter(x => x.d >= fromDate);
  const L = [title + ` (${fromDate} sonrası)`];
  if (!g.length) return L.concat("Bu dönemde gönderilen sinyal yok.").join("\n");
  for (const s of ["AL", "SAT"]) {
    const x = g.filter(v => v.sig === s);
    if (!x.length) continue;
    const avg = a => a.reduce((p, v) => p + v, 0) / a.length;
    L.push(`${s}: ${x.length} sinyal · sinyal yönünde ort. ${pc(avg(x.map(v => v.ret)))} · SPY'a göre ${pc(avg(x.map(v => v.ex)))} · isabet %${Math.round(x.filter(v => v.ret > 0).length / x.length * 100)}`);
  }
  const best = [...g].sort((a, b) => b.ex - a.ex).slice(0, 3), worst = [...g].sort((a, b) => a.ex - b.ex).slice(0, 3);
  L.push("En iyi: " + best.map(v => `${v.sym} ${v.sig} ${pc(v.ret)}`).join(" · "));
  L.push("En kötü: " + worst.map(v => `${v.sym} ${v.sig} ${pc(v.ret)}`).join(" · "));
  return L.join("\n");
}
