# 🦅 EAGLE-EYE US IQ — Spot + Opsiyon öneri botu (Telegram)

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
| — | Spot çıkış planı · boyut + sektör sınırı · bilanço öncesi opsiyon çıkışı · `/takip` | ✅ |
| 4 | Model portföy (Alpaca paper, `PAPER_TRADE=1` ile açılır) | ✅ |
| 2 | Temel analiz: SEC EDGAR (marj, büyüme, sulandırma) | ⏳ (SEC iletişim bilgisi ister) |

## Spot — ne seçer, neden
Seans boyunca ~10 dk'da bir 1.331 hisse **canlı fiyatla** taranır; **yeni** seçimler gönderilir (günlük kota: 10 AL + 6 SAT,
kalanlar `/sinyaller`). Ortak şart: ort. işlem hacmi ≥ 50M$.

**AL = momentum lideri geri çekilmede** (ufuk ~1 ay):
- 12 aylık momentum (son ay hariç) evrenin **en iyi %20'sinde**
- 52 haftalık zirvenin **%5–%25 altında** (geri çekilme var, çökmüş değil) · 200 günlük ortalamanın üstünde
- fiyat ≥ $10 · teknik motor SAT demiyor · son 10 günde hacimli sert düşüş (≤ −%5, hacim ≥ 3×) yok · sıralama: momentum
- Seviyeler ATR'den: stop 2.5·ATR altı, hedef 5·ATR üstü (R:R 2)
- **Çıkış planı**: stop kırılınca, hedefe ulaşınca ya da **21 işlem günü** dolunca "📕 SPOT ÇIKIŞ" mesajı gelir
- **Boyut**: stop'a kadar portföyün %1'i riske (`RISK_SPOT`), tek hisse en çok %10 (`MAX_POS`);
  aynı gün aynı sektörden en çok 3 sinyal (`SEC_CAP`)

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
| AL adayı + son 10 günde hacimli sert düşüş → **elenir** | −%0.4 (isabet %32) | −%2.2 (isabet %36) |
| **Hayatta kalan yanlılığı temizlenmiş** (o tarihteki S&P 500 üyeleri, 573 hisse): AL ilk 10 | **+%1.5** | **+%2.1** |
| aynı veri: SAT (negatif = doğru; kırpılmış ort. yalnız −%0.1) | −%0.7 | −%0.9 |
| Bilanço sonrası yukarı trend (hacimli +%5 şok) — *eklenmedi, tutarsız* | +%0.5 | +%1.0 (t ≤ 1) |

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
   vadeye 21 gün kala kapat — kâr hedefi yok; kapatırken de spread ödenir). Yollar: stokastik oynaklık karışımı.
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
| Long call / put | **yok** (test #4: kâr hedefi koymamak −%6.1 → −%2.8) | primin %50'si | vadeye 21 gün · **vade içinde bilanço varsa bilançodan 1 gün önce** |
| *(OPT_LONG_ONLY=0)* Kredili | maks kârın %50'si | 2× kredi · kısa strike kırılırsa | vadeye 21 gün |
| *(OPT_LONG_ONLY=0)* Borçlu spread | maks kârın %75'i | primin %50'si | vadeye 10 gün |

## Karneler ve rapor
- **`/karne` — opsiyon:** açık fikirler her gün 15:00 NY sonrası **canlı alış/satış** fiyatıyla değerlenir, kural
  tetiklenince **"📕 OPSİYON FİKRİ KAPAT"** mesajı gelir. İki bölüm: *gerçekçi* (kurallarla; simülasyonun tahminiyle
  kıyas) ve *model kalibrasyonu* (vadeye kadar tutulsaydı; POP/EV tahminiyle kıyas).
- **`/spotkarne` — spot:** gönderilen her AL/SAT fiyat ve SPY ile kaydedilir; sinyal yönünde getiri ve SPY'a göre fark.
- **Haftalık rapor:** Cuma 15:30 NY (TR 23:30) — haftanın ve son 30 günün spot sonuçları, opsiyon karnesi, açık fikirler,
  model portföy, takip listesi.
- **Takip listesi (`/takip SEMBOL`):** sahip olduğun hisse için uyarı — bot SAT seçimi verirse, 200 günlük ortalama
  aşağı kırılırsa, takipteki zirvesinden %8 geri çekilirse (`WATCH_TRAIL`).
- **Model portföy (`/portfoy`, `bot/model.mjs`) — her zaman açık, sanal:** $100.000 (`MODEL_CAPITAL`), en çok 15
  pozisyon (`MODEL_SLOTS`), eşit ağırlık; AL seçimleri kalite sırasıyla boş slotlara alınır, stop / hedef / 21 işlem
  günü ile satılır; her işlemde %0.05 maliyet; günlük özsermaye ve SPY kaydı. Telegram:
  - her alım/satımda kısa **işlem** mesajı,
  - **haftalık rapor** her Cuma 15:30 NY sonrası (TR ~23:30),
  - **aylık rapor** yeni ayın ilk işlem günü 10:00 NY sonrası (önceki ay),
  - **3 aylık rapor** Ocak/Nisan/Temmuz/Ekim'in ilk işlem günü (önceki çeyrek).
  Rapor: dönem getirisi, SPY ve fark, en büyük düşüş, kapanan işlemler, en iyi/en kötü, açık pozisyonlar.
- **Opsiyon model portföyleri (`bot/optmodel.mjs`) — üç vade kolu, her biri $25.000, yalnız ALIM:**
  - **Haftalık** (vade 4–10 gün, delta ≈ 0.5): sabah SPY/QQQ CALL çağrıları · vadeden ~1 işlem günü önce çıkış
  - **Aylık** (vade 35–50 gün, delta ≈ 0.6): ETF fırsatları (RSI2 call, aşırı korku call, put) · vadeye 21 gün kala çıkış
  - **3 aylık** (vade 80–110 gün, delta ≈ 0.6): günün spot AL'leri (call) ve SAT'ı (put), likit olanlardan günde en çok
    2 call + 1 put · vadeye 30 gün kala çıkış
  - Ortak: pozisyon başına kolun %10'u (tek kontrat aşarsa %20'ye kadar 1 adet), en çok 8 açık, zarar durdurma −%50,
    kâr hedefi yok (test #4), giriş/çıkış orta ± %30 spread, günde bir canlı zincirle değerleme. İşlem mesajı her
    alım/satımda; kollar haftalık / aylık / 3 aylık **model portföy raporlarına** eklenir; `/portfoy`'da görünür.
- **💎 Değer (ucuz hisse) portföyü (`bot/value.mjs`) — $100.000:** S&P 500 + ≥ $10 milyar Nasdaq, fiyat ≥ $10.
  Kalite kapıları (değer tuzağına karşı): kârlı (EPS > 0, marj > %5, özsermaye kârlılığı > %8), borç/özsermaye < 200,
  serbest nakit akışı > 0, bot SAT demiyor, 52h zirvenin ≥ %60'ı. Ucuzluk puanı: 1/FK, 1/ileri FK, 1/PDDD,
  1/(FD/FAVÖK), FCF verimi (evren içi yüzdelik ortalaması). En ucuz 10 (sektör başına ≤ 2), eşit ağırlık; **aylık**
  yeniden dengeleme (yeni ayın ilk işlem günü). Haftalık / aylık / 3 aylık raporlarda ve `/portfoy`'da.
  ⚠ Geçmiş temel veriler ücretsiz olmadığı için **geriye dönük test edilemedi** → canlı karne (SPY'a göre) ile ölçülür.
- **Alpaca paper (isteğe bağlı):** Variables → `PAPER_TRADE` = `1` → aynı AL'leri Alpaca **paper** hesabında braket
  emirle uygular (gerçek dolum); gerçek hesaba dokunmaz (uç nokta sabit `paper-api`).
- **0DTE/1DTE:** eklenmedi — yalnız alımla %90 kâr olasılığı matematiksel olarak mümkün değil (ATM'de başabaş fiyatın
  üstünde → ~%40–45; derin ITM'de ~%50); en iyi ölçülen gün içi kural %55–61 isabet.
- **IV geçmişi:** her gün en likit 250 hisse + SPY/QQQ/IWM için IV30 (Gist `abd_ivhist.json`) → ~20 günde IV rank.

### Komutlar
`/hisse NVDA` (seçim + faktörler + teknik + **son haberler**) · `/opsiyon AAPL` · `/sinyaller` · `/karne` ·
`/spotkarne` · `/takip SEMBOL` · `/birak SEMBOL` · `/takiplerim` · `/portfoy` · `/etf` · `/durum` · `/yardim`
> Komutlar bot çalışırken okunur (seans içinde ~10 dk gecikmeyle).

**Butonlar:** spot sinyal mesajında her hisse için 🔎 butonu (`/hisse`), `/hisse` altında "📊 Opsiyon analizi" ve
"👁 Takip et", opsiyon fikirlerinde 📊, ETF fırsatında "⚡ SPY/QQQ durumu". Tıklama bir komut gibi işlenir.
**Grafik:** `/hisse` son ~6 ayın fiyatı + 50g/200g ortalama + stop/hedef çizgileriyle gelir (quickchart.io; yalnız
herkese açık fiyat verisi gider; `CHARTS=0` kapatır).
**Yapay zekâ yorumu (isteğe bağlı):** `ANTHROPIC_API_KEY` secret'ı eklenirse spot sinyallerine ve `/hisse`'ye
Claude'dan 2-3 cümlelik Türkçe yorum eklenir — yalnız mesajdaki metriklere (ve haber başlıklarına) dayanır, fiyat
tahmini yapmaz. Model: `AI_MODEL` repo değişkeni (varsayılan `claude-opus-5-5`, düşük effort); güvenlik reddinde sunucu
tarafı yedek model. SDK GitHub'da kurulur; kurulum ya da çağrı başarısız olursa bot yorumsuz devam eder. Maliyet: mesaj
başına bir istek (yaklaşık birkaç sent / gün).

## 🌅 Açılış öncesi mesaj — SPY / QQQ gün içi call (`bot/morning.mjs`)
Her işlem günü 07:30–09:29 NY arasında (TR ~15:30–17:30) bir kez: VIX seviyesi/değişimi, ES/NQ vadeli (gece hareketi),
trend (200g), RSI(2), haber başlıkları. Ölçülmüş (`research/premarket.mjs`, açılış→kapanış, 1993–2026, eğitim/test,
SPY ve QQQ) üç yukarı koşul: **VIX > 30** · **VIX dün ≥ +%10 & trend yukarı** · **RSI(2) < 10 & trend yukarı**.
- Skor ≥ 1 → **CALL (gün içi)**: geçmiş isabet SPY %55–56 (skor ≥ 2: %53–61), ort. +7…+20 bp; **HEDEF / STOP** = tahmini
  açılış ± 0.5 × beklenen günlük hareket (VIX/√252; QQQ ×1.25); hiçbiri olmazsa kapanışta çık; ≥ 2 günlük vadeli
  ~0.5 delta call önerilir.
- Skor 0 (günlerin ~%84'ü) → **NÖTR**, işlem önerilmez (gün içi yön geçmişte yazı-tura).
- CALL günlerinde **üç vade seçeneği**: **0DTE** (bugün), **1DTE** (yarın), **haftalık** (~1 hafta), her biri ATM'ye yakın
  (delta ≈ 0.5) kontrat, fiyat (orta + %30 spread), başabaş ve **vadede kâr olasılığı** (log-normal; kontratın IV'si +
  ölçülmüş gün içi avantaj). Yalnız alımda bu olasılık tipik olarak %30–45'tir — %90 değil; mesaj bunu açık yazar.
- **Aşırı korku** (Korku & Açgözlülük < 25) varsa ayrıca **2–3 hafta vadeli call** (delta ≈ 0.6) önerisi ve kâr olasılığı.
- **Sabah put önerilmez**: açılış öncesi bilgiyle düşüş yönünde ölçülmüş avantaj yok (test döneminde zarar). Gün içi
  düşüş sinyalinde ETF modülü ayrıca PUT bildirir.
- `/sabah`: çağrıların karnesi (gün yukarı kapandı mı, hedef/stop görüldü mü). Tatil günleri Alpaca takviminden atlanır.

## 😨 Korku & Açgözlülük endeksi (`spot/feargreed.mjs`)
CNN'in veri uç noktası otomatik istekleri engelliyor (HTTP 418) — engel aşılmaz. Bunun yerine **CNN'in yayımladığı
yöntemle** kendi endeksimiz: günlük geçmişi ücretsiz olan 4 bileşen — S&P 500 / 125g ortalama (momentum), VIX / 50g
ortalama (ters), SPY − TLT 20g getiri (güvenli liman), HYG − IEF 20g getiri (riskli tahvil). Her bileşen son 252 güne
göre yüzdelik sıra, endeks = ortalama (0 aşırı korku … 100 aşırı açgözlülük). Ölçüm (`research/feargreed.mjs`, 2008–2026,
eğitim < 2017 ≤ test):
- **Aşırı korku (< 25) → 5–10 gün yukarı:** 10 gün sonra SPY +%0.62 / +%0.73 (taban +%0.28 / +%0.53), QQQ +%0.76 /
  +%1.01 (taban +%0.50 / +%0.77); yükselen oran tabanla benzer → avantaj ortalamada.
- Aşırı açgözlülük (> 75): iki dönemde tutarsız → **satış/put sinyali olarak kullanılmaz**. 1 günlük etki tutarsız →
  sabah gün içi skoruna katılmaz (yalnız gösterilir).
- Kullanım: ETF modülünde **"😱 AŞIRI KORKU call"** (SPY/QQQ, ≥ 30 gün vade, delta ≈ 0.6): endeks ≥ 50'ye dönünce ya da
  10 işlem günü sonra **KAPAT**. Sabah mesajı, `/etf`, `/durum` ve haftalık raporda endeks + bileşenleri. `FG_ETF=0` kapatır.

## SPY / QQQ kısa vade call ve put (yalnız ALIM — opsiyon satışı yok)
**Call** (`spot/etfsignal.mjs`): kapanış > 200g ortalama **ve** RSI(2) < 5 (güçlü) / < 10 (normal) → **kapanış 5g
ortalamanın üstüne çıkınca** ya da en çok 10 işlem günü sonra çık. Ölçüm (`research/etf.mjs`, eğitim < 2014 ≤ test):
isabet SPY %82 / %78, QQQ %71 / %81; ort. +%0.6–0.8; ~3 gün; günlük getiri tabanın 4–6 katı.
**Put** (zayıf): kapanış < 200g ortalama **ve** RSI(2) > 90 → kapanış 5g ortalamanın **altına inince** çık. Ölçüm: isabet
SPY %72 / %59, QQQ %55 / %63; ort. düşüş +%0.15–0.94 — dört ölçümde pozitif ama call'dan zayıf (`ETF_PUTS=0` kapatır).
Bot 15:30 NY sonrası günde bir kontrol eder; sinyalde canlı zincirden kontrat önerir (vade ≥ `ETF_DTE`=30 gün,
|delta| ≈ `ETF_DELTA`=0.6, likit), çıkış koşulunda **"📕 ETF KAPAT"** gönderir, ETF karnesine yazar.
**Hisse SAT seçimlerinde long put** önerilir (`OPT_PUTS=0` kapatır); her fikir yönetilen işlem simülasyonu + Kelly'den geçer.
Vade/delta seçimi: Actions → **ETF opsiyon geriye dönük test** (14/30/60 gün × delta 0.5/0.7, gerçek opsiyon fiyatları).

## Geriye dönük test ve araştırma
```bash
npm run backtest:signals                  # anahtarsız: geçmiş seçimler → dayanağın 21g getirisi vs taban
npm run backtest:opt                      # .env'de ALPACA anahtarlarıyla: seçimler → gerçek geçmiş opsiyon fiyatları
F_OUT=factors.json node research/factors.mjs && node research/evaluate.mjs factors.json   # faktör araştırması
```
GitHub'da: Actions → **Opsiyon geriye dönük test** → Run workflow (anahtarlar secret'lardan; sonuç iş özetinde).
Opsiyon testi: AL → call, SAT → put (≥35 gün, delta ≈ 0.6), giriş sinyalden sonraki gün kapanışı, canlı kurallarla
çıkış; **kontrol grubu** aynı hisse/gün ters yön; maliyet %0/%3/%6 duyarlılığı; 8 çıkış kuralı varyantı;
**girişteki IV/HV dilimleri** ("ucuz IV'de almak daha mı iyi?"); `min_dte` = 180 ile **LEAPS** modu. Sonuç Telegram'a da gelir.
Hayatta kalan yanlılığına karşı: `F_PIT=sp500_ticker_start_end.csv` ile araştırma her tarihte yalnız o günkü S&P 500
üyelerini kullanır (fja05680/sp500).

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
| `ANTHROPIC_API_KEY` | isteğe bağlı (yapay zekâ yorumu) |

Repo **değişkenleri** (Variables): `PAPER_TRADE` = `1` (model portföy), `AI_MODEL` (yorum modeli).
Herhangi bir workflow başarısız olursa Telegram'a 🚨 alarm gelir; tarama her çalışmadan önce birim testlerini koşar.

5. Actions → **EAGLE-EYE US IQ — Spot + Opsiyon** → Run workflow (`force` işaretli) → Telegram'a mesaj düşmeli.

## Yerel kullanım
```bash
npm test                                         # birim testleri
npm run dry                                      # Telegram'a göndermeden tam tarama
DRY_RUN=1 FORCE=1 OPT_FORCE=1 SYMBOLS=AAPL,NVDA,SPY node bot/run.mjs   # opsiyon fikirleri dahil
DRY_RUN=1 FORCE=1 WEEKLY_FORCE=1 node bot/run.mjs                      # haftalık rapor dahil
npm run universe                                 # evreni yeniden kur (spot/universe.json)
```
Ayarlar (env) — spot: `MOM_TOP`, `HI52_MIN`, `HI52_MAX`, `MIN_PRICE_AL`, `MOM_SAT_MAX`, `MIN_CONF_SAT`, `MIN_ADX_SAT`,
`MIN_RSI_SAT`, `MIN_DVOL`, `MAX_AL_DAY`, `MAX_SAT_DAY`, `SEC_CAP`, `RISK_SPOT`, `MAX_POS`, `SPOT_HOLD`, `WATCH_TRAIL`, `CORE_N` · opsiyon: `OPT_EDGE_AL`, `OPT_EDGE_SAT`,
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
bot/run.mjs            ana akış + komutlar + haftalık rapor     bot/spotbook.mjs  spot karnesi + çıkış planı
bot/watch.mjs          takip listesi                             bot/paper.mjs     model portföy (Alpaca paper)
bot/state.mjs          Gist                                      bot/telegram.mjs  Telegram (parçalama, tekrar deneme)
```

## Veri kaynakları (Investing.com kullanılmaz)
| Veri | Kaynak | Canlılık |
|---|---|---|
| Hisse son fiyatı (sinyal anı) | **Alpaca IEX** | gerçek zamanlı (tek borsa) |
| Günlük mumlar (göstergeler) | **Alpaca SIP** (anahtar yoksa Yahoo) | 15 dk gecikmeli; son mum canlı fiyatla güncellenir |
| Opsiyon zinciri, risksiz faiz | **Yahoo** | ~15 dk gecikmeli, gerçek alış/satış |
| Haberler | Alpaca (Benzinga) | gerçek zamanlı |
| Geçmiş opsiyon fiyatları (test) | Alpaca (indicative) | Şubat 2024'ten beri |

**Veri sağlığı** her taramada ölçülür (canlı fiyat gelen hisse sayısı, medyan yaş) ve `/durum`'da görünür; seans içinde
canlı fiyat %50'nin altına düşer ya da 30 dk'dan bayatlarsa Telegram'a **⚠ VERİ UYARISI** gelir (günde 1).
Ayrıca seans içinde her taramada **SPY çapraz kontrolü**: Alpaca canlı fiyatı 5 dk'dan eskiyse ya da Yahoo fiyatından
%0.3'ten fazla saparsa aynı uyarı gelir (log'da her turda yazılır: `Çapraz kontrol SPY: …`).
Tarama ~10 dk'da bir — sinyal, koşul oluştuğu turda (en geç ~10 dk içinde) gelir.

**AL/SAT iyileştirme denemeleri** (o tarihteki S&P 500 üyeleri): kısa vadeli geri çekilmede giriş, RSI filtresi, 50g
ortalama, 6 aylık / birleşik momentum, tepki yükselişinde SAT, çöküş ve hacimli şok kuralları dahil 13 varyant
denendi; hiçbiri mevcut kuralları **iki dönemde birden** geçemedi (bazıları yalnız test döneminde iyi → aşırı uyum
riski) → kurallar değiştirilmedi.

## Veri notları ve sınırlar
- Opsiyon zinciri Yahoo'dan (~15 dk gecikmeli, gerçek alış/satış). **Emir öncesi canlı fiyatı kontrol et.**
- Gerçek zamanlı opsiyon verisi ücretsiz değil (Alpaca OPRA aboneliği ya da aracı kurum verisi).
- Modeller Avrupa tipi BS varsayar; simülasyon IV'yi sabit tutar (IV düşüşü/yükselişi modellenmez).
- Araştırma sonuçları geçmişe aittir; hayatta kalan yanlılığı ve rejim değişimi riski vardır.

> ⚠ Yatırım tavsiyesi değildir. Kişisel kullanım içindir.
