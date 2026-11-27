// MODEL PORTFÖY — Alpaca PAPER (sanal para) hesabında spot AL seçimlerini birebir uygular.
// Amaç: "bu sinyalleri uygulasaydım hesabım ne olurdu?" sorusunu GERÇEK dolum fiyatlarıyla cevaplamak.
// • Yalnız HİSSE ALIMI (açığa satış yok, opsiyon yok). Uç nokta sabit: paper-api (gerçek hesaba dokunamaz).
// • Varsayılan KAPALI: repo değişkeni PAPER_TRADE=1 ile açılır.
// • Giriş: piyasa emri + braket (stop ve hedef emirleri otomatik). Boyut: hesabın RISK_SPOT'u stop'a kadar riske,
//   tek hisse en çok MAX_POS. Çıkış: braket (stop/hedef) ya da 21 işlem günü dolunca pozisyon kapatılır.
import { alpacaEnabled } from "../data/alpaca.mjs";

const BASE = "https://paper-api.alpaca.markets";
const HDR = () => ({ "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID || "", "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY || "", "content-type": "application/json" });
export const paperEnabled = () => process.env.PAPER_TRADE === "1" && alpacaEnabled();

export const paperState = { lastErr: null };                       // son Alpaca hata metni (tanı için)
export async function call(method, path, body) {
  try {
    const r = await fetch(BASE + path, { method, headers: HDR(), body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text();
    if (!r.ok) { console.error("[Paper]", method, path, r.status, txt.slice(0, 160)); paperState.lastErr = `${r.status} ${txt.slice(0, 160)}`; return null; }
    return txt ? JSON.parse(txt) : {};
  } catch (e) { console.error("[Paper]", e.message); paperState.lastErr = e.message; return null; }
}

export const account = () => call("GET", "/v2/account");
export const positions = async () => (await call("GET", "/v2/positions")) || [];
export const closePosition = sym => call("DELETE", `/v2/positions/${encodeURIComponent(sym)}`);

// Boyut (adet): hesabın risk payı ÷ hisse başı risk, en çok maxPos·equity değerinde
export function qtyFor(equity, price, stop, risk, maxPos) {
  if (!(equity > 0 && price > 0 && stop > 0 && price > stop)) return 0;
  return Math.max(0, Math.floor(Math.min(equity * risk / (price - stop), equity * maxPos / price)));
}

export async function buyBracket(sym, qty, stop, target) {
  return call("POST", "/v2/orders", {
    symbol: sym, qty: String(qty), side: "buy", type: "market", time_in_force: "gtc",
    order_class: "bracket", take_profit: { limit_price: +target.toFixed(2) }, stop_loss: { stop_price: +stop.toFixed(2) },
  });
}

// Bir run: yeni AL'leri al, süresi dolanları kapat. st.paper = { pos: {SYM: {d, qty, px}}, start: {d, equity} }
// tradingDays(from, to) dışarıdan verilir (spotbook). Dönüş: Telegram satırları.
export async function runPaper(st, today, newAls, tradingDays, { risk, maxPos, hold }) {
  if (!paperEnabled()) return [];
  const acc = await account();
  if (!acc) return ["⚠ Model portföy: Alpaca paper hesabına erişilemedi."];
  st.paper ||= { pos: {} };
  st.paper.start ||= { d: today, equity: +acc.equity };
  const held = new Set((await positions()).map(p => p.symbol));
  const lines = [];
  // Süre dolanlar (braket hâlâ açıksa) → kapat
  for (const [sym, p] of Object.entries(st.paper.pos)) {
    if (!held.has(sym)) { delete st.paper.pos[sym]; continue; }   // stop/hedef zaten kapattı
    if (tradingDays(p.d, today) >= hold && await closePosition(sym)) { lines.push(`📕 ${sym} kapatıldı (${hold} işlem günü doldu)`); delete st.paper.pos[sym]; }
  }
  // Yeni AL'ler
  for (const s of newAls) {
    if (held.has(s.sym) || st.paper.pos[s.sym] || !s.stopLoss || !s.target1) continue;
    const qty = qtyFor(+acc.equity, s.price, s.stopLoss, risk, maxPos);
    if (qty < 1) continue;
    const o = await buyBracket(s.sym, qty, s.stopLoss, s.target1);
    if (o) { st.paper.pos[s.sym] = { d: today, qty, px: s.price }; lines.push(`🟢 ${s.sym} ${qty} adet alındı (~$${Math.round(qty * s.price).toLocaleString("en-US")}) · stop $${s.stopLoss} · hedef $${s.target1}`); }
  }
  return lines;
}

export async function paperSummary(st) {
  if (!paperEnabled()) return null;
  const acc = await account();
  if (!acc) return null;
  const eq = +acc.equity, start = st.paper?.start;
  const ps = await positions();
  const L = [`💼 MODEL PORTFÖY (Alpaca paper) · özsermaye $${Math.round(eq).toLocaleString("en-US")}` +
    (start ? ` · başlangıçtan (${start.d}) ${((eq / start.equity - 1) * 100).toFixed(1)}%` : "")];
  for (const p of ps) L.push(`• ${p.symbol} ${p.qty} adet · K/Z ${(+p.unrealized_plpc * 100).toFixed(1)}% ($${Math.round(+p.unrealized_pl)})`);
  if (!ps.length) L.push("Açık pozisyon yok.");
  return L.join("\n");
}
