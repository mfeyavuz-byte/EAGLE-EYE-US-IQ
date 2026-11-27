// ALPACA PAPER (SANAL PARA) OPSİYON İŞLEMİ — 15 dk fikirleri, ani hareket alarmları ve bilanço straddle'ları sanal hesapta
// gerçekten alınır/satılır → karne opsiyonun GERÇEK alış-satış fiyatlarıyla (spread + zaman kaybı dahil) ölçülür.
// • Yalnız ALIM ile açılış (buy to open) ve SATIŞ ile kapanış (sell to close) — açığa opsiyon satışı YOK.
// • Uç nokta SABİT: paper-api.alpaca.markets → gerçek hesaba/paraya dokunamaz. PAPER_OPT=0 ile kapatılır.
// • Boyut: fikir başına OPT_PAPER_BUDGET (vars. $1.000) → adet = bütçe ÷ (prim × 100), en az 1; tek kontrat bütçenin
//   3 katını aşıyorsa alınmaz.
import { call, paperState } from "./paper.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alpacaEnabled } from "../data/alpaca.mjs";

export const optPaperEnabled = () => alpacaEnabled() && process.env.PAPER_OPT !== "0";
export const OPAPER = { BUDGET: +(process.env.OPT_PAPER_BUDGET || 1000) };

export function paperQty(prem, budget = OPAPER.BUDGET) {
  if (!(prem > 0)) return 0;
  const one = prem * 100;
  if (one > budget * 3) return 0;
  return Math.max(1, Math.floor(budget / one));
}

// Alpaca istemci emir kimliği: harf/rakam/-, ≤ 48 karakter
export const orderId = id => String(id).replace(/[^A-Za-z0-9-]/g, "-").slice(0, 48);

// Piyasa emriyle aç (seans içi; opsiyon emirleri "day"). Dönüş: { id, qty } | null
// qtyIn: adet zorla (straddle'da iki bacak AYNI adet olmalı)
export async function paperBuy(occ, prem, id, qtyIn = null) {
  if (!optPaperEnabled() || !occ) return null;
  const qty = qtyIn ?? paperQty(prem);
  if (!qty) { console.log(`[Opsiyon paper] ${occ}: kontrat bütçeye göre pahalı, alınmadı`); return null; }
  paperState.lastErr = null;
  const o = await call("POST", "/v2/orders", { symbol: occ, qty: String(qty), side: "buy", type: "market", time_in_force: "day", client_order_id: orderId(id) });
  if (o?.id) console.log(`[Opsiyon paper] AL ${occ} ×${qty}`);
  return o?.id ? { id: o.id, qty } : null;
}

// Pozisyonu tamamen kapat (satış). Pozisyon yoksa null.
export async function paperClose(occ) {
  if (!optPaperEnabled() || !occ) return null;
  const o = await call("DELETE", `/v2/positions/${encodeURIComponent(occ)}`);
  if (o?.id) console.log(`[Opsiyon paper] SAT ${occ}`);
  return o;
}

// Saf hesap: dolmuş opsiyon emirleri → kapanmış tur (alış → satış, FIFO) istatistiği
export function roundTrips(orders) {
  const fills = (orders || []).filter(o => o.asset_class === "us_option" && o.status === "filled" && +o.filled_qty > 0)
    .map(o => ({ sym: o.symbol, side: o.side, qty: +o.filled_qty, px: +o.filled_avg_price, t: o.filled_at }))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const open = {}, trips = [];
  for (const f of fills) {
    if (f.side === "buy") { (open[f.sym] ||= []).push({ ...f }); continue; }
    let q = f.qty;
    while (q > 0 && open[f.sym]?.length) {
      const b = open[f.sym][0], n = Math.min(q, b.qty);
      trips.push({ sym: f.sym, qty: n, buy: b.px, sell: f.px, ret: b.px > 0 ? f.px / b.px - 1 : 0, pnl: (f.px - b.px) * n * 100, t: f.t });
      b.qty -= n; q -= n;
      if (!b.qty) open[f.sym].shift();
    }
  }
  const n = trips.length;
  return { n, wins: trips.filter(t => t.pnl > 0).length, avgRet: n ? trips.reduce((a, t) => a + t.ret, 0) / n : null,
    pnl: trips.reduce((a, t) => a + t.pnl, 0), open: Object.values(open).reduce((a, l) => a + l.filter(x => x.qty > 0).length, 0), trips };
}

export async function paperOptReport(days = 30) {
  if (!optPaperEnabled()) return null;
  const after = new Date(Date.now() - days * 864e5).toISOString();
  const orders = await call("GET", `/v2/orders?status=closed&limit=500&direction=asc&after=${encodeURIComponent(after)}`);
  if (!Array.isArray(orders)) return null;
  const s = roundTrips(orders);
  if (!s.n) return `🧾 Sanal opsiyon hesabı (Alpaca paper, ${days} gün): henüz kapanmış işlem yok${s.open ? ` · açık ${s.open}` : ""}.`;
  return `🧾 Sanal opsiyon hesabı (Alpaca paper, GERÇEK dolumlar, ${days} gün): ${s.n} işlem · kazanan %${Math.round(s.wins / s.n * 100)} · ` +
    `ort. ${s.avgRet >= 0 ? "+" : ""}${(s.avgRet * 100).toFixed(1)}% · net ${s.pnl >= 0 ? "+" : "−"}$${Math.abs(Math.round(s.pnl)).toLocaleString("en-US")}${s.open ? ` · açık ${s.open}` : ""}`;
}

// Yarım kalan girişi geri al: emir dolmadıysa iptal, dolduysa pozisyonu kapat
export async function paperUnwind(res, occ) {
  if (!res?.id) return;
  await call("DELETE", `/v2/orders/${encodeURIComponent(res.id)}`);
  await new Promise(r => setTimeout(r, 1500));
  await paperClose(occ);
}

// Emir reddedildiyse Alpaca'nın gerekçesini Telegram'a yaz (günde en çok 1 kez; aynı makinedeki süreçler ortak dosya)
const WARN = join(process.env.RUNNER_TEMP || tmpdir(), "eagle_paper_warn.txt");
export async function warnPaperFail(send, occ) {
  const err = paperState.lastErr;
  if (!err || !optPaperEnabled()) return false;
  const day = new Date().toISOString().slice(0, 10);
  try { if (readFileSync(WARN, "utf8") === day) return false; } catch {}
  try { writeFileSync(WARN, day); } catch {}
  return send(`⚠ SANAL OPSİYON EMRİ REDDEDİLDİ (${occ}) — Alpaca: ${err}\n` +
    "Olası neden: Alpaca paper hesabında opsiyon izni kapalı (Alpaca → Paper hesabı → Account/Configure → Options Trading Level ≥ 1) " +
    "ya da alım gücü yetersiz. Fikir ve çıkış mesajları ETKİLENMEZ; yalnız gerçek dolum karnesi boş kalır. (Bu uyarı günde 1 kez.)");
}
