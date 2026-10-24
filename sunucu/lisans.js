// Lisans anahtarı doğrulaması (src/RestaurantSystem.Core/Lisans/LisansAnahtari.cs ile aynı kurallar).
//
// Biçim: QRM1.<içerik>.<imza>  (base64url, RSA-SHA256 PKCS#1 v1.5)
// İçerik: kurulumKimliği|işletme|başlangıç|bitiş|masa|paket[|bilgisayarKodu]
//
// Aynı gizli anahtar bakım iznini (SMB1, "BAKIM1|...") ve güncelleme
// bildirimini (SMG1, "GUNCELLEME1\n...") de imzalıyor. Önek değiştirilip
// başka bir belge lisans gibi gösterilemesin diye imzadan sonra içeriğin
// lisans biçiminde olduğu da denetlenir.

// LisansAnahtari.AcikAnahtar → Modulus (Exponent AQAB). Gizli değildir.
export const ACIK_ANAHTAR_MODULUS =
  "2T4G4oPcYLj3Mr2ow0wgdvP+Z26O4eh46w7iQHVQVfTDWXW4SXbE2NjJPxY8JvLSTzihzNEfFyLH9qfv6o30lXkM1ZYSLFHrtcKf1aC9BMjs" +
  "0wCVzWNTu8fJXR+rdyN0LpzbPGr5jIHmSyHL7x0qd0Jjm8J6W5XLhGeroWJml914PsAL6rPT4YeOoHGnp+qBEjifAcr+zvi/N4ol8uwTYKnF" +
  "Og1E7BhGEFWoKX6hN3aPz8qZZ+a3pxnnKnkFOQWgY4zpO8f6QxzkiBbU8rfw9nkazJhThnssihGENtOGlD6QoPIyRlhkEx9WaNtfp4gV5uD3" +
  "GgpV/eI3bErZv9cyKQ==";

const ALGORITMA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const TARIH = /^\d{4}-\d{2}-\d{2}$/;

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
 * Anahtarı doğrular. Geçerliyse { kurulumKimligi, isletme, bitis }, değilse null.
 * Süresi bitmiş lisans da geçerlidir (müşteri güncelleyip yenileyebilsin).
 * Kuruluma bağlı olmayan anahtar (kurulum kimliği boş, ör. depodaki deneme
 * anahtarı) kabul edilmez: 1.7.1'den beri kasa da onları reddediyor.
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

  let metin;
  try {
    metin = new TextDecoder("utf-8", { fatal: true }).decode(icerik);
  } catch {
    return null;
  }

  if (metin.startsWith("GUNCELLEME1") || metin.startsWith("BAKIM1")) return null;

  const a = metin.split("|");
  if (a.length < 6 || !TARIH.test(a[2]) || !TARIH.test(a[3]) || !/^\d{1,9}$/.test(a[4])) return null;
  if (a[0].length === 0) return null;

  try {
    return { kurulumKimligi: decodeURIComponent(a[0]), isletme: decodeURIComponent(a[1]), bitis: a[3] };
  } catch {
    return null;
  }
}

function base64Url(b64) {
  return b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlCoz(metin) {
  if (!/^[A-Za-z0-9_-]*$/.test(metin)) throw new Error("base64url değil");
  let s = metin.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const ikili = atob(s);
  const baytlar = new Uint8Array(ikili.length);
  for (let i = 0; i < ikili.length; i++) baytlar[i] = ikili.charCodeAt(i);
  return baytlar;
}
