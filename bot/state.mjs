// Kalıcı durum — GitHub Gist (Actions makinesi her run'da sıfırlanır).
// Okuma BAŞARISIZ ile gerçekten BOŞ ayrımı: başarısızlıkta READ_FAILED → çağıran ASLA yazmaz (bist-bot dersi).
const TOKEN = process.env.GH_GIST_TOKEN || "";
const ID = process.env.GIST_ID || "";
export const STATE_FILE = "abd_state.json";
export const READ_FAILED = Symbol("gist_read_failed");
export const gistEnabled = () => !!(TOKEN && ID);

export async function loadState() {
  if (!gistEnabled()) return {};
  try {
    const r = await fetch(`https://api.github.com/gists/${ID}`, {
      headers: { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json" },
    });
    if (!r.ok) return READ_FAILED;
    const g = await r.json();
    const c = g.files?.[STATE_FILE]?.content;
    return c ? JSON.parse(c) : {};
  } catch { return READ_FAILED; }
}

export async function saveState(st) {
  if (!gistEnabled()) return false;
  try {
    const r = await fetch(`https://api.github.com/gists/${ID}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ files: { [STATE_FILE]: { content: JSON.stringify(st) } } }),
    });
    if (!r.ok) console.error("[Gist] yazılamadı", r.status);
    return r.ok;
  } catch (e) { console.error("[Gist]", e.message); return false; }
}
