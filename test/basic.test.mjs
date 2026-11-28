import { test } from "node:test";
import assert from "node:assert/strict";
import { isRegularHours, sessionFraction, nyDate } from "../data/market.mjs";
import { passes } from "../spot/scan.mjs";
import { fmtSignal, diversify, pickFresh } from "../bot/run.mjs";

test("opsiyon fikirlerinde yoğunlaşma koruması", () => {
  const mk = (sym, code, dir) => ({ sym, idea: { code, dir } });
  const list = ["A", "B", "C", "D", "E", "F", "G"].map(s => mk(s, "BEAR_PUT", -1)).concat([mk("Z", "IRON_CONDOR", 0)]);
  const out = diversify(list, 6).map(x => x.idea.code);
  assert.equal(out.filter(c => c === "BEAR_PUT").length, 3);          // en çok 3 aynı strateji
  assert.ok(out.includes("IRON_CONDOR"));                              // farklı yapı listede
  assert.equal(out.length, 4);                                         // kopya bahisler gönderilmez
});

test("seans saatleri: yaz saati (EDT)", () => {
  assert.equal(isRegularHours(new Date("2026-07-15T13:29:00Z")), false); // 09:29 NY
  assert.equal(isRegularHours(new Date("2026-07-15T13:30:00Z")), true);  // 09:30 NY
  assert.equal(isRegularHours(new Date("2026-07-15T20:00:00Z")), false); // 16:00 NY
});

test("seans saatleri: kış saati (EST) ve hafta sonu", () => {
  assert.equal(isRegularHours(new Date("2026-01-14T14:00:00Z")), false); // 09:00 NY
  assert.equal(isRegularHours(new Date("2026-01-14T14:45:00Z")), true);  // 09:45 NY
  assert.equal(isRegularHours(new Date("2026-01-17T16:00:00Z")), false); // Cumartesi
});

test("seans kesri ve NY tarihi", () => {
  assert.equal(sessionFraction(new Date("2026-07-15T16:45:00Z")), 0.5);  // 12:45 NY = yarı
  assert.equal(sessionFraction(new Date("2026-07-15T22:00:00Z")), 1);
  assert.equal(nyDate(new Date("2026-07-16T02:00:00Z")), "2026-07-15");  // UTC ertesi gün, NY hâlâ 15'i
});

const base = { sym: "X", signal: "AL", confidence: 80, adx: 30, htf: "YUKARI", htfNote: "", dip: 0, dollarVol: 1e9, volPace: 1, rsi: 55, rs60: 2,
  mom12: 0.6, momRank: 0.9, hi52: 0.9, a200: 0.08 };
test("AL kuralı: momentum lideri geri çekilmede", () => {
  assert.equal(passes(base), true);
  assert.equal(passes({ ...base, signal: "NÖTR" }), true);                  // motor nötr olsa da seçilir
  assert.equal(passes({ ...base, confidence: 40 }), true);                  // motor güveni şart değil
  assert.equal(passes({ ...base, momRank: 0.7 }), false);                   // momentum en iyi %20'de değil
  assert.equal(passes({ ...base, hi52: 0.97 }), false);                     // zirvede (geri çekilme yok)
  assert.equal(passes({ ...base, a200: -0.02 }), false);                    // 200g ortalamanın altında
  assert.equal(passes({ ...base, signal: "SAT", htf: "YUKARI" }), false);   // motor SAT → AL olmaz
  assert.equal(passes({ ...base, dollarVol: 30e6 }), false);                // 50M$ altı
  assert.equal(passes({ ...base, momRank: undefined }), false);             // sıra bilinmeden seçim yok
});

