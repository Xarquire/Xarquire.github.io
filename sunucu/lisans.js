// Lisans anahtarı doğrulaması (src/RestaurantSystem.Core/Lisans/LisansAnahtari.cs ile aynı kurallar).
//
// Biçim: QRM1.<içerik>.<imza>  (base64url, RSA-SHA256 PKCS#1 v1.5)
// İçerik: kurulumKimliği|işletme|başlangıç|bitiş|masa|paket[|bilgisayarKodu[|ekKodlar
//         [|moduller[|kullaniciSiniri[|uretimUtc[|cevrimdisiGun]]]]]]
// (ekKodlar 1.8.0, çok kasa: virgülle ayrılmış öteki bilgisayarlar. 1.8.0 alan 9–12:
//  modül kodları (boş = hepsi), kullanıcı sınırı (boş = 0, sınırsız), üretim anı
//  (yyyy-MM-ddTHH:mm:ssZ, boş = bilinmiyor), çevrimdışı sınır gün (boş = 30, 0 = sınırsız).
//  13. ve sonraki alanlar yok sayılır; bozuk alan anahtarı geçersiz yapar.)
//
// Aynı gizli anahtar bakım iznini (SMB1, "BAKIM1|...") ve 1.8.0'a kadar
// güncelleme bildirimini (SMG1, "GUNCELLEME1\n...") de imzalıyor. 1.8.0+
// bildirimi ayrı anahtarla (SMG2) imzalıdır; önek QRM1 yapılsa da imzası bu
// anahtarla tutmaz. Önek değiştirilip başka bir belge lisans gibi
// gösterilemesin diye imzadan sonra içeriğin lisans biçiminde olduğu da denetlenir.

import { ALGORITMA, base64UrlCoz } from "./belgeler.js";

// LisansAnahtari.AcikAnahtar → Modulus (Exponent AQAB). Gizli değildir.
export const ACIK_ANAHTAR_MODULUS =
  "2T4G4oPcYLj3Mr2ow0wgdvP+Z26O4eh46w7iQHVQVfTDWXW4SXbE2NjJPxY8JvLSTzihzNEfFyLH9qfv6o30lXkM1ZYSLFHrtcKf1aC9BMjs" +
  "0wCVzWNTu8fJXR+rdyN0LpzbPGr5jIHmSyHL7x0qd0Jjm8J6W5XLhGeroWJml914PsAL6rPT4YeOoHGnp+qBEjifAcr+zvi/N4ol8uwTYKnF" +
  "Og1E7BhGEFWoKX6hN3aPz8qZZ+a3pxnnKnkFOQWgY4zpO8f6QxzkiBbU8rfw9nkazJhThnssihGENtOGlD6QoPIyRlhkEx9WaNtfp4gV5uD3" +
  "GgpV/eI3bErZv9cyKQ==";

const TARIH = /^\d{4}-\d{2}-\d{2}$/;
const SAYI = /^\d{1,9}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODUL = /^[a-z0-9]{1,20}$/;
const URETIM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// Kasadaki ModulKodlari.Kodlar ile aynı sıra (kasa ile aynı normalleştirme).
const MODULLER = ["adisyon", "qr", "garson", "pos", "rapor", "cari", "mutfak", "sube"];

// Kara liste (1.8.0, L11): kasadaki LisansAnahtari.KaraListe ile aynı. Çözülmüş
// İMZA baytlarının SHA-256 özeti (metnin değil: "=" dolgusuyla atlatılamasın).
// Depoda yıllarca duran, kuruluma bağlı olmayan deneme anahtarı.
export const KARA_LISTE = new Set(["d9318a12845cf490d5ea2d2b3760d7291de76376ca8b546575c951c3c2fb5fdc"]);

let gomuluAnahtar = null;

/** Base64 modülüsten doğrulama anahtarı (exponent 65537). */
export function acikAnahtarAl(modulusBase64, us = "AQAB") {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: base64Url(modulusBase64), e: base64Url(us), alg: "RS256", ext: true },
    ALGORITMA,
    false,
    ["verify"]
  );
}

function gomulu() {
  if (!gomuluAnahtar) gomuluAnahtar = acikAnahtarAl(ACIK_ANAHTAR_MODULUS);
  return gomuluAnahtar;
}

/**
 * Gömülü lisans açık anahtarı (Promise<CryptoKey>, isolate başına bir kez içe alınır).
 * SMI1 (iptal kaydı), SMC1 (durum sertifikası) ve teslim edilen anahtar da bununla doğrulanır.
 */
export function gomuluAcikAnahtar() {
  return gomulu();
}

