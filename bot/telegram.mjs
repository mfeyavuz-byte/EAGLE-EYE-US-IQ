// Telegram — gönderim + komut okuma (getUpdates).
// DRY_RUN=1 → mesajlar gönderilmez, konsola yazılır (yerel test).
// ÖNEMLİ: Bu bot için AYRI bir token kullan (bist-bot ile aynı token'ı iki workflow okursa komutlar kaybolur).
const TOKEN = process.env.TG_TOKEN || "";
export const CHAT = process.env.TG_CHAT || "";
const DRY = process.env.DRY_RUN === "1";
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const tgEnabled = () => !!(TOKEN && CHAT);

// Telegram mesaj sınırı 4096 karakter → satır sınırından böl. Hiçbir satır kaybolmaz; sınırı aşan tek satır
// (pratikte olmaz) karakter sınırından bölünür. Boş parça üretilmez.
export function chunks(text, max = 3900) {
  const out = []; let cur = "";
  const lines = text.split("\n").flatMap(l => l.length <= max ? [l] : l.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")));
  for (const line of lines) {
    if (cur && (cur + "\n" + line).length > max) { out.push(cur); cur = line; } else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

// Her parça en çok 4 kez denenir. 429 (hız sınırı) → Telegram'ın söylediği süre kadar beklenir.
// Parçalar arası 1.1 sn (Telegram: aynı sohbete saniyede ~1 mesaj).
export async function sendTG(text) {
  if (DRY || !tgEnabled()) { console.log("\n----- [TG] -----\n" + text + "\n----------------"); return true; }
  let ok = true;
  const parts = chunks(text);
  for (let i = 0; i < parts.length; i++) {
    let sent = false;
    for (let attempt = 0; attempt < 4 && !sent; attempt++) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: CHAT, text: parts[i], disable_web_page_preview: true }),
        });
        if (r.ok) { sent = true; break; }
        const body = await r.json().catch(() => ({}));
        console.error("[TG] hata", r.status, `parça ${i + 1}/${parts.length}`, String(body.description || "").slice(0, 150));
        if (r.status === 429) await sleep(((body.parameters?.retry_after || 3) + 1) * 1000);
        else if (r.status >= 500) await sleep(2000 * (attempt + 1));
        else break;                                                      // 400/403: tekrar denemek işe yaramaz
      } catch (e) { console.error("[TG]", e.message); await sleep(2000 * (attempt + 1)); }
    }
    if (!sent) ok = false;
    if (i < parts.length - 1) await sleep(1100);
  }
  return ok;
}

// Yeni komutları getir. Dönüş: { updates:[{text}], offset } — yalnızca yetkili sohbetten gelenler.
export async function fetchCommands(offset = 0) {
  if (DRY || !tgEnabled()) return { updates: [], offset };
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}&timeout=0`);
    const j = await r.json();
    const res = j.result || [];
    let off = offset;
    const updates = [];
    for (const u of res) {
      off = u.update_id + 1;
      if (String(u.message?.chat?.id) !== String(CHAT)) continue;   // başkası bota yazarsa yok say
      const text = (u.message?.text || "").trim();
      if (text) updates.push({ text });
    }
    return { updates, offset: off };
  } catch { return { updates: [], offset }; }
}