test("SAT kuralı: teyitli düşüş + zayıf momentum", () => {
  const sat = { ...base, signal: "SAT", confidence: 85, adx: 30, htf: "ASAGI", rsi: 38, rs60: -12, momRank: 0.2 };
  assert.equal(passes(sat), true);
  assert.equal(passes({ ...sat, momRank: 0.5 }), false);                    // momentum zayıf değil
  assert.equal(passes({ ...sat, htf: "YAN" }), false);                      // haftalık trend aşağı değil
  assert.equal(passes({ ...sat, confidence: 75 }), false);
  assert.equal(passes({ ...sat, adx: 22 }), false);
  assert.equal(passes({ ...sat, rs60: 4 }), false);                         // SPY'dan güçlü hisseye SAT yok
  assert.equal(passes({ ...sat, rsi: 24 }), false);                         // zaten aşırı satılmış → geç
});

test("kesitsel momentum sırası ve eşikler", async () => {
  const { rankAndClassify, setMomCuts } = await import("../spot/scan.mjs");
  const list = Array.from({ length: 50 }, (_, i) => ({ ...base, sym: "S" + i, signal: "NÖTR", mom12: i / 100, hi52: 0.9, a200: 0.05, atr: 2, price: 100 }));
  const cuts = rankAndClassify(list);
  assert.equal(list.filter(a => a.pick === "AL").length, 10);               // en iyi %20 → 10 hisse
  assert.ok(list.find(a => a.sym === "S49").pick === "AL" && !list.find(a => a.sym === "S10").pick);
  assert.equal(list.find(a => a.sym === "S49").stopLoss, 95);               // ATR seviyeleri: 100 − 2.5·2
  assert.ok(Math.abs(cuts.top - 0.39) < 0.011);
  setMomCuts(null);
});

test("günlük kota: en kaliteli N yeni sinyal, tekrar yok", () => {
  const mk = (sym, signal) => ({ sym, signal });
  const sigs = ["A", "B", "C", "D"].map(s => mk(s, "AL")).concat(["X", "Y"].map(s => mk(s, "SAT")));
  const sent = { date: "d", map: {} };
  assert.deepEqual(pickFresh(sigs, sent, { AL: 2, SAT: 1 }).map(s => s.sym), ["A", "B", "X"]);
  assert.deepEqual(pickFresh(sigs, sent, { AL: 2, SAT: 1 }).map(s => s.sym), []);   // kota doldu, tekrar yok
  assert.deepEqual(pickFresh(sigs, sent, { AL: 3, SAT: 1 }).map(s => s.sym), ["C"]);
});

test("SAT sinyalinde stop fiyatın üstünde, hedef altında", async () => {
  const { orientLevels } = await import("../spot/scan.mjs");
  const lv = orientLevels(100, "SAT", { stopLoss: 95, target1: 110, target2: 120 });
  assert.deepEqual(lv, { stopLoss: 105, target1: 90, target2: 80 });
  assert.deepEqual(orientLevels(100, "AL", { stopLoss: 95, target1: 110 }), { stopLoss: 95, target1: 110, target2: undefined });
});

test("sinyal satırı biçimi", () => {
  const s = fmtSignal({ ...base, price: 123.4, stopLoss: 118, target1: 131, rr: 1.4 });
  assert.equal(s, "🟢 X AL $123.4 · hedef $131 · stop $118");                  // sade: varlık · giriş · hedef · stop
  assert.equal(fmtSignal({ ...base, signal: "SAT", price: 50 }), "🔴 X SAT $50");
});

test("Telegram parçalama: hiçbir satır kaybolmaz, her parça ≤ 4096", async () => {
  const { chunks } = await import("../bot/telegram.mjs");
  const lines = Array.from({ length: 300 }, (_, i) => `🟢 SYM${i} $123.45 · güven %90 · ADX 33 · RSI 55 · RS60 +12.3 · stop $118 · hedef $131 · R:R 2.5`);
  const text = ["BAŞLIK", "", ...lines, "", "son satır"].join("\n");
  const parts = chunks(text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => p.length > 0 && p.length <= 4096));
  assert.equal(parts.join("\n"), text);                                       // birebir aynı metin
  const long = "x".repeat(9000);                                              // sınırı aşan tek satır
  const lp = chunks("a\n" + long + "\nb");
  assert.ok(lp.every(p => p.length > 0 && p.length <= 4096));
  assert.equal(lp.join("").replace(/\n/g, ""), "a" + long + "b");
});

