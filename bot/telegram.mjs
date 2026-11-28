// Telegram — gönderim + komut okuma (getUpdates).
// DRY_RUN=1 → mesajlar gönderilmez, konsola yazılır (yerel test).
// ÖNEMLİ: Bu bot için AYRI bir token kullan (bist-bot ile aynı token'ı iki workflow okursa komutlar kaybolur).
import { panelRecord, sanitize } from "./panel.mjs";
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
// buttons: [[{ text, data }]] satırlar → yalnız SON parçaya eklenir. data = komut metni (örn. "/opsiyon NVDA").
// Telegram callback_data sınırı 64 bayt → uzun olanlar atlanır.
export function keyboard(buttons) {
  const rows = (buttons || []).map(r => r.filter(b => b?.text && b.data && Buffer.byteLength(b.data) <= 64)
    .map(b => ({ text: b.text, callback_data: b.data }))).filter(r => r.length);
  return rows.length ? { inline_keyboard: rows } : null;
}

// panel: "plan" | "fikir" | ... → mesaj web paneline de kaydedilir (bot/panel.mjs; kişisel satırlar silinir). Komut cevapları etiketlenmez.
export async function sendTG(text, { buttons = null, panel = null } = {}) {
  const kb = keyboard(buttons);
  if (DRY || !tgEnabled()) {
    console.log("\n----- [TG] -----\n" + text + (kb ? "\n[butonlar] " + kb.inline_keyboard.map(r => r.map(b => b.text).join(" | ")).join(" / ") : "") + "\n----------------");
    if (panel) panelRecord(panel, text);
    return true;
  }
  let ok = true;
  const parts = chunks(text);
  for (let i = 0; i < parts.length; i++) {
    let sent = false;
    for (let attempt = 0; attempt < 4 && !sent; attempt++) {
      try {
        const payload = { chat_id: CHAT, text: parts[i], disable_web_page_preview: true };
        if (kb && i === parts.length - 1) payload.reply_markup = kb;
        const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
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
  if (ok && panel) { panelRecord(panel, text); await pushPhone(panel, text); }
  return ok;
}
// TELEFON BİLDİRİMİ (isteğe bağlı): NTFY_TOPIC secret'ı varsa önemli fikirler ntfy uygulamasına da gider (kişisel satırlar silinir).
const NTFY = process.env.NTFY_TOPIC || "", PUSH_CATS = new Set(["fikir", "cikis", "ta", "wma", "tutus", "donus"]);
async function pushPhone(cat, text) {
  if (!NTFY || !PUSH_CATS.has(cat)) return;
  const t = sanitize(text), [title, ...rest] = t.split("\n");
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY)}`, { method: "POST", body: rest.join("\n").slice(0, 3500) || title,
      headers: { Title: encodeURIComponent(title.slice(0, 120)), "X-Title-Encoding": "url", Priority: cat === "cikis" ? "high" : "default", Tags: "eagle" } });
  } catch (e) { console.error("[ntfy]", e?.message || e); }
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
      // Buton tıklaması (callback_query): data bir komut metnidir; yalnız yetkili sohbetten
      const cq = u.callback_query;
      if (cq) {
        if (String(cq.message?.chat?.id) !== String(CHAT)) continue;
        answerCallback(cq.id);                                          // butondaki "yükleniyor"u kapat (hata önemsiz)
        const t = String(cq.data || "").trim();
        if (t.startsWith("/")) updates.push({ text: t });
        continue;
      }
      if (String(u.message?.chat?.id) !== String(CHAT)) continue;   // başkası bota yazarsa yok say
      const text = (u.message?.text || "").trim();
      if (text) updates.push({ text });
    }
    return { updates, offset: off };
  } catch { return { updates: [], offset }; }
}

function answerCallback(id) {
  fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text: "Alındı — bot bir sonraki çalışmasında yanıtlar (~10 dk)." }),
  }).catch(() => {});
}

// Fotoğraf (grafik) gönder: url'deki görüntü İNDİRİLİR ve Telegram'a dosya olarak yüklenir (uzun URL sorunu yok).
// Başarısızsa false (çağıran yalnız metinle devam eder).
export async function sendPhoto(url, caption = "") {
  if (DRY || !tgEnabled()) { console.log(`\n----- [TG foto] ${url.slice(0, 100)}… -----\n${caption}\n----------------`); return true; }
  try {
    const img = await fetch(url);
    if (!img.ok || !String(img.headers.get("content-type")).startsWith("image/")) { console.error("[TG foto] görüntü alınamadı", img.status); return false; }
    const form = new FormData();
    form.append("chat_id", String(CHAT));
    if (caption) form.append("caption", caption.slice(0, 1000));
    form.append("photo", new Blob([await img.arrayBuffer()], { type: "image/png" }), "grafik.png");
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: "POST", body: form });
    if (!r.ok) console.error("[TG foto] hata", r.status, (await r.text().catch(() => "")).slice(0, 150));
    return r.ok;
  } catch (e) { console.error("[TG foto]", e.message); return false; }
}
