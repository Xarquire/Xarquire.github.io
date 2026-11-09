// Uzaktan lisans durumu (1.8.0) belgelerinin ortak biçimi ve imzası.
// Kurallar kasadaki Core/Lisans/BelgeAyristirici.cs ile aynı (protokol §0–§3);
// kasa, Lisans Yönetimi ve Worker aynı vektörlerle sınanır (test/vektorler/belgeler.json).
//
// Taşıyıcı: ÖNEK.<base64url içerik>.<base64url imza>, RSASSA-PKCS1-v1_5 / SHA-256, içerik UTF-8.
//   SMI1  IPTAL1|kurulum|lisansNo|durum|iptalAnUtc|sira|not       iptal/askı kaydı (lisans gizli anahtarı)
//   SMC1  SERT1|modulus|exponent|uretimUtc|bitisUtc|sira          durum anahtarı sertifikası (lisans gizli anahtarı)
//   SMS1  DURUM1|kurulum|nonce|sunucuSaatiUtc|sira|iptalIlkGorulmeUtc|teslimAnahtarOzeti
//                                                                 taze durum cevabı (durum gizli anahtarı; yalnız Worker)
// Alan sayısı TAM eşit olmalı; tarih yalnızca yyyy-MM-ddTHH:mm:ssZ; sıra kanonik ondalık
// (baştaki sıfır yok, long sınırı); serbest metin Uri.EscapeDataString kümesinde ve katı çözülür.
//
// Bu modül hiçbir yerel modülü içe aktarmaz (döngü olmasın): lisans.js, iptal.js,
// telemetri.js, sayac.js bunu kullanır.