test("/sinyaller: filtreyi geçen tüm sinyaller listelenir (kesme yok)", async () => {
  const { fmtSignalList, compactSignal } = await import("../bot/run.mjs");
  const { chunks } = await import("../bot/telegram.mjs");
  const sigs = Array.from({ length: 82 }, (_, i) => compactSignal({ ...base, sym: `S${i}`, signal: i < 53 ? "AL" : "SAT", price: 100 + i, stopLoss: 95, target1: 110, rr: 2.5 }));
  const txt = fmtSignalList({ at: "x", analyzed: 1328, signals: sigs });
  assert.match(txt, /AL \(53\)/); assert.match(txt, /SAT \(29\)/);
  const all = chunks(txt).join("\n");
  for (const s of sigs) assert.ok(all.includes(`${s.sym} ${s.signal} $`), s.sym);
});

test("spot çıkış: stop / hedef / 21 işlem günü; SAT 21 gün sonra ölçülür", async () => {
  const { logSignals, checkExits, tradingDays, score } = await import("../bot/spotbook.mjs");
  assert.equal(tradingDays("2026-11-20", "2026-11-23"), 1);                 // Cuma → Pazartesi
  const book = [];
  logSignals(book, [
    { sym: "A", signal: "AL", price: 100, stopLoss: 95, target1: 110 },
    { sym: "B", signal: "AL", price: 50, stopLoss: 45, target1: 60 },
    { sym: "C", signal: "AL", price: 20, stopLoss: 18, target1: 24 },
    { sym: "D", signal: "SAT", price: 30 },
  ], "2026-11-02", 600);
  logSignals(book, [{ sym: "A", signal: "AL", price: 101 }], "2026-11-03", 600);   // açık aynı sinyal tekrar açılmaz
  assert.equal(book.length, 4);
  const px = { A: 94, B: 61, C: 21, D: 27 };
  const d1 = checkExits(book, "2026-11-10", s => px[s], 606);
  assert.deepEqual(d1.map(b => [b.sym, b.closed.why]), [["A", "stop"], ["B", "hedef"]]);
  assert.ok(Math.abs(book[0].closed.ex - (-0.06 - 0.01)) < 1e-9);         // SPY'a göre
  const d2 = checkExits(book, "2026-12-01", s => px[s], 606);               // 21 işlem günü
  assert.deepEqual(d2.map(b => [b.sym, b.closed.why]), [["C", "süre"], ["D", "süre"]]);
  assert.equal(book[3].closed.ret, 0.1);                                    // SAT: 30 → 27 = sinyal yönünde +%10
  assert.equal(score(book, () => null, 606).length, 4);                     // kapananlar fiyatsız da sayılır
});

test("sektör sınırı ve pozisyon boyutu", async () => {
  const { pickFresh, sizeFor } = await import("../bot/run.mjs");
  const sigs = ["A", "B", "C", "D", "E"].map(s => ({ sym: s, signal: "AL", price: 100, stopLoss: 95 }));
  const sent = { date: "d", map: {} };
  const out = pickFresh(sigs, sent, { AL: 10, SAT: 6 }, s => (s === "E" ? "Tech" : "Bio"));
  assert.deepEqual(out.map(s => s.sym), ["A", "B", "C", "E"]);              // Bio en çok 3
  assert.equal(sizeFor({ signal: "AL", price: 100, stopLoss: 95 }), 0.1);    // %1 / %5 = %20 → üst sınır %10
  assert.equal(sizeFor({ signal: "AL", price: 100, stopLoss: 80 }), 0.05);   // %1 / %20 = %5
});

