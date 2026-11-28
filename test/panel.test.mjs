import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sanitize, panelRecord, readFeed, seedFeed, buildSnapshot } from "../bot/panel.mjs";

test("panel: kontrat sayısı / hesap yüzdesi satırları silinir, fikir kalır", () => {
  const t = ["🎯 SPY CALL AL — 0DTE 600C ~$1.20", "   Giriş SPY ~599.10 · Hedef 601.00 · Stop 598.20 · süre 60 dk",
    "   Boyut: 5 kontrat (stopta ~$250 kayıp = hesabın %1) · aynı küme: QQQ açık ×0.5", "   Adet ×0.5 — aynı küme: QQQ açık"].join("\n");
  const s = sanitize(t);
  assert.match(s, /SPY CALL AL/); assert.match(s, /Hedef 601/);
  assert.doesNotMatch(s, /kontrat \(|hesabın|Adet/);
  assert.equal(sanitize("NVDA · 200C ~$3.10 · 4 kontrat (stopta ~$400 kayıp = hesabın %1.6)"), "NVDA · 200C ~$3.10");
  assert.equal(sanitize("AMD · 1 kontrat bile riskinden büyük (stopta ~$500 kayıp > $250) → atla"), "AMD");
});

test("panel: kayıt → okuma → yeni makinede doldurma; eski kayıt atılır", () => {
  const f = join(tmpdir(), `panel_test_${process.pid}.jsonl`), now = Date.now();
  seedFeed([], f);
  panelRecord("plan", "⏱ plan", now - 60e3, f);
  panelRecord("fikir", "🎯 fikir\n   Boyut: 2 kontrat (x)", now, f);
  panelRecord("", "etiketsiz", now, f);
  panelRecord("eski", "eski", now - 40 * 3600e3, f);
  const r = readFeed(f, now);
  assert.deepEqual(r.map(x => x.cat), ["plan", "fikir"]);
  assert.equal(r[1].text, "🎯 fikir");
  seedFeed(r, f); assert.equal(readFeed(f, now).length, 2);
});

test("panel: özet yalnız piyasa verisi taşır", () => {
  const s = buildSnapshot({ feed: [], internals: { dt: "trend↑", mb: 0.7, ts: 1 }, lead: { ts: 1, spy: -0.01, rel: { XLK: 0.02 }, ret: { XLK: 0.01 } },
    karne: "📒 karne", paused: [{ key: "setup|RECLAIM|C", s10: -3, daysLeft: 20 }],
    open: [{ ts: 1, sym: "SPY", dir: "C", src: "fast", S: 600, target: 602, stop: 599, K: 600, exp: "2026-12-04", prem: 1.2, paper: { id: "x", qty: 3 }, occ: "SPY..." }] });
  assert.equal(s.open[0].contract, "04.12 600C ~$1.2");
  assert.equal(s.open[0].paper, undefined); assert.equal(s.open[0].occ, undefined);
  assert.doesNotMatch(JSON.stringify(s), /acct|mypos|risk/);
});

import { recentIdeas } from "../bot/panel.mjs";
import { earnInfo } from "../bot/run.mjs";

test("bilanço filtresi: vadeden önce uyarı, 5 gün içinde atla, geçmiş bilanço yok sayılır", () => {
  const ts = d => Date.parse(d + "T21:00:00Z") / 1e3;
  assert.deepEqual(earnInfo(ts("2026-12-03"), "2026-12-18", "2026-12-01"), { d: "2026-12-03", soon: true, before: true });
  assert.deepEqual(earnInfo(ts("2027-01-20"), "2026-12-18", "2026-12-01"), { d: "2027-01-20", soon: false, before: false });
  assert.equal(earnInfo(ts("2026-11-20"), "2026-12-18", "2026-12-01"), null);
  assert.equal(earnInfo(null, "2026-12-18", "2026-12-01"), null);
});

test("panel: son fikirler tablosu gün içi + formasyon birleşik, yeniden eskiye", () => {
  const now = Date.parse("2026-12-01T20:00:00Z");
  const r = recentIdeas([{ ts: now - 3600e3, src: "setup", setup: "RECLAIM", sym: "SPY", dir: "C", res: "HEDEF", r: 2 }, { ts: now - 5 * 864e5, src: "fast", sym: "OLD", dir: "C" }],
    [{ src: "ta", name: "EW2", sym: "AAPL", dir: "C", d: "2026-11-30", ts: now - 864e5 }], now);
  assert.deepEqual(r.map(x => x.sym), ["SPY", "AAPL"]);
  assert.equal(r[0].src, "kurulum RECLAIM"); assert.equal(r[1].src, "formasyon EW2"); assert.equal(r[1].res, null);
});
