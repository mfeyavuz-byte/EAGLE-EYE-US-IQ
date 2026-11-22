# 🇺🇸 ABD BOT — Spot + Opsiyon öneri botu (Telegram)

GitHub Actions üzerinde kendi kendine çalışır, sunucu gerekmez. Teknik motor bist-bot'tan alındı
(19 indikatör, `getSignals`); veri ABD için ücretsiz kaynaklardan gelir. Bağımlılık yok (Node 20+).
**Her kural geçmiş veriyle ölçüldü** (`research/`, `options/backtest.mjs`); ölçülmeyen iddia yok.

## Durum
| Faz | İçerik | Durum |
|---|---|---|
| 1 | Veri · motor · spot tarama · Telegram sinyal + komutlar | ✅ |
| 1b | Evren: **S&P 500 + Nasdaq'ın tamamı** (likidite filtreli, haftalık yenilenir) | ✅ |
| 3 | **Opsiyon motoru** (yalnız alım): kendi IV/Greek, oynaklık rejimi, yönetilen işlem simülasyonu, Kelly boyutu | ✅ |
| 5a | **Yön araştırması**: hangi sinyal rastgeleyi geçiyor → AL kuralı yeniden kuruldu | ✅ |
| 5b | Opsiyon geriye dönük testi (Alpaca geçmiş opsiyon fiyatları) | ✅ kod · ⏳ çalıştırma |
| — | Gerçekçi opsiyon karnesi · spot karnesi · haftalık rapor · haberler · olağandışı opsiyon hacmi | ✅ |
| 2 | Temel analiz: SEC EDGAR (marj, büyüme, sulandırma) | ⏳ |
| 4 | Sanal portföy (Alpaca paper) | ⏳ |

## Spot — ne seçer, neden
Seans boyunca 20 dk'da bir 1.331 hisse taranır; **yeni** seçimler gönderilir (günlük kota: 10 AL + 6 SAT,
kalanlar `/sinyaller`). Ortak şart: ort. işlem hacmi ≥ 50M$.

**AL = momentum lideri geri çekilmede** (ufuk ~1 ay):
- 12 aylık momentum (son ay hariç) evrenin **en iyi %20'sinde**
- 52 haftalık zirvenin **%5–%25 altında** (geri çekilme var, çökmüş değil) · 200 günlük ortalamanın üstünde
- fiyat ≥ $10 · teknik motor SAT demiyor · sıralama: momentum
- Seviyeler ATR'den: stop 2.5·ATR altı, hedef 5·ATR üstü (R:R 2)

**SAT = teyitli düşüş + zayıf momentum** (spotta çık / girme):
- motor SAT · güven ≥ 80 · ADX ≥ 25 · haftalık trend AŞAĞI · SPY'dan zayıf · RSI ≥ 30 · momentum alt %30

### Neden böyle? (research/ — 300 hisse, Haz 2023–Eki 2026, haftalık, 21 gün ufuk)
Ölçü: hissenin 21 günlük getirisi − aynı gün evrenin ortalaması (piyasanın yönü ölçüden çıkar).
Eğitim (< Mart 2025) ve test (≥ Mart 2025) dönemleri ayrı; yalnızca **ikisinde de tutan** kural alındı.

| Kural (günde ilk 10) | Eğitim | Test |
|---|---|---|
| Eski motor AL'i (BIST'ten gelen) | −%0.5 | −%0.1 |
| **Yeni AL** (momentum lideri geri çekilmede) | **+%2.1** | **+%3.7** |
| SAT (teyitli düşüş + zayıf momentum) — negatif = doğru | −%1.3 | −%1.1 |

Dürüst notlar: isabet ~%50, **medyan** fazla getiri yalnız +%0.3 → avantaj büyük kazananlardan gelir;
t-istatistiği ~1–1.5 (güçlü değil); evren bugünün likit hisseleri (hayatta kalan yanlılığı). Canlıda
`/spotkarne` ve haftalık rapor bunu ölçer.

## Opsiyon — yalnız ALIM

> 🔒 **YALNIZ ALIM MODU (varsayılan):** yalnızca **long call** ve **long put**. Hiçbir bacağı satış olan yapı
> önerilmez (put/call satışı, kredili spread, iron condor, borçlu spread dahil). `OPT_LONG_ONLY=0` eski geniş matrisi açar.

Günde 2 kez (10:15 ve 14:00 NY) en iyi fikirler + istek üzerine `/opsiyon SEMBOL`. Karar zinciri:

1. **Yön**: yalnız spot seçimi (AL → call, SAT → put). Seçim yoksa öneri yok.
   **Kalibre kayma**: ölçülen fazla getirinin **yarısı** (AL: kırpılmış +%1.45/ay → yıllık +0.09; SAT: yıllık −0.07).
2. **Oynaklık**: IV rank (≥20 gün geçmiş) yoksa IV/HV · vade yapısı · skew · beklenen hareket · bilanço tarihi.
   Fiziksel σ = 0.6·(0.9·IV) + 0.4·gerçekleşen; bilanço vade içinde ya da vade yapısı tersse σ ≥ IV.