test("takip listesi uyarıları ve model portföy boyutu", async () => {
  const { addWatch, checkWatch, removeWatch } = await import("../bot/watch.mjs");
  const { qtyFor } = await import("../bot/paper.mjs");
  const st = {};
  assert.equal(addWatch(st, "X", 100, "2026-11-02"), true);
  assert.equal(addWatch(st, "X", 100, "2026-11-02"), false);
  const m = (price, a200, pick = null) => new Map([["X", { sym: "X", price, a200, pick }]]);
  assert.deepEqual(checkWatch(st, m(110, 0.05), "2026-11-03"), []);
  const a = checkWatch(st, m(100, -0.01, "SAT"), "2026-11-04");
  assert.equal(a.length, 3);                                                // SAT + 200g kırılımı + zirveden −%9
  assert.deepEqual(checkWatch(st, m(99, -0.02, "SAT"), "2026-11-04"), []);   // aynı gün tekrar yok
  assert.equal(removeWatch(st, "X"), true);
  assert.equal(qtyFor(100000, 50, 45, 0.01, 0.1), 200);                      // risk $1000 / $5 = 200, değer $10k ≤ %10
  assert.equal(qtyFor(100000, 50, 49, 0.01, 0.1), 200);                      // %10 üst sınırı: $10k / $50
  assert.equal(qtyFor(100000, 50, 55, 0.01, 0.1), 0);                        // stop fiyatın üstünde → alım yok
});

test("AL: hacimli sert düşüş sonrası momentum liderine girilmez", () => {
  assert.equal(passes({ ...base, shock: -0.07 }), false);
  assert.equal(passes({ ...base, shock: -0.03 }), true);
  assert.equal(passes({ ...base, shock: 0.12 }), true);
});

test("durum dosyası boyut koruması: yalnız kapanmış kayıtlar budanır", async () => {
  const { trimState } = await import("../bot/state.mjs");
  const pad = "x".repeat(200);
  const st = { spotBook: [...Array.from({ length: 50 }, (_, i) => ({ sym: "C" + i, pad, closed: { d: "x" } })), ...Array.from({ length: 10 }, (_, i) => ({ sym: "O" + i, pad }))] };
  const removed = trimState(st, 5000);
  assert.ok(removed > 0 && JSON.stringify(st).length <= 5000 || st.spotBook.every(b => !b.closed));
  assert.equal(st.spotBook.filter(b => !b.closed).length, 10);              // açık kayıtlar korunur
});

test("canlı kalibrasyon: önselden canlıya doğru kayar, sınırlıdır, motoru günceller", async () => {
  const { calibrate, PRIOR, K } = await import("../bot/calib.mjs");
  const { OCFG, setEdges } = await import("../options/engine.mjs");
  const mk = (n, ex, sig = "AL") => Array.from({ length: n }, () => ({ sig, closed: { ex, td: 21 } }));
  assert.equal(calibrate(mk(5, 0.05), "d").AL.postM, PRIOR.AL);               // veri az → önsel
  const c = calibrate(mk(30, -0.02), "d");
  assert.ok(Math.abs(c.AL.postM - (30 * -0.02 + K * PRIOR.AL) / (30 + K)) < 1e-12);
  assert.equal(c.AL.warn, true);                                              // 30+ işlemde avantaj yok → uyarı
  assert.equal(calibrate(mk(500, 0.5), "d").AL.annual, 0.15);                 // üst sınır
  const before = OCFG.EDGE_AL;
  setEdges(c);
  assert.ok(Math.abs(OCFG.EDGE_AL - c.AL.annual) < 1e-12);
  OCFG.EDGE_AL = before;
});

