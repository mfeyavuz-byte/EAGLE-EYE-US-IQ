# 🇺🇸 ABD BOT — Spot + Opsiyon öneri botu (Telegram)

GitHub Actions üzerinde kendi kendine çalışır, sunucu gerekmez. Teknik motor bist-bot'tan alındı
(19 indikatör, `getSignals`), veri ABD için ücretsiz kaynaklardan gelir. Bağımlılık yok (Node 20+).

## Durum: Faz 1 ✅
| Faz | İçerik | Durum |
|---|---|---|
| 1 | Veri (Yahoo + Alpaca IEX) · motor · spot tarama · Telegram sinyal + komutlar | ✅ |
| 2 | Temel analiz: SEC EDGAR (marj, büyüme, F-skoru, sulandırma, Form 4) | ⏳ |
| 3 | Opsiyon: zincir, Greek'ler (Black-Scholes), IV rejimi, strateji seçici, `/opsiyon` | ⏳ |
| 4 | Sanal portföy (spot + opsiyon) | ⏳ |
| 5 | ABD backtest kalibrasyonu + LLM yorum | ⏳ |

## Ne yapar (Faz 1)
- Seans boyunca (09:30–16:00 New York, TR saatiyle ~16:30/17:30–23:00/00:00) **20 dk'da bir** 140 likit ABD hissesini tarar.
- Filtreyi geçen **yeni** AL/SAT sinyallerini Telegram'a yollar (aynı gün aynı sinyal tekrar gelmez).
- Filtre: güven ≥ 65 · ADX ≥ 20 · ort. işlem hacmi ≥ 50M$ · haftalık trendle uyum · AL için RSI < 63 ve hacim temposu ≥ 0.7× (dip dönüşleri muaf).
- Her sinyalde: fiyat, güven, ADX, RSI, **SPY'a göre 60 günlük göreli güç**, stop, hedef, R:R.

### Komutlar
`/hisse NVDA` · `/sinyaller` · `/durum` · `/yardim`
> Komutlar bot çalışırken okunur (seans içinde ~20 dk gecikmeyle).

## Kurulum
1. **Yeni Telegram botu:** @BotFather → `/newbot` → token. @userinfobot → chat ID. Kendi botuna `/start` yaz.
   ⚠ bist-bot ile **aynı token'ı kullanma** — iki bot aynı token'dan komut okursa birbirinin komutlarını yutar.
2. **Gist:** gist.github.com → dosya `abd_state.json`, içerik `{}` → *secret gist* → URL'deki ID.
   Token: GitHub → Settings → Developer settings → Tokens (classic) → sadece `gist` izni.
   (bist-bot'un gist token'ını kullanabilirsin; gist ayrı olsun.)
3. **Alpaca (opsiyonel, önerilir):** alpaca.markets → ücretsiz hesap → Paper Trading → API Keys.
   Canlı IEX fiyatı + resmî tatil takvimi sağlar. Yoksa bot Yahoo'nun (gecikmeli olabilir) fiyatıyla çalışır.
4. Repo → Settings → Secrets and variables → Actions:

| Secret | Zorunlu |
|---|---|
| `TG_TOKEN`, `TG_CHAT` | ✅ |
| `GH_GIST_TOKEN`, `GIST_ID` | ✅ (yoksa her run sinyalleri tekrar yollar) |
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` | opsiyonel |

5. Actions → **ABD BOT — Spot Tarama** → Run workflow (`force` işaretli) → Telegram'a mesaj düşmeli.

## Yerel kullanım
```bash
npm test                                   # birim testleri
npm run dry                                # Telegram'a göndermeden tam tarama (konsola yazar)
DRY_RUN=1 FORCE=1 SYMBOLS=AAPL,NVDA node bot/run.mjs
npm run backtest                           # eşiklerin ABD'deki isabeti (MIN_CONF=70 npm run backtest)
```
Eşikler env ile değişir: `MIN_CONF`, `MIN_ADX`, `MAX_RSI_BUY`, `MIN_DVOL`.

## Dosyalar
```
core/engine.mjs     teknik motor (bist-bot kopyası — piyasadan bağımsız)
core/backtest.mjs   hafif backtest (SPY'a göre fazla getiri dahil)
data/yahoo.mjs      günlük/haftalık mum
data/alpaca.mjs     canlı IEX fiyatı + piyasa saati (opsiyonel)
data/market.mjs     NY seans saatleri (yaz/kış saati otomatik)
spot/scan.mjs       analiz + kalite filtresi + tarama
spot/symbols.json   hisse evreni
bot/run.mjs         ana akış + Telegram komutları
bot/state.mjs       Gist durumu (okuma hatasında asla üzerine yazmaz)
bot/telegram.mjs    gönderim + komut okuma
```

## Veri notları
- **Opsiyonlar için ücretsiz tam canlı veri (OPRA) yoktur.** Faz 3'te Alpaca *indicative* feed + Yahoo zinciri kullanılacak, Greek'ler kendi hesabımızla.
- Yahoo resmî olmayan bir API'dir; kesilirse bot o sembolü atlar, çökmez.
- Seans içi günlük mum kısmidir; hacim filtresi bu yüzden seansın geçen kısmına göre ölçeklenir.

> ⚠ Yatırım tavsiyesi değildir. Kişisel kullanım içindir.
