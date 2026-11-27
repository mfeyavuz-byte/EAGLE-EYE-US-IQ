#!/usr/bin/env node
// Geriye dönük test raporunu (out.txt'nin "SONUÇ" bölümü) Telegram'a gönderir. backtest.yml kullanır.
import { readFileSync } from "node:fs";
import { sendTG, tgEnabled } from "../bot/telegram.mjs";

const file = process.argv[2] || "out.txt";
const txt = readFileSync(file, "utf8");
// Telegram'a KISA özet: "ÖZET" bölümü varsa yalnız o; yoksa SONUÇ'un ilk satırı + KARAR satırı (ayrıntı GitHub iş özetinde)
const z = txt.indexOf("\nÖZET\n") >= 0 ? txt.indexOf("\nÖZET\n") + 1 : txt.startsWith("ÖZET\n") ? 0 : -1;
let body;
if (z >= 0) body = txt.slice(z + 5).split("\n").filter(l => l.trim()).slice(0, 8).join("\n");
else {
  const lines = txt.split("\n"), i = lines.findIndex(l => l.startsWith("SONUÇ"));
  body = i >= 0 ? [lines[i], ...lines.slice(i).filter(l => l.startsWith("KARAR"))].join("\n") : lines.filter(l => l.trim()).slice(-3).join("\n");
}
if (!tgEnabled()) { console.log("Telegram ayarlı değil — rapor gönderilmedi."); process.exit(0); }
const ok = await sendTG(body);
console.log(ok ? "Rapor Telegram'a gönderildi." : "⚠ Rapor Telegram'a gönderilemedi.");
