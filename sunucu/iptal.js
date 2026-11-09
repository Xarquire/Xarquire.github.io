// Kurulumun uzaktan durum kaydı (KV "kurulum/<k>") ve askı/iptal kilit anı.
// /lisans/durum (lisans-durum.js) ve paket kapısı (guncelleme.js) bunu ortak kullanır.
//
// KV düzeni (protokol §3.2):
//   kurulum/<k>            {"iptal": "SMI1…" | null, "anahtar": "QRM1…" | null}  — tek yazar Lisans Yönetimi
//   iptalgorulme/<k>/<sıra> iptalin bu kuruluma İLK sunulduğu an (UTC)          — tek yazar Worker
//
// Kilit anı kasadaki UzaktanKarar ile aynı formül (protokol §5.4); kasa yerel 06:00
// kullanır, Worker Türkiye 06:00'sını sabit 03:00 UTC sayar.

import { GUN_MS, utcCoz, iptalKaydiCoz, gunluk } from "./belgeler.js";

export const UYARI_GUN = 3;                 // K2 / protokol §5.4
export const VARSAYILAN_SINIR_GUN = 30;     // K1, QRM1 alan 12 boş
export const TR_SABAH_UTC_SAATI = 3;        // 06:00 Türkiye = 03:00 UTC (2016'dan beri yaz saati yok)
export const KAYIT_EN_COK = 16384;          // kurulum/<k> değerinin en büyük boyu
export const GELECEK_PAYI_MS = 10 * 60000;  // ilk görülme şimdiden 10 dk'dan ileriyse bozuk sayılır
export const kurulumAnahtari = (k) => "kurulum/" + k;
export const gorulmeAnahtari = (k, sira) => "iptalgorulme/" + k + "/" + sira;

/**
 * kurulum/<k> kaydını okur. durum: "yok" (kayıt yok), "var", "hata" (KV okunamadı),
 * "bozuk" (JSON değil, düz nesne değil, iptal metin değil, çok büyük). Anahtar alanı
 * metin değilse yalnızca anahtar atlanır (kayıt bozuk sayılmaz). Bilinmeyen alanlar yok sayılır.
 */
export async function kurulumKaydiOku(kv, k) {
  const sonuc = (durum, iptalMetni = null, anahtarMetni = null) => ({ durum, iptalMetni, anahtarMetni });

  let deger;
  try {
    deger = await kv.get(kurulumAnahtari(k));
  } catch {
    return sonuc("hata");
  }
  if (deger === null || deger === undefined) return sonuc("yok");
  if (typeof deger !== "string" || deger.length > KAYIT_EN_COK) return sonuc("bozuk");

  let j;
  try {
    j = JSON.parse(deger);
  } catch {
    return sonuc("bozuk");
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return sonuc("bozuk");

  let iptal = null;
  if (j.iptal !== undefined && j.iptal !== null) {
    if (typeof j.iptal !== "string") return sonuc("bozuk");
    iptal = j.iptal;
  }
  const anahtar = typeof j.anahtar === "string" ? j.anahtar : null;
  return sonuc("var", iptal, anahtar);
}

/**
 * iptalgorulme/<k>/<sıra> değerini okur. Dönüş { durum, an }: "var" (an: Date), "yok" (kayıt
 * yok, bozuk ya da şimdiden 10 dakikadan ileri; durum yolunda üzerine "şimdi" yazılır), "hata"
 * (KV okunamadı; var olan değer bilinmediği için üzerine YAZILMAZ — iptal başına bir kez).
 */
export async function ilkGorulmeDurumu(kv, k, sira, simdi) {
  let v;
  try {
    v = await kv.get(gorulmeAnahtari(k, sira));
  } catch {
    return { durum: "hata", an: null };
  }
  const d = utcCoz(v);
  if (!d || d.getTime() > simdi.getTime() + GELECEK_PAYI_MS) return { durum: "yok", an: null };
  return { durum: "var", an: d };
}

/** İlk görülme anı ya da null (okunamayan, yok, bozuk ya da ileri; paket kapısı yok sayar). */
export async function ilkGorulmeOku(kv, k, sira, simdi) {
  return (await ilkGorulmeDurumu(kv, k, sira, simdi)).an;
}

/** t'ye eşit ya da sonraki ilk Türkiye 06:00'sı (03:00 UTC). */
export function sonrakiSabah0600Tr(t) {
  const g = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), TR_SABAH_UTC_SAATI, 0, 0);
  return new Date(g >= t.getTime() ? g : g + GUN_MS);
}

