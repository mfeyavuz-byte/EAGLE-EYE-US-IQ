#!/usr/bin/env node
// Geriye dönük test raporunu (out.txt'nin "SONUÇ" bölümü) Telegram'a gönderir. backtest.yml kullanır.
import { readFileSync } from "node:fs";
import { sendTG, tgEnabled } from "../bot/telegram.mjs";

const file = process.argv[2] || "out.txt";
const txt = readFileSync(file, "utf8");
const i = txt.indexOf("SONUÇ");
const body = i >= 0 ? txt.slice(i) : txt.split("\n").slice(-30).join("\n");
const head = `🧪 GERİYE DÖNÜK TEST SONUCU\n${process.env.BT_INFO || ""}\n`;
if (!tgEnabled()) { console.log("Telegram ayarlı değil — rapor gönderilmedi."); process.exit(0); }
const ok = await sendTG(head + "\n" + body);
console.log(ok ? "Rapor Telegram'a gönderildi." : "⚠ Rapor Telegram'a gönderilemedi.");
