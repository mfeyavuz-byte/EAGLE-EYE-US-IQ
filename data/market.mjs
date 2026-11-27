// ABD seans saatleri (New York saati; yaz/kış saati otomatik).
import { alpacaClock, calendarDay } from "./alpaca.mjs";

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

// New York saatiyle dateIso günü h:m → UTC ms (yaz/kış saati otomatik)
export function nyTs(dateIso, h, m) {
  const [y, mo, d] = dateIso.split("-").map(Number);
  for (const off of [4, 5]) {
    const t = Date.UTC(y, mo - 1, d, h + off, m), p = nyParts(new Date(t));
    if (p.date === dateIso && p.mins === h * 60 + m) return t;
  }
  return Date.UTC(y, mo - 1, d, h + 5, m);
}

// Bilinen ERKEN KAPANIŞ günleri (13:00 NY) — Alpaca yoksa yedek kural: Şükran Günü ertesi Cuma, 24 Aralık, 3 Temmuz (hafta içiyse)
export function earlyCloseRule(dateIso) {
  const [y, m, d] = dateIso.split("-").map(Number), wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  if (m === 12 && d === 24) return true;
  if (m === 7 && d === 3) return true;
  if (m === 11 && wd === 5) {                                     // 4. Perşembe + 1
    const first = new Date(Date.UTC(y, 10, 1)).getUTCDay(), thu4 = 1 + ((4 - first + 7) % 7) + 21;
    return d === thu4 + 1;
  }
  return false;
}

// Seansın (ve o gün vadeli opsiyonların) GERÇEK kapanış anı: Alpaca takvimi → yedek kural → 16:00
export async function closeTsOf(dateIso) {
  const c = await calendarDay(dateIso).catch(() => undefined);
  if (c?.close) { const [h, m] = c.close.split(":").map(Number); return nyTs(dateIso, h, m); }
  return nyTs(dateIso, earlyCloseRule(dateIso) ? 13 : 16, 0);
}