3. **Adaylar**: vade 35–120 gün (kısa/orta/uzun: ~42/63/95 gün), delta 0.35–0.80, OI ≥ 100, spread ≤ %12;
   gerçekçi dolum (orta + %30 spread). Dayanak fiyatı zincirden (put-call paritesi); IV/Greek'ler kendimiz.
4. **Yönetilen işlem simülasyonu** (`options/sim.mjs`): her aday 2.000 fiyat yolunda **gün gün** yürütülür,
   her gün BS ile değerlenir ve **mesajdaki kurallar aynen** uygulanır (+%100 kâr al · −%50 zarar durdur ·
   vadeye 21 gün kala kapat; kapatırken de spread ödenir). Yollar: stokastik oynaklık karışımı (kalın kuyruk).
   → önerdiğimiz **işlemin** EV'si, kazanma oranı, ortalama süresi, çıkış nedenleri.
   (Vade-sonu EV'si bunu göstermez: ör. KR call'da vade-sonu +$263, yönetilen +$48 — zarar durdurma çok sık tetiklenir.)
5. **Kelly**: g(f) = E[ln(1 + f·R)] en büyüklenir → f*. Eleme: yönetilen EV ≥ %3 · maks zarar **ve** f* > 0.
   Sıralama: Kelly büyüme hızı (gün başına). **Boyut: ¼ Kelly**, üst sınır hesabın %2'si.
6. **Olağandışı hacim**: hacim ≥ 3× açık pozisyon ve ≥ 1.000 kontrat → `/opsiyon` çıktısında 🔥 (yön kanıtı değil).
7. **Yoğunlaşma**: aynı stratejiden ≤ 3, aynı sektörden ≤ 2, aynı yönden ≤ 4 fikir.

Beklenti: Alımda oynaklık primini sen ödersin, orta ölçekli hisselerin opsiyonları çoğu zaman illikittir →
**fikirler seyrek gelir**. Avantaj yoksa bot "BEKLE" der; bu bilinçli bir tasarımdır.

**Yönetim kuralları** (mesajda dolar tutarıyla):

| Yapı | Kâr al | Zarar durdur | Süre |
|---|---|---|---|
| Long call / put | +%100 | primin %50'si | vadeye 21 gün |
| *(OPT_LONG_ONLY=0)* Kredili | maks kârın %50'si | 2× kredi · kısa strike kırılırsa | vadeye 21 gün |
| *(OPT_LONG_ONLY=0)* Borçlu spread | maks kârın %75'i | primin %50'si | vadeye 10 gün |

## Karneler ve rapor
- **`/karne` — opsiyon:** açık fikirler her gün 15:00 NY sonrası **canlı alış/satış** fiyatıyla değerlenir, kural
  tetiklenince **"📕 OPSİYON FİKRİ KAPAT"** mesajı gelir. İki bölüm: *gerçekçi* (kurallarla; simülasyonun tahminiyle
  kıyas) ve *model kalibrasyonu* (vadeye kadar tutulsaydı; POP/EV tahminiyle kıyas).
- **`/spotkarne` — spot:** gönderilen her AL/SAT fiyat ve SPY ile kaydedilir; sinyal yönünde getiri ve SPY'a göre fark.
- **Haftalık rapor:** Cuma 15:30 NY (TR 23:30) — haftanın ve son 30 günün spot sonuçları, opsiyon karnesi, açık fikirler.
- **IV geçmişi:** her gün en likit 250 hisse + SPY/QQQ/IWM için IV30 (Gist `abd_ivhist.json`) → ~20 günde IV rank.

### Komutlar
`/hisse NVDA` (seçim + faktörler + teknik + **son haberler**) · `/opsiyon AAPL` · `/sinyaller` · `/karne` ·
`/spotkarne` · `/durum` · `/yardim`
> Komutlar bot çalışırken okunur (seans içinde ~20 dk gecikmeyle).

## Geriye dönük test ve araştırma
```bash
npm run backtest:signals                  # anahtarsız: geçmiş seçimler → dayanağın 21g getirisi vs taban
npm run backtest:opt                      # .env'de ALPACA anahtarlarıyla: seçimler → gerçek geçmiş opsiyon fiyatları
F_OUT=factors.json node research/factors.mjs && node research/evaluate.mjs factors.json   # faktör araştırması
```
GitHub'da: Actions → **Opsiyon geriye dönük test** → Run workflow (anahtarlar secret'lardan; sonuç iş özetinde).
Opsiyon testi: AL → call, SAT → put (≥35 gün, delta ≈ 0.6), giriş sinyalden sonraki gün kapanışı, canlı kurallarla
çıkış; **kontrol grubu** aynı hisse/gün ters yön; maliyet %0/%3/%6 duyarlılığı.

## Kurulum
1. **Yeni Telegram botu:** @BotFather → `/newbot` → token. @userinfobot → chat ID. Kendi botuna `/start` yaz.
   ⚠ bist-bot ile **aynı token'ı kullanma** — iki bot aynı token'dan komut okursa birbirinin komutlarını yutar.
