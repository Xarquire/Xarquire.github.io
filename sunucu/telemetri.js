// Kasaların teknik durumu (K16) → Cloudflare D1 (bağlama TELEMETRI, veritabanı
// smartmenuos-telemetri). Kurulum başına TEK, güncel satır; geçmiş tutulmaz (protokol §11.3).
// Yalnızca teknik bilgi: sürüm, kanal, güncelleme sonucu, son yedek, QR/tünel, tünel programı
// sürümü, son 24 saatteki hata sayısı, disk boşluğu, saat farkı, program dosyalarının bütünlüğü
// (1.8.0 aşama 5, K7) ve (imzalı başlıktan) kurulum, işletme, lisans bitişi ve üretim anı.
// Sipariş, masa, ciro bilgisi GİTMEZ; bilinmeyen alan hiçbir yere yazılmaz (istek reddedilmez, yok sayılır).
// 180 gün görülmeyen satır her gün silinir (index.js → scheduled).
//
// D1 yalnızca telemetri tutar: hatası durum cevabını bozmaz (yutulur, günlüğe "d1-hata").
// Değerler SQL'e hiçbir zaman metin olarak eklenmez; hep prepare().bind().

import { GUN_MS, utcMetin, utcCoz, gunluk } from "./belgeler.js";

// Aynı metin d1/kasa_durum.sql'de (elle oluşturma ve belge; sınama karşılaştırır).
export const TABLO_SQL =
  "CREATE TABLE IF NOT EXISTS kasa_durum (kurulum TEXT PRIMARY KEY, isletme TEXT, surum TEXT, kanal TEXT, " +
  "guncelleme_sonucu TEXT, son_yedek_utc TEXT, qr TEXT, tunel TEXT, hata24 INTEGER, disk_bos_mb INTEGER, " +
  "saat_farki_dk INTEGER, son_gorulme_utc TEXT, lisans_bitis TEXT, lisans_uretim_utc TEXT, son_cevap INTEGER, " +
  "tunel_surum TEXT, butunluk TEXT)";

// Eski tabloya (Worker bu sürümden önce yayınlandıysa) sonradan eklenen sütunlar, sırasıyla
// (1.8.0 K2: tunel_surum; 1.8.0 aşama 5 K7: butunluk). Her biri ayrı denenir; tekrar
// çalıştırılabilir: "duplicate column" hatası yutulur (yeni tabloda ya da önceki yayında eklenmiş).
export const SUTUN_EKLE_SQL = [
  "ALTER TABLE kasa_durum ADD COLUMN tunel_surum TEXT",
  "ALTER TABLE kasa_durum ADD COLUMN butunluk TEXT",
];

// Şemadaki sütunlar, sırasıyla (YAZ_SQL'deki ?1…?17).
export const SUTUNLAR = [
  "kurulum", "isletme", "surum", "kanal", "guncelleme_sonucu", "son_yedek_utc", "qr", "tunel", "hata24",
  "disk_bos_mb", "saat_farki_dk", "son_gorulme_utc", "lisans_bitis", "lisans_uretim_utc", "son_cevap",
  "tunel_surum", "butunluk",
];

export const YAZ_SQL =
  "INSERT INTO kasa_durum (kurulum, isletme, surum, kanal, guncelleme_sonucu, son_yedek_utc, qr, tunel, hata24, " +
  "disk_bos_mb, saat_farki_dk, son_gorulme_utc, lisans_bitis, lisans_uretim_utc, son_cevap, tunel_surum, butunluk) " +
  "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17) " +
  "ON CONFLICT(kurulum) DO UPDATE SET isletme = excluded.isletme, surum = excluded.surum, kanal = excluded.kanal, " +
  "guncelleme_sonucu = excluded.guncelleme_sonucu, son_yedek_utc = excluded.son_yedek_utc, qr = excluded.qr, " +
  "tunel = excluded.tunel, hata24 = excluded.hata24, disk_bos_mb = excluded.disk_bos_mb, " +
  "saat_farki_dk = excluded.saat_farki_dk, son_gorulme_utc = excluded.son_gorulme_utc, " +
  "lisans_bitis = excluded.lisans_bitis, lisans_uretim_utc = excluded.lisans_uretim_utc, son_cevap = excluded.son_cevap, " +
  "tunel_surum = excluded.tunel_surum, butunluk = excluded.butunluk";

export const SAKLAMA_GUN = 180;
export const BUDA_SQL = "DELETE FROM kasa_durum WHERE son_gorulme_utc < ?1";

// Kasanın gönderdiği telemetri alanları (KASA-DURUM'un TelemetriAlanlari.TelemetriAlanAdlari
// sabitiyle aynı sıra ve adlar, TunelKaynakTaramasiTests K06; aydınlatma metni bu listeden
// üretilir). Başka alan yazılmaz. "butunluk" (1.8.0 aşama 5, K7; BUTUNLUK_ALANI) 1.8.0 kasası
// gönderir; eski kasa göndermez (sütun null). Bu Worker'dan önceki sürüm alanı yok sayar.
export const TELEMETRI_ALANLARI = ["guncellemeSonucu", "sonYedekUtc", "qr", "tunel", "hata24", "diskBosMB", "tunelSurum", "butunluk"];

