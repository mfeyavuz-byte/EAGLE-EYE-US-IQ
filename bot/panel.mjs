// BOT PANELİ — web sitesinin (panel/index.html) okuduğu ÖZET. Yalnız piyasa fikirleri/planlar/karne; KİŞİSEL VERİ YOK.
// • Telegram'a giden mesajlardan yalnız AÇIKÇA etiketlenenler ({ panel: "plan" } vb.) kaydedilir — komut cevapları
//   (/hesap, /pozisyonlarim, /ayarlar) hiç kaydedilmez. Kayıttan önce kontrat SAYISI / hesap yüzdesi satırları silinir.
// • Süreçler (tarama, 15 dk, ani hareket) aynı makinede ortak JSONL dosyasına EKLER (appendFileSync: çakışma yok);
//   tek yayıncı (fast.mjs döngüsü) 2 dk'da bir herkese açık AYRI bir Gist'e (PANEL_GIST_ID) panel.json yazar.
//   Durum Gist'i (GIST_ID) ASLA kullanılmaz: orada hesap ve pozisyon bilgisi var.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const PANEL_FEED = join(process.env.RUNNER_TEMP || tmpdir(), "eagle_panel_feed.jsonl");
export const PANEL_FILE = "panel.json";
export const PANEL = { KEEP_H: 36, MAX: 400, PUB_MS: 2 * 60e3, PUB_IDLE_MS: 15 * 60e3 };
const TOKEN = process.env.GH_GIST_TOKEN || "", PID = process.env.PANEL_GIST_ID || "";
export const panelEnabled = () => !!(TOKEN && PID);
// Formasyon/200 WMA karnesi tarama sürecinin durumunda → yerel dosya; yayıncı (fast.mjs) okuyup panele ekler
export const TA_KARNE_FILE = join(process.env.RUNNER_TEMP || tmpdir(), "eagle_ta_karne.txt");
export function writeTaKarne(text) { try { writeFileSync(TA_KARNE_FILE, sanitize(text)); } catch {} }
export function readTaKarne() { try { return readFileSync(TA_KARNE_FILE, "utf8"); } catch { return null; } }

// Kişisel: kontrat sayısı, hesap %'si, stopta $ kayıp (hesap büyüklüğünü ele verir) → silinir
export function sanitize(text) {
  return String(text || "").split("\n")
    .filter(l => !/^\s*(Boyut:|Adet\s)/.test(l))
    .map(l => l.replace(/\s*·\s*Boyut:[^·\n]*/g, "").replace(/\s*·\s*\d+ kontrat \(stopta[^)]*\)/g, "").replace(/\s*·\s*1 kontrat bile riskinden büyük[^·\n]*/g, ""))
    .join("\n").trim();
}

export function panelRecord(cat, text, now = Date.now(), file = PANEL_FEED) {
  const t = sanitize(text);
  if (!cat || !t) return;
  try { appendFileSync(file, JSON.stringify({ ts: now, cat, text: t }) + "\n"); } catch {}
}

export function readFeed(file = PANEL_FEED, now = Date.now()) {
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const l of raw.split("\n")) { if (!l) continue; try { const x = JSON.parse(l); if (x?.ts && now - x.ts < PANEL.KEEP_H * 3600e3) out.push(x); } catch {} }
  return out.sort((a, b) => a.ts - b.ts).slice(-PANEL.MAX);
}
// Makine yeniden başlayınca (zincir her ~5,5 saatte yeni makine) yerel kayıt boştur → yayındaki son panelden doldurulur
export function seedFeed(items, file = PANEL_FEED) {
  try { writeFileSync(file, (items || []).map(x => JSON.stringify(x)).join("\n") + (items?.length ? "\n" : "")); } catch {}
}

export function buildSnapshot({ feed, internals = null, lead = null, karne = null, paused = [], open = [], now = Date.now() }) {
  return {
    v: 1, ts: now, feed,
    internals: internals ? { dt: internals.dt ?? null, mb: internals.mb ?? null, br: internals.br ?? null, up: internals.up ?? null, ts: internals.ts ?? null } : null,
    lead: lead?.rel ? { ts: lead.ts, spy: lead.spy, rel: lead.rel, ret: lead.ret } : null,
    karne: karne ? sanitize(karne) : null,
    paused: (paused || []).map(p => ({ key: p.key, s10: p.s10, daysLeft: p.daysLeft })),
    open: (open || []).map(o => ({ ts: o.ts, sym: o.sym, dir: o.dir, src: o.src, S: o.S, target: o.target, stop: o.stop,
      contract: o.K ? `${o.exp ? o.exp.slice(8, 10) + "." + o.exp.slice(5, 7) + " " : ""}${o.K}${o.dir}${o.prem ? " ~$" + o.prem : ""}` : null })),
  };
}

const H = () => ({ Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json", "User-Agent": "eagle-eye-panel" });
export async function loadPanel() {
  if (!panelEnabled()) return null;
  try {
    const r = await fetch(`https://api.github.com/gists/${PID}`, { headers: H() });
    if (!r.ok) return null;
    const f = (await r.json()).files?.[PANEL_FILE];
    if (!f) return null;
    const txt = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
    return JSON.parse(txt);
  } catch { return null; }
}
export async function publishPanel(snap) {
  if (!panelEnabled()) return false;
  try {
    const r = await fetch(`https://api.github.com/gists/${PID}`, { method: "PATCH", headers: { ...H(), "content-type": "application/json" },
      body: JSON.stringify({ files: { [PANEL_FILE]: { content: JSON.stringify(snap) } } }) });
    if (!r.ok) console.error("[panel] yazılamadı", r.status);
    return r.ok;
  } catch (e) { console.error("[panel]", e?.message || e); return false; }
}