export const ALGORITMA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // D biçimi; karşılaştırma küçük harfle
export const NONCE = /^[0-9a-f]{32}$/;                    // tam 32 KÜÇÜK hex
export const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const SIRA = /^(0|[1-9]\d{0,18})$/;               // kanonik ondalık, baştaki sıfır yok
export const SIRA_EN_COK = 9223372036854775807n;           // long.MaxValue
export const KACIRILMIS = /^(?:[A-Za-z0-9\-._~!*'()]|%[0-9A-Fa-f]{2})*$/; // Uri.EscapeDataString çıktısı kümesi
export const OZET = /^[0-9a-f]{64}$/;
export const GUN_MS = 86400000;
export const BELGE_EN_COK = 8192;
// SMI1 notunun KODLANMIŞ en büyük boyu: Lisans Yönetimi notu 300 UTF-16 karaktere kadar imzalar
// (BelgeImzalayici.NotEnUzun); en kötü durumda her karakter 3 baytlık UTF-8'dir ("₺" → "%E2%82%BA").
// Lisans Yönetimi'nin geçerli saydığı her not burada da geçmeli (ortak vektör "uzun-not").
export const NOT_KODLU_EN_COK = 300 * 9;

/** Standart base64, "=" atılır, + → -, / → _ (LisansAnahtari.Base64UrlKodla ile aynı). */
export function base64UrlKodla(baytlar) {
  let ikili = "";
  for (let i = 0; i < baytlar.length; i += 0x8000)
    ikili += String.fromCharCode.apply(null, baytlar.subarray(i, i + 0x8000));
  return btoa(ikili).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Yalnız [A-Za-z0-9_-]; aksi hâlde hata atar. */
export function base64UrlCoz(metin) {
  if (typeof metin !== "string" || !/^[A-Za-z0-9_-]*$/.test(metin)) throw new Error("base64url değil");
  let s = metin.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const ikili = atob(s);
  const baytlar = new Uint8Array(ikili.length);
  for (let i = 0; i < ikili.length; i++) baytlar[i] = ikili.charCodeAt(i);
  return baytlar;
}

/** yyyy-MM-ddTHH:mm:ssZ (milisaniye yok). */
export function utcMetin(t) {
  return new Date(t).toISOString().slice(0, 19) + "Z";
}

/** Katı tarih: desen + gidiş-dönüş eşitliği (30 Şubat, 24:00, 0000 yılı red). */
export function utcCoz(metin) {
  if (typeof metin !== "string" || !UTC.test(metin)) return null;
  const d = new Date(metin);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1) return null;
  return utcMetin(d) === metin ? d : null;
}

/** Kanonik, eksi olmayan 64 bit sıra (metin olarak tutulur; JS sayısına çevrilmez). */
export function siraGecerli(metin) {
  return typeof metin === "string" && SIRA.test(metin) && BigInt(metin) <= SIRA_EN_COK;
}

/**
 * Kaçırılmış (Uri.EscapeDataString / encodeURIComponent) serbest metni çözer. Küme dışı
 * karakter, uzunluk aşımı, bozuk yüzde ya da geçersiz UTF-8 → null. Boş metin "" döner.
 */
export function kacirilmisCoz(metin, enCok) {
  if (typeof metin !== "string" || metin.length > enCok || !KACIRILMIS.test(metin)) return null;
  try {
    return decodeURIComponent(metin);
  } catch {
    return null;
  }
}

/** Boşlukları ve satır sonlarını atar (LisansAnahtari.Duzenle ile aynı sonuç). */
export function anahtarDuzenle(metin) {
  return metin.replace(/\s+/g, "");
}

/** UTF-8 metnin SHA-256'sı, 64 küçük hex. */
export async function ozetHex(metin) {
  const o = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(metin)));
  return Array.from(o, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Baştaki 0x00 baytlarını atar (en az bir bayt kalır). */
export function bastakiSifirlariAt(baytlar) {
  let i = 0;
  while (i < baytlar.length - 1 && baytlar[i] === 0) i++;
  return baytlar.subarray(i);
}

export function ayniBaytlar(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Worker günlüğü: yalnızca olay kodu ve kurulum kimliğinin ilk 8 karakteri.
 * Lisans anahtarı, nonce, gövde ve gizli değer ASLA yazılmaz.
 */
export function gunluk(olay, kurulum) {
  console.error(JSON.stringify({ olay, kurulum: kurulum ? String(kurulum).slice(0, 8) : null }));
}

/**
 * ÖNEK.içerik.imza belgesini açar: önek tam eşit, imza açık anahtarla tutmalı, içerik
 * geçerli UTF-8. İçerik metnini döner; herhangi bir aksaklıkta null.
 */
export async function imzaliBelgeAc(belge, onek, acikAnahtar) {
  if (typeof belge !== "string" || belge.length === 0 || belge.length > BELGE_EN_COK) return null;
  try {
    const parca = anahtarDuzenle(belge).split(".");
    if (parca.length !== 3 || parca[0] !== onek) return null;

    const icerik = base64UrlCoz(parca[1]);
    const imza = base64UrlCoz(parca[2]);
    if (!(await crypto.subtle.verify(ALGORITMA, await acikAnahtar, imza, icerik))) return null;

    return new TextDecoder("utf-8", { fatal: true }).decode(icerik);
  } catch {
    return null;
  }
}

/**
 * SMI1 iptal/askı kaydı. Durum: 1 kaldırıldı (yeniden etkinleştirildi), 2 askıda, 3 iptal.
 * Dönüş { kurulum (küçük harf), lisansNo, durum, iptalAn (Date), iptalAnUtc, sira (metin),
 * not, metin (boşluksuz belge) } ya da null.
 */
export async function iptalKaydiCoz(belge, acikAnahtar) {
  const metin = await imzaliBelgeAc(belge, "SMI1", acikAnahtar);
  if (metin === null) return null;

  const a = metin.split("|");
  if (a.length !== 7 || a[0] !== "IPTAL1") return null;
  if (!GUID.test(a[1])) return null;

  const lisansNo = kacirilmisCoz(a[2], 64);
  if (lisansNo === null) return null;

  if (a[3] !== "1" && a[3] !== "2" && a[3] !== "3") return null;

  const iptalAn = utcCoz(a[4]);
  if (!iptalAn) return null;

  if (!siraGecerli(a[5])) return null;

  const not = kacirilmisCoz(a[6], NOT_KODLU_EN_COK);
  if (not === null) return null;

  return {
    kurulum: a[1].toLowerCase(),
    lisansNo,
    durum: Number(a[3]),
    iptalAn,
    iptalAnUtc: a[4],
    sira: a[5],
    not,
    metin: anahtarDuzenle(belge),
  };
}

/**
 * SMC1 durum anahtarı sertifikası. Worker bitişe göre karar vermez (kasa kendi etkin
 * zamanıyla verir); yalnız uyarı iletisi ve günlük için kullanır.
 */
export async function sertifikaCoz(belge, acikAnahtar) {
  const metin = await imzaliBelgeAc(belge, "SMC1", acikAnahtar);
  if (metin === null) return null;

  const a = metin.split("|");
  if (a.length !== 6 || a[0] !== "SERT1") return null;

  let modulus, exponent;
  try {
    modulus = bastakiSifirlariAt(base64UrlCoz(a[1]));
    exponent = bastakiSifirlariAt(base64UrlCoz(a[2]));
  } catch {
    return null;
  }
  if (modulus.length < 256 || modulus.length > 512) return null;
  if (exponent.length < 1 || exponent.length > 8) return null;

  const uretim = utcCoz(a[3]);
  const bitis = utcCoz(a[4]);
  if (!uretim || !bitis || !siraGecerli(a[5])) return null;

  return {
    modulus,
    modulusB64: a[1],
    exponentB64: a[2],
    uretim,
    uretimUtc: a[3],
    bitis,
    bitisUtc: a[4],
    sira: a[5],
    metin: anahtarDuzenle(belge),
  };
}

/**
 * SMS1 içeriği. g = { kurulum, nonce, sunucuSaatiUtc, sira, iptalIlkGorulmeUtc, teslimAnahtarOzeti }.
 * Savunma: her alan kendi desenine uymazsa hata atar (uydurma ya da enjeksiyon olmasın).
 */
export function durumIcerigi(g) {
  if (typeof g.kurulum !== "string" || !GUID.test(g.kurulum) || g.kurulum !== g.kurulum.toLowerCase())
    throw new Error("kurulum");
  if (typeof g.nonce !== "string" || !NONCE.test(g.nonce)) throw new Error("nonce");
  if (!utcCoz(g.sunucuSaatiUtc)) throw new Error("saat");
  if (!siraGecerli(g.sira)) throw new Error("sira");
  if (g.iptalIlkGorulmeUtc !== "" && !utcCoz(g.iptalIlkGorulmeUtc)) throw new Error("ilk");
  if (g.teslimAnahtarOzeti !== "" && !(typeof g.teslimAnahtarOzeti === "string" && OZET.test(g.teslimAnahtarOzeti)))
    throw new Error("ozet");
  return ["DURUM1", g.kurulum, g.nonce, g.sunucuSaatiUtc, g.sira, g.iptalIlkGorulmeUtc, g.teslimAnahtarOzeti].join("|");
}

/** SMS1'i durum gizli anahtarıyla imzalar (PKCS#1 v1.5 belirlenimci: aynı girdi → aynı belge). */
export async function durumBelgesiImzala(g, durumGizli) {
  const icerik = new TextEncoder().encode(durumIcerigi(g));
  const imza = new Uint8Array(await crypto.subtle.sign(ALGORITMA, await durumGizli, icerik));
  return "SMS1." + base64UrlKodla(icerik) + "." + base64UrlKodla(imza);
}