/**
 * Askı/iptalde kilit anı (protokol §5.4, K2):
 *   ilk       = ilkGorulme ?? simdi
 *   uyariSonu = sonrakiSabah0600Tr( max(iptalAn, ilk) + 3 gün )
 *   ustSinir  = iptalAn + 3 gün + sınır   (sınır 0 = sınırsız → üst sınır yok; yuvarlanmaz)
 *   kilit     = min(uyariSonu, ustSinir)
 */
export function iptalKilitAni({ iptalAn, ilkGorulme, sinirGun, simdi }) {
  const ilk = ilkGorulme || simdi;
  const uyariSonu = sonrakiSabah0600Tr(new Date(Math.max(iptalAn.getTime(), ilk.getTime()) + UYARI_GUN * GUN_MS));
  if (!(sinirGun > 0)) return uyariSonu;

  const ustSinir = iptalAn.getTime() + (UYARI_GUN + sinirGun) * GUN_MS;
  return new Date(Math.min(uyariSonu.getTime(), ustSinir));
}

/** Anahtarın çevrimdışı sınırı (QRM1 alan 12): boş → 30, 0 → sınırsız. */
export function sinirGunu(lisans) {
  return Number.isInteger(lisans.cevrimdisiGun) ? lisans.cevrimdisiGun : VARSAYILAN_SINIR_GUN;
}

/**
 * Anahtar iptalden SONRA mı üretildi (protokol §4.2)? uretimUtc yok = iptalden önce;
 * eşitlik aşmaz (askı/iptal uretimUtc ≤ iptalAnUtc olan bütün anahtarları bağlar).
 */
export function anahtarIptaliAsar(lisans, kayit) {
  const u = lisans.uretimUtc ? utcCoz(lisans.uretimUtc) : null;
  return !!u && u.getTime() > kayit.iptalAn.getTime();
}

/** Yeni anahtar eskisinden sonra mı üretildi? (yeni yok → hayır; eski yok → evet) */
export function uretimSonra(yeni, eski) {
  const y = yeni ? utcCoz(yeni) : null;
  if (!y) return false;
  const e = eski ? utcCoz(eski) : null;
  if (!e) return true;
  return y.getTime() > e.getTime();
}

/**
 * Paket kapısı (L7, protokol §11.4). Askı (2) ve iptal (3) aynı kural: kilit anından önce
 * (uyarı süresi) paket verilir, sonra durdurulur. Kayıt yok, okunamıyor, bozuk ya da imzası
 * tutmuyorsa paket verilir (fail open: Worker kilit üretemez). Hiçbir yere YAZMAZ.
 * Dönüş { durduruldu, neden }.
 */
export async function paketKapisi(kv, lisans, acik, simdi) {
  const k = lisans.kurulumKimligi;

  const kayit = await kurulumKaydiOku(kv, k);
  if (kayit.durum === "hata") gunluk("kv-hata", k);
  if (kayit.durum === "bozuk") gunluk("kayit-bozuk", k);
  if (kayit.durum !== "var") return { durduruldu: false, neden: "kayit-" + kayit.durum };
  if (kayit.iptalMetni === null) return { durduruldu: false, neden: "kayit-yok" };

  const ik = await iptalKaydiCoz(kayit.iptalMetni, acik);
  if (!ik || ik.kurulum !== k) {
    gunluk("kayit-bozuk", k);
    return { durduruldu: false, neden: "kayit-bozuk" };
  }
  if (ik.durum === 1) return { durduruldu: false, neden: "kaldirildi" };
  if (anahtarIptaliAsar(lisans, ik)) return { durduruldu: false, neden: "yeni-anahtar" };

  const ilk = await ilkGorulmeOku(kv, k, ik.sira, simdi);
  const kilit = iptalKilitAni({ iptalAn: ik.iptalAn, ilkGorulme: ilk, sinirGun: sinirGunu(lisans), simdi });
  return { durduruldu: simdi.getTime() >= kilit.getTime(), neden: ik.durum === 2 ? "askida" : "iptal" };
}