test("yapay zekâ yorumu: anahtar yoksa kapalı, yanıt ayrıştırılır, hata/ret sinyali bozmaz", async () => {
  const ai = await import("../bot/ai.mjs");
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.deepEqual(await ai.aiComments([{ sym: "X" }]), {});                // anahtarsız → istek yok
  process.env.ANTHROPIC_API_KEY = "test";
  let req = null;
  ai._setClient({ beta: { messages: { create: async r => { req = r; return { stop_reason: "end_turn", content: [{ type: "text", text: "X: Momentum güçlü.\nY: Risk yüksek.\nZZZ: uydurma" }] }; } } } });
  const out = await ai.aiComments([{ sym: "X" }, { sym: "Y" }]);
  assert.deepEqual(out, { X: "Momentum güçlü.", Y: "Risk yüksek." });       // listede olmayan sembol atılır
  assert.equal(req.fallbacks, "default");
  assert.ok(req.betas.includes("server-side-fallback-2026-07-01"));
  ai._setClient({ beta: { messages: { create: async () => ({ stop_reason: "refusal", stop_details: { category: "x" }, content: [] }) } } });
  assert.deepEqual(await ai.aiComments([{ sym: "X" }]), {});
  ai._setClient({ beta: { messages: { create: async () => { throw new Error("ağ"); } } } });
  assert.deepEqual(await ai.aiComments([{ sym: "X" }]), {});
  ai._setClient(null);
  if (saved == null) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
});

test("Telegram butonları: 64 bayt sınırı ve boş satırlar", async () => {
  const { keyboard } = await import("../bot/telegram.mjs");
  const kb = keyboard([[{ text: "A", data: "/hisse A" }, { text: "B", data: "/x " + "y".repeat(70) }], []]);
  assert.deepEqual(kb, { inline_keyboard: [[{ text: "A", callback_data: "/hisse A" }]] });
  assert.equal(keyboard(null), null);
});

test("veri sağlığı: canlı fiyat sayısı ve tazelik", async () => {
  const { dataHealth } = await import("../bot/run.mjs");
  const now = Date.parse("2026-11-23T16:00:00Z");
  const fresh = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`S${i}`, { price: 1, ts: now - 2 * 60e3 }]));
  const h = dataHealth(fresh, 10, true, now);
  assert.equal(h.live, 10); assert.equal(h.medAgeMin, 2);
  // Alpaca anahtarı yoksa (testte yok) sorun bildirilmez, kaynak Yahoo olarak görünür
  assert.equal(h.problem, null); assert.match(h.src, /Yahoo/);
});

test("model portföy: slot sınırı, çıkışlar, dönem getirisi, rapor zamanı", async () => {
  const M = await import("../bot/model.mjs");
  const m = M.initModel("2026-11-02", 600);
  assert.equal(m.lastMonthly, "2026-11"); assert.equal(m.lastQuarterly, "2026-Q4");
  const als = Array.from({ length: 20 }, (_, i) => ({ sym: "S" + i, price: 100, stopLoss: 90, target1: 120 }));
  let px = s => 100;
  const r1 = M.stepModel(m, "2026-11-02", als, px, 600);
  assert.equal(r1.bought.length, M.MCFG.SLOTS);                                   // 15 slot
  assert.ok(m.cash >= 0 && m.cash < M.MCFG.CAPITAL * 0.01);                     // maliyet kadar küçük artık nakit
  px = s => (s === "S0" ? 89 : s === "S1" ? 121 : 100);
  const r2 = M.stepModel(m, "2026-11-03", [], px, 606);
  assert.deepEqual(r2.sold.map(x => [x.sym, x.why]).sort(), [["S0", "stop"], ["S1", "hedef"]]);
  const r3 = M.stepModel(m, "2026-12-02", [], s => 100, 612);                    // 21+ işlem günü → süre
  assert.equal(Object.keys(m.pos).length, 0);
  assert.ok(r3.sold.every(x => x.why === "süre"));
  const s = M.periodStats(m, "2026-11-02");
  assert.ok(Math.abs(s.spyRet - 0.02) < 1e-9);
  assert.equal(s.n, 15);
  assert.deepEqual(M.dueReports(m, "2026-12-01").out, ["monthly"]);
  assert.deepEqual(M.dueReports({ lastMonthly: "2026-12", lastQuarterly: "2026-Q4" }, "2027-01-04").out, ["monthly", "quarterly"]);
  assert.equal(M.prevMonthEnd("2027-01-04"), "2026-12-31");
  assert.equal(M.prevQuarterEnd("2027-01-04"), "2026-12-31");
  assert.equal(M.prevQuarterEnd("2026-11-15"), "2026-09-30");
  assert.match(M.fmtModel(m, "T", "2026-11-02"), /Getiri .* SPY \+2\.00%/);
});

