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
  assert.match(s, /🟢 X \$123\.4 · mom12 \+60% · zirveye −10%/);
  assert.match(fmtSignal({ ...base, signal: "SAT", price: 50 }), /🔴 X \$50 · güven %80 · ADX 30/);
  assert.match(s, /R:R 1\.4/);
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
  for (const s of sigs) assert.ok(all.includes(`${s.sym} $`), s.sym);
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