2. **Gist:** gist.github.com → dosya `abd_state.json`, içerik `{}` → *secret gist* → URL'deki ID.
   Token: GitHub → Settings → Developer settings → Tokens (classic) → sadece `gist` izni.
3. **Alpaca (şiddetle önerilir):** ücretsiz hesap → Paper → API Keys. Toplu günlük mum (~60 istek), canlı IEX fiyatı,
   tatil takvimi, haberler, geçmiş opsiyon fiyatları.
4. Repo → Settings → Secrets and variables → Actions:

| Secret | Zorunlu |
|---|---|
| `TG_TOKEN`, `TG_CHAT` | ✅ |
| `GH_GIST_TOKEN`, `GIST_ID` | ✅ (yoksa durum, karneler ve IV geçmişi kaybolur) |
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` | önerilir (haberler ve opsiyon testi için gerekli) |

5. Actions → **ABD BOT — Spot + Opsiyon** → Run workflow (`force` işaretli) → Telegram'a mesaj düşmeli.

## Yerel kullanım
```bash
npm test                                         # birim testleri
npm run dry                                      # Telegram'a göndermeden tam tarama
DRY_RUN=1 FORCE=1 OPT_FORCE=1 SYMBOLS=AAPL,NVDA,SPY node bot/run.mjs   # opsiyon fikirleri dahil
DRY_RUN=1 FORCE=1 WEEKLY_FORCE=1 node bot/run.mjs                      # haftalık rapor dahil
npm run universe                                 # evreni yeniden kur (spot/universe.json)
```
Ayarlar (env) — spot: `MOM_TOP`, `HI52_MIN`, `HI52_MAX`, `MIN_PRICE_AL`, `MOM_SAT_MAX`, `MIN_CONF_SAT`, `MIN_ADX_SAT`,
`MIN_RSI_SAT`, `MIN_DVOL`, `MAX_AL_DAY`, `MAX_SAT_DAY`, `CORE_N` · opsiyon: `OPT_EDGE_AL`, `OPT_EDGE_SAT`,
`OPT_DIR_TRUST`, `OPT_MIN_EDGE`, `OPT_ACCOUNT`, `OPT_RISK`, `OPT_KELLY_FRAC`, `OPT_SIM_N`, `OPT_SIM_TOP`, `OPT_MIN_OI`,
`OPT_MAX_SPREAD`, `OPT_SLIP`, `OPT_LONG_ONLY`, `OPT_INV`, `OPT_INV_HARD`, `IV_TOP`.

## Dosyalar
```
core/engine.mjs        teknik motor (bist-bot kopyası)          core/backtest.mjs     eski spot backtest
data/yahoo.mjs         mum + opsiyon zinciri + risksiz faiz     data/alpaca.mjs       toplu mum, canlı fiyat, saat,
data/market.mjs        NY seans saatleri                                              haberler, geçmiş opsiyon mumları
universe/build.mjs     S&P 500 + Nasdaq → likidite → spot/universe.json
spot/scan.mjs          analiz + faktörler + kesitsel momentum sırası + seçim kuralları + tarama
research/factors.mjs   faktör veri seti           research/evaluate.mjs   eğitim/test ayrı kural değerlendirmesi
options/bs.mjs         Black-Scholes, Greek'ler, IV çözücü
options/dist.mjs       log-normal & Student-t dağılım, vade-sonu EV/POP/CVaR, kâr-zarar profili
options/sim.mjs        yönetilen işlem simülasyonu + Kelly
options/chain.mjs      zincir yükleme + kendi IV/delta hesabı + likidite + vade seçimi
options/vol.mjs        HV (C2C, Yang-Zhang), ATM IV, IV30, vade yapısı, skew, beklenen hareket, rejim
options/strategies.mjs aday yapılar                options/flow.mjs   olağandışı opsiyon hacmi
options/engine.mjs     yön → aday → simülasyon → Kelly → seçim
options/backtest.mjs   opsiyon geriye dönük testi (Alpaca)
options/ivhist.mjs     IV30 geçmişi (IV rank)      options/book.mjs   opsiyon karnesi (günlük değerleme, kurallar)
options/format.mjs     Telegram mesajları
bot/run.mjs            ana akış + komutlar + haftalık rapor     bot/spotbook.mjs  spot karnesi
bot/state.mjs          Gist                                      bot/telegram.mjs  Telegram (parçalama, tekrar deneme)
```

## Veri notları ve sınırlar
- Opsiyon zinciri Yahoo'dan (~15 dk gecikmeli, gerçek alış/satış). **Emir öncesi canlı fiyatı kontrol et.**
- Gerçek zamanlı opsiyon verisi ücretsiz değil (Alpaca OPRA aboneliği ya da aracı kurum verisi).
- Modeller Avrupa tipi BS varsayar; simülasyon IV'yi sabit tutar (IV düşüşü/yükselişi modellenmez).
- Araştırma sonuçları geçmişe aittir; hayatta kalan yanlılığı ve rejim değişimi riski vardır.

> ⚠ Yatırım tavsiyesi değildir. Kişisel kullanım içindir.