test("opsiyon model portföyleri: kuyruk, giriş, −%50 stop, vade çıkışı, rapor", async () => {
  const O = await import("../bot/optmodel.mjs");
  const om = O.initOptModel("2026-11-23");
  O.queue(om, "2026-11-23", "W", "SPY", "C", "sabah"); O.queue(om, "2026-11-23", "W", "SPY", "C", "sabah");   // tekrar yok
  O.queue(om, "2026-11-22", "M", "QQQ", "C", "eski");                                                          // bayat
  assert.equal(om.pending.length, 2);
  const now = Date.parse("2026-11-23T15:00:00Z"), expTs = Math.floor(Date.parse("2026-11-30T00:00:00Z") / 1e3);
  const chain = { expiries: [{ exp: expTs, dte: 7, calls: [{ K: 690, delta: 0.52, mid: 5, bid: 4.9, ask: 5.1, liquid: true, sym: "SPY261130C00690000" }], puts: [] }] };
  const b = await O.enterPending(om, "2026-11-23", async () => chain);
  assert.equal(b.length, 1); assert.equal(om.pending.length, 0);
  const p = om.sleeves.W.pos[0];
  assert.equal(p.n, Math.floor(2500 / (5.03 * 100)));                                                           // %10 bütçe ($25k kol)
  // pahalı kontrat: %10 bütçeyi aşan ama kolun %20'sini aşmayan tek kontrat alınır
  const om2 = O.initOptModel("2026-11-23"); O.queue(om2, "2026-11-23", "M", "SPY", "C", "x");
  const pricey = { expiries: [{ exp: expTs, dte: 40, calls: [{ K: 690, delta: 0.6, mid: 40, bid: 39.9, ask: 40.1, liquid: true, sym: "Y" }], puts: [] }] };
  assert.equal((await O.enterPending(om2, "2026-11-23", async () => pricey))[0].n, 1);
  // değer yarıya düştü → zarar durdur
  const s1 = await O.markAndExit(om, "2026-11-24", async () => ({ mid: 2.4, bid: 2.35, ask: 2.45 }), now + 864e5);
  assert.equal(s1.length, 1); assert.match(s1[0].why, /zarar durdur/);
  assert.equal(om.sleeves.W.pos.length, 0);
  assert.match(O.fmtOptModel(om, "2026-11-20"), /Haftalık .* kapanan 1/);
  // vade çıkışı: haftalık kolda vadeye 1 gün kala
  O.queue(om, "2026-11-25", "W", "SPY", "C", "sabah");
  await O.enterPending(om, "2026-11-25", async () => chain);
  const s2 = await O.markAndExit(om, "2026-11-29", async () => ({ mid: 5.2, bid: 5.1, ask: 5.3 }), Date.parse("2026-11-29T15:00:00Z"));
  assert.equal(s2.length, 1); assert.match(s2[0].why, /vade yaklaştı/);
});

