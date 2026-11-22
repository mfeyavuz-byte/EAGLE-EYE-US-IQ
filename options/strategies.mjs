// Strateji adayları — YALNIZ RİSKİ SINIRLI yapılar. Her aday gerçekçi dolum fiyatıyla kurulur:
// alış = orta + %30·spread, satış = orta − %30·spread (orta fiyattan dolum varsaymak EV'yi şişirir).
import { profile } from "./dist.mjs";

export const SLIP = +(process.env.OPT_SLIP || 0.3);
const fill = (o, side) => o.mid + side * SLIP * (o.ask - o.bid);
const inR = (x, a, b) => x != null && x >= Math.min(a, b) && x <= Math.max(a, b);

export const STRAT = {
  LONG_CALL:   { tr: "LONG CALL", kind: "debit", dir: +1 },
  LONG_PUT:    { tr: "LONG PUT", kind: "debit", dir: -1 },
  BULL_CALL:   { tr: "BULL CALL SPREAD (borçlu)", kind: "debit", dir: +1 },
  BEAR_PUT:    { tr: "BEAR PUT SPREAD (borçlu)", kind: "debit", dir: -1 },
  BULL_PUT:    { tr: "BULL PUT SPREAD (kredili)", kind: "credit", dir: +1 },
  BEAR_CALL:   { tr: "BEAR CALL SPREAD (kredili)", kind: "credit", dir: -1 },
  IRON_CONDOR: { tr: "IRON CONDOR (kredili, nötr)", kind: "credit", dir: 0 },
};

function build(code, ex, legs) {
  const debit = legs.reduce((a, l) => a + l.side * fill(l.o, l.side), 0);   // >0 borç, <0 kredi (hisse başına)
  const L = legs.map(l => ({ type: l.o.type, K: l.o.K, side: l.side, qty: 1 }));
  const pr = profile(L, debit);
  const g = k => legs.reduce((a, l) => a + l.side * (l.o[k] || 0), 0);
  return {
    code, ...STRAT[code], ex, debit, L, ...pr,
    legs: legs.map(l => ({ side: l.side, type: l.o.type, K: l.o.K, bid: l.o.bid, ask: l.o.ask, mid: l.o.mid, iv: l.o.iv, delta: l.o.delta, oi: l.o.oi, vol: l.o.vol, sym: l.o.sym })),
    greeks: { delta: g("delta") * 100, gamma: g("gamma") * 100, theta: g("theta") * 100, vega: g("vega") * 100 },
    spreadAvg: legs.reduce((a, l) => a + l.o.spreadPct, 0) / legs.length,
    oiMin: Math.min(...legs.map(l => l.o.oi)),
  };
}

// Dikey spread'ler için ortak üretici. side1 = ilk bacağın yönü; ikinci bacak ters yönde, uzak strike.
function verticals(code, list, S, d1, d2, farIsHigher, side1, wMin, wMax, okPrice) {
  const out = [];
  const A = list.filter(o => o.liquid && inR(o.delta, ...d1));
  for (const a of A) {
    for (const b of list) {
      if (!b.liquid || !inR(b.delta, ...d2)) continue;
      const w = farIsHigher ? b.K - a.K : a.K - b.K;
      if (w <= 0 || w < wMin * S || w > wMax * S) continue;
      const c = build(code, null, [{ o: a, side: side1 }, { o: b, side: -side1 }]);
      if (okPrice(c, w)) out.push({ ...c, width: w });
    }
  }
  return out;
}

// Bir vade için izin verilen stratejilerin tüm adayları.
export function candidates(ex, S, allowed) {
  const C = ex.calls, P = ex.puts, out = [];
  const add = arr => arr.forEach(c => out.push({ ...c, ex }));
  if (allowed.has("LONG_CALL")) add(C.filter(o => o.liquid && inR(o.delta, 0.35, 0.8)).map(o => build("LONG_CALL", ex, [{ o, side: +1 }])));
  if (allowed.has("LONG_PUT")) add(P.filter(o => o.liquid && inR(o.delta, -0.8, -0.35)).map(o => build("LONG_PUT", ex, [{ o, side: +1 }])));
  // Borçlu: ödenen prim genişliğin %20–%70'i (çok ucuz = uzak/olasılıksız, çok pahalı = kötü R:R)
  const debitOK = (c, w) => c.debit > 0.2 * w && c.debit < 0.7 * w;
  if (allowed.has("BULL_CALL")) add(verticals("BULL_CALL", C, S, [0.4, 0.7], [0.15, 0.4], true, +1, 0.02, 0.12, debitOK));
  if (allowed.has("BEAR_PUT")) add(verticals("BEAR_PUT", P, S, [-0.7, -0.4], [-0.4, -0.15], false, +1, 0.02, 0.12, debitOK));
  // Kredili: tek başına spread'de alınan prim genişliğin ≥ %15'i (daha azı kuyruk riskine değmez).
  // Condor kanatları tek tek elenmez (her kanat küçük prim toplar); toplam kredi aşağıda kontrol edilir.
  // Asıl kalite kapısı motorun EV/avantaj filtresidir; bunlar yalnız saçma yapıları ön-eler.
  const creditOK = (c, w) => -c.debit > 0;
  const bullPuts = allowed.has("BULL_PUT") || allowed.has("IRON_CONDOR") ? verticals("BULL_PUT", P, S, [-0.35, -0.1], [-0.3, -0.02], false, -1, 0.02, 0.1, creditOK) : [];
  const bearCalls = allowed.has("BEAR_CALL") || allowed.has("IRON_CONDOR") ? verticals("BEAR_CALL", C, S, [0.1, 0.35], [0.02, 0.3], true, -1, 0.02, 0.1, creditOK) : [];
  const single = c => -c.debit >= 0.15 * c.width;
  if (allowed.has("BULL_PUT")) add(bullPuts.filter(c => single(c) && inR(c.legs[0].delta, -0.35, -0.15)));
  if (allowed.has("BEAR_CALL")) add(bearCalls.filter(c => single(c) && inR(c.legs[0].delta, 0.15, 0.35)));
  if (allowed.has("IRON_CONDOR")) {
    // Kısa bacaklar 0.10–0.25 delta; kanatlar benzer genişlikte. Her taraftan en iyi 6 (kredi/genişlik) birleştirilir.
    const top = arr => arr.filter(c => inR(Math.abs(c.legs[0].delta), 0.1, 0.25)).sort((a, b) => (-b.debit / b.width) - (-a.debit / a.width)).slice(0, 6);
    for (const p of top(bullPuts)) for (const c of top(bearCalls)) {
      if (Math.abs(p.width - c.width) > Math.max(1, 0.25 * Math.max(p.width, c.width))) continue;
      const legs = [...p.legs, ...c.legs].map(l => ({ o: [...ex.puts, ...ex.calls].find(o => o.type === l.type && o.K === l.K), side: l.side }));
      const ic = build("IRON_CONDOR", ex, legs);
      const w = Math.max(p.width, c.width);
      if (-ic.debit >= 0.2 * w) out.push({ ...ic, ex, width: w });   // toplam kredi ≥ genişliğin %20'si
    }
  }
  return out;
}
