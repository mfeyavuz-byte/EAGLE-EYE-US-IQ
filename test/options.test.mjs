import { test } from "node:test";
import assert from "node:assert/strict";
import { normCdf, bs, impliedVol } from "../options/bs.mjs";
import { terminalDist, evaluate, profile, skewK } from "../options/dist.mjs";
import { candidates } from "../options/strategies.mjs";
import { allowedFor, directionOf } from "../options/engine.mjs";
import { hvC2C, ivRankPct } from "../options/vol.mjs";
import { record, histOf } from "../options/ivhist.mjs";
import { weeklyFromDaily } from "../data/yahoo.mjs";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} ≉ ${b} (±${tol})`);

test("normal dağılım CDF", () => {
  near(normCdf(0), 0.5, 1e-12);
  near(normCdf(1.96), 0.9750021048517795, 1e-10);
  near(normCdf(-3), 0.0013498980316301, 1e-12);
});

test("Black-Scholes: ders kitabı değerleri (S=K=100, T=1, r=5%, σ=20%)", () => {
  near(bs("C", 100, 100, 1, 0.05, 0, 0.2).price, 10.4506, 1e-3);
  near(bs("P", 100, 100, 1, 0.05, 0, 0.2).price, 5.5735, 1e-3);
  near(bs("C", 100, 100, 1, 0.05, 0, 0.2).delta, 0.6368, 1e-3);
});

test("put-call paritesi (temettülü)", () => {
  const S = 120, K = 110, T = 0.4, r = 0.045, q = 0.02, s = 0.35;
  const c = bs("C", S, K, T, r, q, s).price, p = bs("P", S, K, T, r, q, s).price;
  near(c - p, S * Math.exp(-q * T) - K * Math.exp(-r * T), 1e-9);
});

test("örtük volatilite geri çözülür; arbitraj dışı fiyat null", () => {
  for (const sig of [0.08, 0.25, 0.6, 1.4]) {
    const px = bs("P", 50, 55, 0.2, 0.04, 0.01, sig).price;
    near(impliedVol("P", px, 50, 55, 0.2, 0.04, 0.01), sig, 1e-4);
  }
  assert.equal(impliedVol("C", 0.5, 100, 90, 0.1, 0.04, 0), null);   // iç değerin altında
});

test("dağılımlar: olasılık toplamı 1, beklenen fiyat e^{μT}", () => {
  for (const model of ["lognormal", "t"]) {
    const d = terminalDist(100, 0.25, 0.3, 0.08, model);
    let sp = 0, es = 0;
    for (let i = 0; i < d.S.length; i++) { sp += d.p[i]; es += d.p[i] * d.S[i]; }
    near(sp, 1, 1e-9, model);
    near(es, 100 * Math.exp(0.08 * 0.25), 0.05, model);
  }
});

test("çarpıklık: sol kuyruk kalınlaşır, ortalama ve medyan korunur", () => {
  const sym = terminalDist(100, 0.1, 0.4, 0, "t", 801, 0), sk = terminalDist(100, 0.1, 0.4, 0, "t", 801, 0.2);
  const pBelow = (d, x) => { let s = 0; for (let i = 0; i < d.S.length; i++) if (d.S[i] < x) s += d.p[i]; return s; };
  const mean = d => { let s = 0; for (let i = 0; i < d.S.length; i++) s += d.p[i] * d.S[i]; return s; };
  assert.ok(pBelow(sk, 75) > pBelow(sym, 75) * 1.3, "sol kuyruk");
  assert.ok(pBelow(sk, 125) > pBelow(sym, 125), "sağ kuyruk incelir");
  near(mean(sk), 100, 0.05, "ortalama");
  assert.equal(skewK(-0.05, 0.3), 0);
  near(skewK(0.1, 0.25, 0.7), 0.14, 1e-9);
});

test("adil fiyattan alınan opsiyonun risk-nötr EV'si ≈ 0", () => {
  const px = bs("C", 100, 105, 0.15, 0, 0, 0.3).price;
  const e = evaluate([{ type: "C", K: 105, side: 1 }], px, terminalDist(100, 0.15, 0.3, 0, "lognormal"));
  near(e.ev, 0, 0.5);
});

test("kalın kuyruk: aynı σ'da t-dağılımı uzak OTM put'u daha değerli bulur", () => {
  const legs = [{ type: "P", K: 70, side: 1 }];
  const ln = evaluate(legs, 0, terminalDist(100, 0.1, 0.3, 0, "lognormal"));
  const t = evaluate(legs, 0, terminalDist(100, 0.1, 0.3, 0, "t"));
  assert.ok(t.ev > ln.ev * 1.5, `t ${t.ev} vs ln ${ln.ev}`);
});

test("profil: bull put spread 100/95 @1.50 kredi", () => {
  const p = profile([{ type: "P", K: 100, side: -1 }, { type: "P", K: 95, side: 1 }], -1.5);
  near(p.maxProfit, 150, 1e-6); near(p.maxLoss, 350, 1e-6);
  assert.deepEqual(p.breakevens, [98.5]);
});

test("profil: iron condor iki başabaş; long call sınırsız kâr", () => {
  const ic = profile([{ type: "P", K: 90, side: 1 }, { type: "P", K: 95, side: -1 }, { type: "C", K: 105, side: -1 }, { type: "C", K: 110, side: 1 }], -2);
  near(ic.maxProfit, 200, 1e-6); near(ic.maxLoss, 300, 1e-6);
  assert.deepEqual(ic.breakevens, [93, 107]);
  assert.equal(profile([{ type: "C", K: 100, side: 1 }], 3).maxProfit, Infinity);
});

// Sentetik zincir: IV %30, S=100, 35 gün
function synthChain(S = 100, T = 35 / 365, iv = 0.3) {
  const mk = type => [];
  const calls = [], puts = [];
  for (let K = 70; K <= 130; K += 2.5) {
    for (const [type, arr] of [["C", calls], ["P", puts]]) {
      const g = bs(type, S, K, T, 0.04, 0, iv);
      const mid = g.price, half = Math.max(0.02, mid * 0.03);
      if (mid < 0.06) continue;
      arr.push({ type, K, strike: K, mid, bid: mid - half, ask: mid + half, iv, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, oi: 1000, vol: 100, spreadPct: 2 * half / mid, liquid: true });
    }
  }
  return { exp: 0, dte: 35, T, calls, puts };
}

test("strateji üretici: kredili spread kuralları ve iron condor", () => {
  const ex = synthChain();
  const c = candidates(ex, 100, new Set(["BULL_PUT", "IRON_CONDOR", "BULL_CALL"]));
  const bp = c.filter(x => x.code === "BULL_PUT"), ic = c.filter(x => x.code === "IRON_CONDOR"), bc = c.filter(x => x.code === "BULL_CALL");
  assert.ok(bp.length && ic.length && bc.length, `bp ${bp.length} ic ${ic.length} bc ${bc.length}`);
  for (const x of ic) assert.ok(-x.debit >= 0.2 * x.width);
  for (const x of bp) { assert.ok(-x.debit >= 0.15 * x.width); assert.ok(x.legs[0].delta <= -0.15 && x.legs[0].delta >= -0.35); assert.ok(x.legs[0].K > x.legs[1].K); }
  for (const x of bc) { assert.ok(x.debit > 0 && x.debit < 0.7 * x.width); assert.ok(isFinite(x.maxLoss)); }
  for (const x of ic) { assert.equal(x.legs.length, 4); assert.equal(x.breakevens.length, 2); }
});

test("yalnız-alım modu (varsayılan): sadece long call / long put, satış bacağı asla", () => {
  for (const reg of ["ucuz", "adil", "zengin"]) {
    assert.deepEqual([...allowedFor(1, reg, 1.5, 1.4)], ["LONG_CALL"]);
    assert.deepEqual([...allowedFor(-1, reg, 1.5, 1.4)], ["LONG_PUT"]);         // put ALIMI serbest (yalnız satış yasak)
    assert.equal(allowedFor(0, reg, 1.5, 1.0).size, 0);                         // yön yok → öneri yok
  }
  // aday üretici bile izin verilmeyen yapı üretmez
  const c = candidates(synthChain(), 100, allowedFor(1, "zengin"));
  assert.ok(c.length > 0 && c.every(x => x.code === "LONG_CALL" && x.legs.every(l => l.side > 0)));
});

test("yön × rejim matrisi (OPT_LONG_ONLY=0)", () => {
  const A = (d, r, iv = null, t = null) => allowedFor(d, r, iv, t, false);
  assert.deepEqual([...A(1, "ucuz")], ["LONG_CALL", "BULL_CALL"]);
  assert.deepEqual([...A(1, "zengin")], ["BULL_PUT", "BULL_CALL"]);
  assert.deepEqual([...A(-1, "zengin")], ["BEAR_CALL", "BEAR_PUT"]);
  assert.deepEqual([...A(0, "zengin")], ["IRON_CONDOR"]);
  assert.equal(A(0, "ucuz").size, 0);
  assert.deepEqual([...A(0, "zengin", 1.5, 1.15)], ["IRON_CONDOR"]);   // hafif ters: izin var (σ ≥ IV)
  assert.equal(A(0, "zengin", 1.5, 1.4).size, 0);                     // belirgin ters: condor yasak
  assert.deepEqual([...A(-1, "zengin", 1.5, 1.4)], ["BEAR_CALL", "BEAR_PUT"]);   // yönlü yapılar sürer
  assert.equal(directionOf({ signal: "AL", confidence: 90 }).dir, 1);
  assert.equal(directionOf({ signal: "AL", confidence: 55 }).dir, 0);   // zayıf sinyal → nötr
  assert.equal(directionOf({ signal: "SAT", confidence: 72, passed: false }).dir, 0);   // filtre dışı → nötr
});

test("HV, IV rank ve IV geçmişi kaydı", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ close: 100 * (i % 2 ? 1.01 : 1) }));
  assert.ok(hvC2C(rows, 20) > 0.1);
  const hist = Array.from({ length: 30 }, (_, i) => 0.2 + i * 0.01);
  assert.equal(ivRankPct(hist, 0.49).rank, 100);
  assert.equal(ivRankPct(hist.slice(0, 5), 0.3).rank, null);           // yetersiz geçmiş
  const st = {};
  record(st, "X", "2026-11-20", 0.31); record(st, "X", "2026-11-20", 0.33); record(st, "X", "2026-11-21", 0.35);
  assert.deepEqual(histOf(st, "X"), [0.33, 0.35]);
});

test("parite spotu: kotasyon kaymış olsa da zincirden doğru dayanak bulunur", async () => {
  const { paritySpot } = await import("../options/chain.mjs");
  const Strue = 102, r = 0.04, q = 0.01, T = 30 / 365, iv = 0.3;
  const leg = (type, K) => { const p = bs(type, Strue, K, T, r, q, iv).price; return { strike: K, bid: p - 0.05, ask: p + 0.05 }; };
  const Ks = [95, 100, 105, 110];
  const raw = [{ T, calls: Ks.map(K => leg("C", K)), puts: Ks.map(K => leg("P", K)) }];
  near(paritySpot(raw, 100, r, q), 102, 1e-6);                     // kotasyon 100 diyor, zincir 102
  assert.equal(paritySpot(raw, 80, r, q), null);                   // %5'ten büyük fark → güvenme
});

test("opsiyon karnesi: kayıt, tekrar engeli, vade sonu sonuçlandırma, istatistik", async () => {
  const { addIdeas, settle, stats } = await import("../options/book.mjs");
  const idea = { code: "BULL_PUT", expDate: "2026-12-18", debit: -1.5, ev: 30, pop: 0.7, popMkt: 0.62, maxLoss: 350,
    legs: [{ type: "P", K: 100, side: -1 }, { type: "P", K: 95, side: 1 }] };
  const book = [];
  addIdeas(book, [{ sym: "X", idea }], "2026-11-20");
  addIdeas(book, [{ sym: "X", idea }], "2026-11-21");
  assert.equal(book.length, 1);
  assert.equal((await settle(book, "2026-12-18", async () => 110)).length, 0);   // vade günü henüz sonuçlanmaz
  const done = await settle(book, "2026-12-19", async () => 97);
  assert.equal(done[0].pnl, -150);                                              // (−3 + 1.5)·100
  const s = stats(book);
  assert.equal(s.n, 1); assert.equal(s.winRate, 0); assert.equal(s.pnl, -150); assert.equal(s.predEv, 30);
});

test("yönetim kuralları: mesaj ve simülasyon aynı kaynaktan", async () => {
  const { rulesFor, manageRules } = await import("../options/engine.mjs");
  const credit = { kind: "credit", code: "BULL_PUT", debit: -1.5, maxProfit: 150, maxLoss: 350 };
  assert.deepEqual(rulesFor(credit), { tp: 75, sl: -300, dte: 21, breakShort: true });
  assert.equal(rulesFor({ ...credit, debit: -2, maxProfit: 200, maxLoss: 300 }).sl, null);   // 2× kredi ≥ maks zarar → stop yok
  assert.deepEqual(rulesFor({ kind: "debit", code: "BEAR_PUT", debit: 4, maxProfit: 600, maxLoss: 400 }), { tp: 450, sl: -200, dte: 10, breakShort: false });
  assert.deepEqual(rulesFor({ kind: "debit", code: "LONG_CALL", debit: 3, maxProfit: Infinity, maxLoss: 300 }), { tp: 300, sl: -150, dte: 21, breakShort: false });
  assert.match(manageRules(credit), /\+\$75/);
});

test("gerçekçi karne: canlı kotasyonla değerleme, kural tetikleme, iki ayrı istatistik", async () => {
  const { addIdeas, markBook, exitValue, checkRules, settle, stats, fmtStats } = await import("../options/book.mjs");
  const legs = [{ type: "P", K: 100, side: -1, sym: "X261218P00100000", bid: 2.9, ask: 3.1 }, { type: "P", K: 95, side: 1, sym: "X261218P00095000", bid: 1.4, ask: 1.6 }];
  const idea = { code: "BULL_PUT", kind: "credit", expDate: "2026-12-18", debit: -1.5, ev: 30, pop: 0.7, popMkt: 0.62, maxLoss: 350, maxProfit: 150,
    legs, rules: { tp: 75, sl: -300, dte: 21, breakShort: true } };
  const book = [];
  addIdeas(book, [{ sym: "X", idea }], "2026-11-02");
  assert.equal(book[0].legs[0].occ, "X261218P00100000");
  const chain = (S, pS, pL) => ({ S, calls: [], puts: [
    { strike: 100, bid: pS - 0.05, ask: pS + 0.05, sym: "X261218P00100000" }, { strike: 95, bid: pL - 0.05, ask: pL + 0.05, sym: "X261218P00095000" }] });
  // kapatma değeri: −(orta + 0.3·spread) + (orta − 0.3·spread)
  near(exitValue(book[0].legs, chain(104, 1.0, 0.4)), -(1.0 + 0.03) + (0.4 - 0.03), 1e-9);
  // Gün 1: kredi 1.50, kapatma maliyeti ~0.66 → K/Z ≈ +84 ≥ hedef 75 → kâr hedefi
  const r1 = await markBook(book, "2026-11-10", async () => chain(104, 1.0, 0.4));
  assert.equal(r1.marked, 1); assert.equal(r1.closed.length, 1);
  assert.equal(book[0].closed.reason, "kâr hedefi"); assert.equal(book[0].closed.days, 8);
  assert.ok(book[0].closed.pnl >= 75);
  const r2 = await markBook(book, "2026-11-11", async () => chain(104, 1.0, 0.4));
  assert.equal(r2.marked, 0);                                                    // kapananlar tekrar değerlenmez
  // kural öncelikleri
  const b = book[0];
  assert.equal(checkRules(b, -320, 104, 30), "zarar durdur");
  assert.equal(checkRules(b, 10, 99, 30), "kısa strike kırıldı");
  assert.equal(checkRules(b, 10, 104, 21), "süre");
  assert.equal(checkRules(b, 10, 104, 30), null);
  // vade sonucu ayrı tutulur (kalibrasyon), gerçekçi sonuç değişmez
  await settle(book, "2026-12-19", async () => 97);
  const s = stats(book);
  assert.equal(s.n, 1); assert.equal(s.pnl, -150);                              // vadeye kadar tutsaydı
  assert.equal(s.real.n, 1); assert.ok(s.real.pnl >= 75);                        // kurallarla
  assert.deepEqual(s.real.reasons, { "kâr hedefi": 1 });
  assert.match(fmtStats(s), /GERÇEKÇİ[\s\S]*KALİBRASYON/);
});

test("karne: kotasyonu olmayan bacak — derin OTM değersiz, aksi halde değerleme atlanır", async () => {
  const { exitValue } = await import("../options/book.mjs");
  const legs = [{ type: "C", K: 120, side: 1, occ: null }];
  assert.equal(exitValue(legs, { S: 100, calls: [{ strike: 120, bid: 0, ask: 0 }], puts: [] }), 0);
  assert.equal(exitValue(legs, { S: 119, calls: [{ strike: 120, bid: 0, ask: 0 }], puts: [] }), null);
  assert.equal(exitValue(legs, { S: 100, calls: [], puts: [] }), null);
});

test("günlükten haftalık mum", () => {
  const day = d => Date.UTC(2026, 10, d, 14, 30);
  const daily = [17, 18, 19, 20, 23, 24].map((d, i) => ({ ts: day(d), open: i, high: 10 + i, low: i, close: i + 0.5, volume: 1 }));
  const w = weeklyFromDaily(daily);
  assert.equal(w.length, 2);
  assert.equal(w[0].close, 3.5); assert.equal(w[0].high, 13); assert.equal(w[0].volume, 4);
});

test("yönetilen işlem simülasyonu: adil fiyatlı ATM'de EV ≈ 0, pozitif kayma EV ve Kelly'yi artırır", async () => {
  const { simulateManaged, kelly } = await import("../options/sim.mjs");
  const S0 = 100, T = 50 / 365, r = 0.04, iv = 0.3, px = bs("C", S0, 100, T, r, 0, iv).price;
  const legs = [{ type: "C", K: 100, side: 1, iv, sp: 0 }];
  const fair = simulateManaged({ S0, T, sigma: iv, mu: r, r, legs, debit: px, rules: null, n: 6000 });
  assert.ok(Math.abs(fair.ev / (px * 100)) < 0.04, `adil EV ${fair.ev}`);
  assert.equal(kelly(fair.pnls, px * 100).f < 0.05, true);
  const rules = { tp: px * 100, sl: -px * 50, dte: 21 };
  const up = simulateManaged({ S0, T, sigma: iv, mu: r + 0.3, r, legs, debit: px, rules, n: 4000 });
  assert.ok(up.ev > 0 && kelly(up.pnls, px * 100).f > 0);
  assert.ok(Math.abs(Object.values(up.reasons).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(up.days < 50 - 21 + 1);                                         // süre kuralı: vadeye 21 gün kala çıkar
});

test("olağandışı opsiyon hacmi", async () => {
  const { unusualOptions } = await import("../options/flow.mjs");
  const o = (K, vol, oi, mid = 2, delta = 0.5) => ({ type: "C", K, vol, oi, mid, delta, spreadPct: 0.05 });
  const ch = { expiries: [{ exp: 1798675200, dte: 40, calls: [o(100, 5000, 800), o(105, 500, 10), o(110, 1200, 5000), o(50, 9000, 0, 60, 0.99)], puts: [] }] };
  const u = unusualOptions(ch);
  assert.deepEqual(u.map(x => x.K), [100]);
});

test("bilanço öncesi çıkış: simülasyon ve karne aynı kuralı uygular", async () => {
  const { simulateManaged } = await import("../options/sim.mjs");
  const { checkRules } = await import("../options/book.mjs");
  const S0 = 100, T = 60 / 365, r = 0.04, iv = 0.3, px = bs("C", S0, 100, T, r, 0, iv).price;
  const o = simulateManaged({ S0, T, sigma: iv, mu: r, r, legs: [{ type: "C", K: 100, side: 1, iv, sp: 0 }], debit: px,
    rules: { tp: 1e9, sl: -1e9, dte: 0, maxDays: 10 }, n: 500 });
  assert.equal(o.reasons["bilanço öncesi"], 1);
  assert.ok(o.days >= 10 && o.days < 12);
  const b = { legs: [], rules: { tp: 500, sl: -250, dte: 21, exitBy: "2026-12-09" } };
  assert.equal(checkRules(b, 10, 100, 40, "2026-12-08"), null);
  assert.equal(checkRules(b, 10, 100, 40, "2026-12-09"), "bilanço öncesi");
});

test("SPY/QQQ kısa vade: sinyal → call önerisi → 5g ortalama üstünde KAPAT", async () => {
  const { etfState } = await import("../spot/etfsignal.mjs");
  const { runEtf, pickContract } = await import("../bot/etf.mjs");
  const up = Array.from({ length: 250 }, (_, i) => 100 + i * 0.2);           // yükselen trend
  const dip = [...up, up.at(-1) * 0.985, up.at(-1) * 0.97];                  // 2 sert düşüş günü
  const s = etfState(dip);
  assert.ok(s.up200 && s.rsi2 < 5 && s.tier === "güçlü");
  const call = (K, delta, mid) => ({ type: "C", K, delta, mid, bid: mid - 0.05, ask: mid + 0.05, spreadPct: 0.1 / mid, liquid: true, sym: `SPY261231C00${K}000` });
  const chain = { expiries: [{ exp: 1798675200, dte: 20, calls: [call(140, 0.6, 5)] }, { exp: 1799280000, dte: 33, calls: [call(140, 0.62, 6), call(145, 0.45, 3)] }] };
  assert.equal(pickContract(chain, 30, 0.6).c.K, 140);                       // vade ≥30 → 33g; delta 0.62
  const st = {};
  let closes = dip;
  const deps = { today: "2026-11-02", closesFor: async () => closes, chainFor: async () => chain };
  const o1 = await runEtf(st, deps);
  assert.ok(o1.some(l => l.includes("ETF FIRSAT")));
  assert.ok(st.etf.pos.SPY && st.etf.pos.QQQ);
  closes = [...dip, dip.at(-1) * 1.04];                                       // ertesi gün 5g ortalamanın üstü
  const o2 = await runEtf(st, { ...deps, today: "2026-11-03" });
  assert.ok(o2.some(l => l.includes("ETF KAPAT")));
  assert.equal(st.etf.book.length, 2);
  assert.equal(Object.keys(st.etf.pos).length, 0);
  assert.equal((await runEtf(st, { ...deps, today: "2026-11-03" })).length, 0);   // aynı gün tekrar yok
});

test("SPY/QQQ düşüş: put ALIMI önerisi → 5g ortalama altında KAPAT; hisse SAT'ında long put serbest", async () => {
  const { etfState } = await import("../spot/etfsignal.mjs");
  const { runEtf } = await import("../bot/etf.mjs");
  const down = Array.from({ length: 250 }, (_, i) => 200 - i * 0.3);         // düşen trend
  const pop = [...down, down.at(-1) * 1.02, down.at(-1) * 1.04];             // 2 sert yükseliş günü
  const s = etfState(pop);
  assert.ok(!s.up200 && s.rsi2 > 90 && s.putTier === "zayıf" && !s.tier);
  const put = (K, delta, mid) => ({ type: "P", K, delta, mid, bid: mid - 0.05, ask: mid + 0.05, spreadPct: 0.1 / mid, liquid: true, sym: `SPY261231P00${K}000` });
  const chain = { expiries: [{ exp: 1799280000, dte: 33, calls: [], puts: [put(130, -0.6, 5), put(120, -0.3, 2)] }] };
  const st = {};
  let closes = pop;
  const o1 = await runEtf(st, { today: "2026-11-02", closesFor: async () => closes, chainFor: async () => chain });
  assert.ok(o1.some(l => l.includes("PUT (zayıf sinyal)") && l.includes("AL 130P")));
  assert.equal(st.etf.pos.SPY.type, "P");
  closes = [...pop, pop.at(-1) * 0.95];                                       // 5g ortalamanın altı
  const o2 = await runEtf(st, { today: "2026-11-03", closesFor: async () => closes, chainFor: async () => chain });
  assert.ok(o2.some(l => l.includes("ETF KAPAT") && l.includes("130P")));
  const { allowedFor } = await import("../options/engine.mjs");
  assert.deepEqual([...allowedFor(-1, "adil")], ["LONG_PUT"]);
});

test("sabah: skor, hedef/stop, NÖTR günü, karne ve çapraz kontrol", async () => {
  const { morningScore, levels, buildMorning, settleMorning } = await import("../bot/morning.mjs");
  const { crossProblem } = await import("../bot/run.mjs");
  const up = Array.from({ length: 250 }, (_, i) => 100 + i * 0.2);
  const calm = [15, 15.2];
  assert.equal(morningScore(up, calm).score, 0);                                     // sakin, aşırı satım yok → NÖTR
  const dip = [...up, up.at(-1) * 0.985, up.at(-1) * 0.97];
  const s = morningScore(dip, [20, 34]);                                             // VIX > 30, +%70, RSI2 düşük, trend yukarı
  assert.equal(s.score, 3);
  const lv = levels(100, 16 * Math.sqrt(252) / 100 * 100, "SPY");                     // VIX ≈ 254 → em = %16 (yapay)
  assert.ok(lv.target > 100 && lv.stop < 100 && Math.abs((lv.target - 100) - (100 - lv.stop)) < 1e-6);
  const deps = { today: "2026-11-23", vixCloses: async () => [15, 15.2], closesFor: async () => up,
    futQuote: async () => ({ price: 101, prevClose: 100 }), contractFor: async () => null, headlines: async () => [] };
  const n = await buildMorning(deps);
  assert.match(n.text, /NÖTR — işlem önerilmez/); assert.equal(n.calls.length, 0);
  const c = await buildMorning({ ...deps, vixCloses: async () => [20, 34], closesFor: async () => dip });
  assert.equal(c.calls.length, 2); assert.match(c.text, /CALL \(gün içi\) · skor 3\/3/); assert.match(c.text, /PUT notu/);
  const book = c.calls.map(x => ({ ...x }));
  await settleMorning(book, "2026-11-24", async () => [{ d: "2026-11-23", open: book[0].estOpen, high: book[0].target + 1, low: book[0].estOpen - 0.1, close: book[0].estOpen * 1.01 }]);
  assert.equal(book[0].res.tHit, true); assert.ok(book[0].res.oc > 0);
  const now = Date.parse("2026-11-23T16:00:00Z");
  assert.equal(crossProblem({ price: 600, ts: now - 60e3 }, { price: 600.5 }, now).problem, null);
  assert.match(crossProblem({ price: 600, ts: now - 20 * 60e3 }, { price: 600 }, now).problem, /bayat/);
  assert.match(crossProblem({ price: 600, ts: now }, { price: 610 }, now).problem, /farklı/);
  assert.match(crossProblem(null, { price: 600 }, now).problem, /gelmedi/);
});
