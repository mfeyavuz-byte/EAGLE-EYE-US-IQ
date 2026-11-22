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
