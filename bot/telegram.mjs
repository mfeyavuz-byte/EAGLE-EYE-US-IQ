// Telegram — gönderim + komut okuma (getUpdates).
// DRY_RUN=1 → mesajlar gönderilmez, konsola yazılır (yerel test).
// ÖNEMLİ: Bu bot için AYRI bir token kullan (bist-bot ile aynı token'ı iki workflow okursa komutlar kaybolur).
const TOKEN = process.env.TG_TOKEN || "";
export const CHAT = process.env.TG_CHAT || "";
const DRY = process.env.DRY_RUN === "1";
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const tgEnabled = () => !!(TOKEN && CHAT);

// Telegram mesaj sınırı 4096 karakter → satır sınırından böl.
function chunks(text, max = 3900) {
  const out = []; let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + "\n" + line).length > max) { out.push(cur); cur = line; } else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

export async function sendTG(text) {
  if (DRY || !tgEnabled()) { console.log("\n----- [TG] -----\n" + text + "\n----------------"); return true; }
  let ok = true;
  for (const part of chunks(text)) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT, text: part, disable_web_page_preview: true }),
      });
      if (!r.ok) { ok = false; console.error("[TG] hata", r.status, (await r.text().catch(() => "")).slice(0, 150)); }
    } catch (e) { ok = false; console.error("[TG]", e.message); }
    await sleep(350);
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
