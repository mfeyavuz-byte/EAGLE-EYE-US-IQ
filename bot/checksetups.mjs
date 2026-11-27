// Kurulum listesi (abd_setups.json) yok ya da 8 günden eskiyse "STALE" yazar → iş akışı araştırmayı tetikler.
import { loadFiles, READ_FAILED, gistEnabled } from "./state.mjs";
import { SETUPS_FILE } from "./setuplive.mjs";
if (!gistEnabled()) { console.log("OK"); process.exit(0); }
const f = await loadFiles([SETUPS_FILE]);
if (f === READ_FAILED) { console.log("OK"); process.exit(0); }                    // okunamadı → bu sefer tetikleme
const d = f[SETUPS_FILE]?.d;
console.log(!d || Date.now() - Date.parse(d + "T00:00:00Z") > 8 * 864e5 ? "STALE" : "OK");