test("değer (ucuz hisse) portföyü: kalite kapıları, veri hatası, sektör sınırı, dengeleme", async () => {
  const V = await import("../bot/value.mjs");
  const M = await import("../bot/model.mjs");
  const good = { margin: 0.15, roe: 0.2, de: 50, fcf: 1e9, evEbitda: 8 };
  const row = (sym, pe, sec, extra = {}) => ({ sym, sec, price: 50, pe, fpe: pe * 0.9, pb: 2, eps: 3, mcap: 2e10, q: { ...good }, hi52: 0.8, pick: null, ...extra });
  const rows = [row("A", 8, "Enerji"), row("B", 9, "Enerji"), row("C", 10, "Enerji"), row("D", 12, "Sağlık"), row("E", 30, "Teknoloji"),
    row("LOSS", 5, "Sanayi", { eps: -1 }), row("DEBT", 5, "Sanayi", { q: { ...good, de: 400 } }), row("KNIFE", 5, "Sanayi", { hi52: 0.4 }),
    row("SAT", 5, "Sanayi", { pick: "SAT" }), row("BADPB", 11, "Finans", { pb: 0.001 })];
  const ranked = V.rankValue(rows);
  assert.ok(!ranked.some(r => ["LOSS", "DEBT", "KNIFE", "SAT"].includes(r.sym)));          // kalite kapıları
  assert.equal(ranked[0].sym, "A");                                                        // en ucuz
  assert.ok(!ranked.find(r => r.sym === "BADPB").pct.by);                                  // PD/DD 0.001 yok sayılır
  const picks = V.pickValue(ranked, 10, 2);
  assert.equal(picks.filter(p => p.sec === "Enerji").length, 2);                           // sektör başına 2
  const v = V.initValue("2026-11-23", 600);
  const r1 = V.rebalanceValue(v, "2026-11-23", picks.map(p => ({ ...p, price: 50 })), () => 50);
  assert.equal(r1.bought.length, picks.length);
  V.snapValue(v, "2026-11-23", () => 50, 600);
  const r2 = V.rebalanceValue(v, "2026-12-01", picks.slice(1).map(p => ({ ...p, price: 55 })), () => 55);
  assert.deepEqual(r2.sold.map(s => s.sym), [picks[0].sym]);                               // listeden düşen satılır
  V.snapValue(v, "2026-12-01", () => 55, 612);
  const st = M.periodStats(v, "2026-11-23");
  assert.ok(st.ret > 0.09 && Math.abs(st.spyRet - 0.02) < 1e-9);
  assert.match(V.fmtValue(v, st, "T"), /getiri \+/);
});

test("değer: ABD — ileri F/K ana ölçü, sektör içi kıyas, değer tuzağı kapısı", async () => {
  const V = await import("../bot/value.mjs");
  const good = { margin: 0.15, roe: 0.2, de: 50, fcf: 1e9, evEbitda: 10 };
  const row = (sym, sec, fpe, pe = fpe * 1.05, extra = {}) => ({ sym, sec, price: 50, pe, fpe, pb: 3, eps: 3, mcap: 2e10, q: { ...good }, hi52: 0.8, pick: null, ...extra });
  // Teknoloji ileri F/K 20–32, enerji 8–14: sektör içi kıyasla her iki sektörün en ucuzu en üstte olmalı
  const tech = [20, 22, 24, 26, 28, 30, 32].map((f, i) => row("T" + i, i % 2 ? "Technology" : "Information Technology", f));
  const en = [8, 9, 10, 11, 12, 13, 14].map((f, i) => row("E" + i, "Energy", f));
  const r = V.rankValue([...tech, ...en,
    row("TRAP", "Energy", 7, 4),                     // ileri F/K 7 ama izleyen 4 → kazanç düşüşü bekleniyor → elenir
    row("NOFWD", "Energy", -5, 6),                   // ileri kazanç negatif → elenir
    row("PRICY", "Technology", 45, 50),              // ileri F/K > 40 → elenir
    row("SPLIT", "Energy", 5, 25)]);                 // ileri F/K izleyenin 1/5'i → veri hatası (bölünme) → elenir
  const top2 = r.slice(0, 2).map(x => x.sym).sort();
  assert.deepEqual(top2, ["E0", "T0"]);
  assert.ok(!r.some(x => ["TRAP", "NOFWD", "PRICY", "SPLIT"].includes(x.sym)));
  assert.equal(r.find(x => x.sym === "T0").grp, "TECH");                     // iki teknoloji adı tek grup
  const picks = V.pickValue(r, 10, 2);
  assert.equal(picks.filter(p => V.secKey(p.sec) === "TECH").length, 2);    // sektör sınırı birleşik ada uygulanır
});