// (1.8.0 aşama 5, K7) Program dosyalarının bütünlüğü: Core TelemetriAlanlari.ButunlukDegerleri ile
// aynı küme (LisansKorumaTests TA3). Başka değer, eski kasa (alan yok) ve bozuk tür → null.
export const BUTUNLUK_ALANI = "butunluk";
export const BUTUNLUK_DEGERLERI = ["iyi", "uyumsuz", "bilinmiyor"];

const SURUM = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const KANAL = /^[a-z0-9-]{1,32}$/;
// cloudflared sürümü (YIL.AY.YAMA; Core DisProgram.TunelSurumu.Gecerli ile aynı küme).
const TUNEL_SURUM = /^20\d{2}\.(1[0-2]|[1-9])\.\d{1,3}$/;
const ISLETME_EN_COK = 120;
const SAAT_FARKI_EN_COK = 5256000; // dakika (10 yıl)

const secenek = (deger, izinli) => (typeof deger === "string" && izinli.includes(deger) ? deger : null);
const tamsayi = (deger, enCok) => (Number.isInteger(deger) && deger >= 0 && deger <= enCok ? deger : null);
const duzNesne = (x) => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * D1 satırı (SUTUNLAR adlarıyla). Geçersiz alan null yazılır; telemetri hatası isteği
 * reddettirmez. kurulum, işletme, bitiş, üretim anı imzalı lisanstan gelir, gövdeden değil.
 */
export function telemetriHazirla({ govde, lisans, kasaSaati, simdi }, sonCevap) {
  const g = duzNesne(govde) ? govde : {};
  const t = duzNesne(g.telemetri) ? g.telemetri : {};

  let fark = null;
  if (kasaSaati instanceof Date && !Number.isNaN(kasaSaati.getTime())) {
    const dk = (kasaSaati.getTime() - simdi.getTime()) / 60000;
    fark = Math.sign(dk) * Math.round(Math.abs(dk)); // yarım dakika sıfırdan uzağa yuvarlanır
    fark = Math.max(-SAAT_FARKI_EN_COK, Math.min(SAAT_FARKI_EN_COK, fark)) || 0;
  }

  const isletme = typeof lisans.isletme === "string" && lisans.isletme !== ""
    ? Array.from(lisans.isletme).slice(0, ISLETME_EN_COK).join("")
    : null;

  return {
    kurulum: lisans.kurulumKimligi,
    isletme,
    surum: typeof g.surum === "string" && SURUM.test(g.surum) ? g.surum : null,
    kanal: typeof g.kanal === "string" && KANAL.test(g.kanal) ? g.kanal : null,
    guncelleme_sonucu: secenek(t.guncellemeSonucu, ["tamam", "yarida", "yok"]),
    son_yedek_utc: utcCoz(t.sonYedekUtc) ? t.sonYedekUtc : null,
    qr: secenek(t.qr, ["acik", "kapali"]),
    tunel: secenek(t.tunel, ["acik", "kapali", "yok"]),
    hata24: tamsayi(t.hata24, 1000000),
    disk_bos_mb: tamsayi(t.diskBosMB, 100000000),
    saat_farki_dk: fark,
    son_gorulme_utc: utcMetin(simdi),
    lisans_bitis: typeof lisans.bitis === "string" ? lisans.bitis : null,
    lisans_uretim_utc: typeof lisans.uretimUtc === "string" ? lisans.uretimUtc : null,
    son_cevap: Number.isInteger(sonCevap) ? sonCevap : null,
    tunel_surum: typeof t.tunelSurum === "string" && TUNEL_SURUM.test(t.tunelSurum) ? t.tunelSurum : null,
    butunluk: secenek(t[BUTUNLUK_ALANI], BUTUNLUK_DEGERLERI),
  };
}

// Tablo isolate başına bir kez oluşturulur (CREATE TABLE IF NOT EXISTS), eski tabloya eksik
// sütunlar eklenir (SUTUN_EKLE_SQL); D1 hatasında sıfırlanır, sonraki istek yeniden dener.
// Göç aracı gerekmez.
let tabloHazir = null;

async function tabloyuHazirla(d1) {
  if (!tabloHazir) {
    tabloHazir = (async () => {
      await d1.prepare(TABLO_SQL).run();
      for (const sql of SUTUN_EKLE_SQL) {
        try {
          await d1.prepare(sql).run();
        } catch (e) {
          if (!/duplicate column/i.test(String(e && e.message))) throw e;
        }
      }
    })();
  }
  await tabloHazir;
}

/** Kurulumun satırını yazar (upsert). Hata atmaz. */
export async function telemetriYaz(d1, kayit) {
  if (!d1) return;
  try {
    await tabloyuHazirla(d1);
    await d1.prepare(YAZ_SQL).bind(...SUTUNLAR.map((s) => (kayit[s] === undefined ? null : kayit[s]))).run();
  } catch {
    tabloHazir = null;
    gunluk("d1-hata", kayit && kayit.kurulum);
  }
}

/** 180 gün görülmeyen satırları siler (günlük zamanlanmış görev). Hata atmaz. */
export async function telemetriBuda(d1, simdi) {
  if (!d1) return;
  try {
    await tabloyuHazirla(d1);
    await d1.prepare(BUDA_SQL).bind(utcMetin(simdi.getTime() - SAKLAMA_GUN * GUN_MS)).run();
  } catch {
    tabloHazir = null;
    gunluk("d1-hata", null);
  }
}

/** Yalnız sınama: isolate önbelleğini boşaltır. */
export function _testIcinSifirla() {
  tabloHazir = null;
}
