// ÇIKIŞ MESAJLARI — 15 dk fikirleri ve ani hareket alarmları ~30 sn'de bir canlı izlenir (ani hareket süreci içinde):
// fikirden beri 1 dk mumların en yüksek/en düşüğü + canlı fiyat → STOP (aynı anda ikisi = STOP, ihtiyatlı) · HEDEF ·
// ZAMAN STOPU (fikirdeki süre) · KAPANIŞ (seans bitimine ≤ 5 dk). Her fikir için TEK çıkış mesajı; varsa sanal (paper)
// opsiyon pozisyonu da kapatılır. Açık fikirler aynı makinedeki yerel dosyadan (15 dk süreci yazar) ve ani hareket
// defterinden okunur; gönderilen çıkışlar ani hareket defterinde (Gist) tutulur → zincir yenilense de tekrar gönderilmez.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bs } from "../options/bs.mjs";
import { nyParts } from "../data/market.mjs";

export const OPEN_FILE = join(process.env.RUNNER_TEMP || tmpdir(), "eagle_open_ideas.json");
const YR = 365 * 864e5;

export function readOpenLocal() { try { return JSON.parse(readFileSync(OPEN_FILE, "utf8")); } catch { return []; } }
// Yerel açık fikir listesine ekle (yalnız son 6 saat tutulur)
export function pushOpenLocal(ideas, now = Date.now()) {
  const keep = readOpenLocal().filter(x => now - x.ts < 6 * 3600e3);
  for (const it of ideas) if (!keep.some(x => x.id === it.id)) keep.push(it);
  try { writeFileSync(OPEN_FILE, JSON.stringify(keep)); } catch {}
}

export const ideaId = it => `${it.src}-${it.sym}-${it.ts}`;

// Saf karar: { px (canlı), hi, lo (fikirden beri), now, toCloseMin } → null | { why, px }
export function checkExit(it, { px, hi, lo, now, toCloseMin = 999 }) {
  if (!(px > 0)) return null;
  const up = it.dir === "C";
  const H = Math.max(hi ?? px, px), Lo = Math.min(lo ?? px, px);
  if (up ? Lo <= it.stop : H >= it.stop) return { why: "STOP", px };
  if (up ? H >= it.target : Lo <= it.target) return { why: "HEDEF", px };
  if (it.tstop && now >= it.ts + it.tstop * 60e3) return { why: "ZAMAN", px };
  if (toCloseMin <= 5) return { why: "KAPANIŞ", px };
  return null;
}

// Opsiyonun tahmini anlık değeri (fikirdeki IV ile, kalan süre kesin) | null
export function optValue(it, px, now, closeTs) {
  if (!it.K || !it.iv || !closeTs) return null;
  const T = Math.max(60e3, closeTs - now) / YR;
  return bs(it.dir, px, it.K, T, 0.04, 0, it.iv).price;
}

const f2 = x => (x == null || !isFinite(x) ? "—" : x.toFixed(2));
const LAB = { STOP: ["🛑", "stop"], HEDEF: ["✅", "hedef geldi"], ZAMAN: ["⏱", "süre doldu"], KAPANIŞ: ["🔔", "seans bitiyor"] };
// SADE çıkış mesajı: ne kapatılacak · neden · sonuç
export function fmtExit(it, ex, val, paperClosed = false) {
  const R = Math.abs(it.S - it.stop), r = R > 0 ? ((it.dir === "C" ? 1 : -1) * (ex.px - it.S)) / R : 0;
  const what = it.K ? `${it.sym} ${it.K}${it.dir}${it.exp ? " " + it.exp.slice(8, 10) + "." + it.exp.slice(5, 7) : ""}` : `${it.sym} ${it.dir === "C" ? "CALL" : "PUT"}`;
  const opt = val != null && it.prem ? ` · opsiyon ~$${f2(val)} (${val >= it.prem ? "+" : "−"}%${Math.abs((val / it.prem - 1) * 100).toFixed(0)})` : "";
  return `${LAB[ex.why][0]} KAPAT: ${what} — ${LAB[ex.why][1]} (${it.sym} ${f2(ex.px)}, ${r >= 0 ? "+" : ""}${r.toFixed(1)}R)${opt}${paperClosed ? " 🧾" : ""}`;
}
