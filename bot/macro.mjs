// ÖNEMLİ VERİ GÜNLERİ (makro takvim) — yüksek etkili ABD verileri (CPI, istihdam, FOMC, PCE, GDP…).
// Kaynak: Forex Factory haftalık takvimi (herkese açık JSON, yalnız USD + "High" etki). Erişilemezse yalnız FOMC (sabit
// 2026 takvimi, karar 14:00 NY) yedeği kullanılır. Aynı makinedeki süreçler (tarama, 15 dk fikri, ani hareket) tek dosya
// önbelleği paylaşır → günde ~birkaç istek. O gün/saatlerde 0DTE ve ani hareket fikirlerine "yüksek risk" uyarısı eklenir.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nyParts } from "../data/market.mjs";

const URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const CACHE = join(process.env.RUNNER_TEMP || tmpdir(), "eagle_macro.json");
const FOMC = ["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"];
const TTL = 6 * 3600e3;

// Ham takvim → [{ ts, title }] (yalnız USD + High), FOMC yedeğiyle birleştirilmiş
export function parseEvents(raw, fomcTs = []) {
  const out = (Array.isArray(raw) ? raw : []).filter(e => e?.country === "USD" && e?.impact === "High")
    .map(e => ({ ts: Date.parse(e.date), title: String(e.title || "").trim() })).filter(e => isFinite(e.ts) && e.title);
  for (const ts of fomcTs) if (!out.some(e => Math.abs(e.ts - ts) < 3 * 3600e3)) out.push({ ts, title: "FOMC faiz kararı" });
  return out.sort((a, b) => a.ts - b.ts);
}

// FOMC karar günleri 14:00 NY (yaz/kış saati: nyParts ile)
function fomcTs() {
  return FOMC.map(d => {
    const [y, m, dd] = d.split("-").map(Number);
    for (const off of [4, 5]) { const t = Date.UTC(y, m - 1, dd, 14 + off, 0); if (nyParts(new Date(t)).mins === 840) return t; }
    return Date.UTC(y, m - 1, dd, 19, 0);
  });
}

export async function macroEvents(now = Date.now()) {
  try { const c = JSON.parse(readFileSync(CACHE, "utf8")); if (now - c.at < TTL) return c.ev; } catch {}
  let raw = null;
  try {
    const ctrl = new AbortController(), tid = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(URL, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: ctrl.signal });
    clearTimeout(tid);
    if (r.ok) raw = await r.json();
  } catch {}
  const ev = parseEvents(raw, fomcTs());
  if (raw) { try { writeFileSync(CACHE, JSON.stringify({ at: now, ev })); } catch {} }   // yalnız başarılı çekimi önbelleğe al
  return ev;
}

const hm = ts => { const m = nyParts(new Date(ts)).mins; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
export const eventsOn = (ev, dateIso) => (ev || []).filter(e => nyParts(new Date(e.ts)).date === dateIso);
// Şu ana ±win dakika içindeki olay (önce/sonra) | null
export const nearEvent = (ev, now = Date.now(), winMin = 45) => (ev || []).find(e => Math.abs(e.ts - now) <= winMin * 60e3) || null;

// Sabah / 15 dk mesajı satırı (bugün olay yoksa null)
export function fmtMacroDay(ev, dateIso) {
  const today = eventsOn(ev, dateIso);
  if (!today.length) return null;
  return `📅 Bugün yüksek etkili ABD verisi: ${today.map(e => `${hm(e.ts)} NY ${e.title}`).join(" · ")} → o saatlerde 0DTE ve ani hareket riski çok yüksek, pozisyonu küçült.`;
}
export function fmtNear(e, now = Date.now()) {
  if (!e) return null;
  const d = Math.round((e.ts - now) / 60e3);
  return `⚠ ${e.title} ${d >= 0 ? `${d} dk sonra` : `${-d} dk önce`} (${hm(e.ts)} NY) — veri oynaklığı: sahte kırılım/ani dönüş riski yüksek.`;
}
