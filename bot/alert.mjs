#!/usr/bin/env node
// Workflow hata alarmı: bir adım başarısız olursa Telegram'a kısa mesaj (workflow'larda `if: failure()` adımı).
import { sendTG, tgEnabled } from "./telegram.mjs";

const name = process.env.WF_NAME || "workflow";
const url = process.env.RUN_URL || "";
if (!tgEnabled()) { console.log("Telegram ayarlı değil — alarm gönderilmedi."); process.exit(0); }
await sendTG(`🚨 ABD BOT — "${name}" başarısız oldu.\nBot bu çalıştırmada durmuş olabilir. Ayrıntı: ${url}`);