/**
 * Anahtarı doğrular. Geçerliyse
 *   { kurulumKimligi (küçük harf GUID), isletme, bitis, masa, moduller (dizi | null = hepsi),
 *     kullaniciSiniri (0 = sınırsız), uretimUtc (metin | null), cevrimdisiGun (0 = sınırsız) },
 * değilse null. Süresi bitmiş lisans da geçerlidir (müşteri güncelleyip yenileyebilsin).
 * Kuruluma bağlı olmayan anahtar (kurulum kimliği boş ya da GUID değil, ör. depodaki
 * deneme anahtarı) kabul edilmez: 1.7.1'den beri kasa da onları reddediyor.
 * Modül kapısı YOK (kasa da uygulamıyor).
 */
export async function lisansDogrula(anahtar, acikAnahtar) {
  if (typeof anahtar !== "string" || anahtar.length === 0 || anahtar.length > 4096) return null;

  const parcalar = anahtar.replace(/\s+/g, "").split(".");
  if (parcalar.length !== 3 || parcalar[0] !== "QRM1") return null;

  let icerik, imza;
  try {
    icerik = base64UrlCoz(parcalar[1]);
    imza = base64UrlCoz(parcalar[2]);
  } catch {
    return null;
  }

  const anahtarNesnesi = await (acikAnahtar || gomulu());
  let dogru = false;
  try {
    dogru = await crypto.subtle.verify(ALGORITMA, anahtarNesnesi, imza, icerik);
  } catch {
    return null;
  }
  if (!dogru) return null;

  if (KARA_LISTE.has(await ozet(imza))) return null;

  let metin;
  try {
    metin = new TextDecoder("utf-8", { fatal: true }).decode(icerik);
  } catch {
    return null;
  }

  if (metin.startsWith("GUNCELLEME1") || metin.startsWith("BAKIM1")) return null;

  const a = metin.split("|");
  if (a.length < 6 || !TARIH.test(a[2]) || !TARIH.test(a[3]) || !SAYI.test(a[4])) return null;

  try {
    // 1. alan: GUID ("D" biçimi, büyük/küçük harf). Boş ya da başka biçim → kuruluma bağlı değil.
    const kurulum = decodeURIComponent(a[0]);
    if (!GUID.test(kurulum)) return null;

    const moduller = modulleriCoz(a.length > 8 ? a[8] : "");
    if (moduller === undefined) return null;

    const kullanici = a.length > 9 ? a[9] : "";
    if (kullanici !== "" && !SAYI.test(kullanici)) return null;

    // 11. alan: üretim anı; takvimde olmayan tarih (30 Şubat) de bozuk sayılır.
    const uretim = a.length > 10 ? a[10] : "";
    if (uretim !== "" && !uretimGecerli(uretim)) return null;

    const cevrimdisi = a.length > 11 ? a[11] : "";
    if (cevrimdisi !== "" && !SAYI.test(cevrimdisi)) return null;

    return {
      kurulumKimligi: kurulum.toLowerCase(),
      isletme: decodeURIComponent(a[1]),
      bitis: a[3],
      masa: Number(a[4]),
      moduller,
      kullaniciSiniri: kullanici === "" ? 0 : Number(kullanici),
      uretimUtc: uretim === "" ? null : uretim,
      cevrimdisiGun: cevrimdisi === "" ? 30 : Number(cevrimdisi),
    };
  } catch {
    return null;
  }
}

/**
 * 9. alan: boş ya da "*" → null (hepsi). Aksi virgüllü kodlar; tekrarlar atılır,
 * bilinenler sabit sırada, bilinmeyenler sonda; sekizinin hepsi → null.
 * Bozuk kod → undefined (anahtar geçersiz).
 */
function modulleriCoz(ham) {
  if (ham === "" || ham === "*") return null;

  const bilinen = [];
  const bilinmeyen = [];
  for (const k of decodeURIComponent(ham).split(",")) {
    if (!MODUL.test(k)) return undefined;
    const hedef = MODULLER.includes(k) ? bilinen : bilinmeyen;
    if (!hedef.includes(k)) hedef.push(k);
  }

  if (bilinen.length === MODULLER.length) return null;
  return MODULLER.filter((k) => bilinen.includes(k)).concat(bilinmeyen);
}

function uretimGecerli(metin) {
  if (!URETIM.test(metin)) return false;
  const t = new Date(metin);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 19) + "Z" === metin;
}

async function ozet(baytlar) {
  const o = new Uint8Array(await crypto.subtle.digest("SHA-256", baytlar));
  return Array.from(o, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Url(b64) {
  return b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
