// ABD seans saatleri (New York saati; yaz/kış saati otomatik).
import { alpacaClock } from "./alpaca.mjs";

const NY = "America/New_York";

export function nyParts(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: NY, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  const hour = +g("hour") % 24;   // bazı Node sürümleri gece yarısını "24" yazar
  return { wd: g("weekday"), date: `${g("year")}-${g("month")}-${g("day")}`, mins: hour * 60 + +g("minute") };
}

// Normal seans: hafta içi 09:30–16:00 NY. (Resmî tatilleri bilmez → Alpaca varsa o kullanılır.)
export function isRegularHours(d = new Date()) {
  const { wd, mins } = nyParts(d);
  if (wd === "Sat" || wd === "Sun") return false;
  return mins >= 570 && mins < 960;
}

// Seansın geçen kısmı (0..1). Seans dışı/gün bitti → 1. Kısmi günlük hacmi adil kıyaslamak için.
export function sessionFraction(d = new Date()) {
  if (!isRegularHours(d)) return 1;
  return Math.max(0.05, (nyParts(d).mins - 570) / 390);
}

export async function isMarketOpen(d = new Date()) {
  const c = await alpacaClock().catch(() => null);
  return c ?? isRegularHours(d);
}

export const nyDate = (d = new Date()) => nyParts(d).date;
export const fmtTR = (d = new Date()) => d.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
