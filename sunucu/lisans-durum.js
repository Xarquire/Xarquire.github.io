// POST /lisans/durum — uzaktan lisans durumu (1.8.0, protokol §1 ve §11.2).
//
// Kasa X-SmartMenu-Lisans başlığında anahtarını, gövdede kurulum kimliği, nonce, kendi saati
// ve teknik telemetriyi gönderir. Worker:
//   1. lisansı gömülü açık anahtarla doğrular (kurulum YALNIZCA buradan; gövdedeki farklıysa 400),
//   2. KV "kurulum/<k>" kaydındaki iptal kaydını (SMI1, lisans imzalı) ve yenilenmiş anahtarı
//      (QRM1) doğrular; askı/iptalin bu kuruluma ilk sunulduğu anı bir kez yazar (K2),
//   3. taze cevabı (SMS1: nonce + sunucu saati + sıra + ilk görülme + teslim anahtarı özeti)
//      durum gizli anahtarıyla (secret DURUM_GIZLI) imzalar ve yürürlükteki sertifikayı (SMC1,
//      KV "sert") ekler (K3).
// Lisans üreten gizli anahtar buluta konmaz; durum anahtarı lisans ya da iptal üretemez.
//
// Hata ilkesi (protokol §11.6): KV okunamazsa, kayıt bozuksa, gizli anahtar yoksa ya da
// uyuşmuyorsa 503; "iptal yok" diye uydurulmuş temiz cevap ASLA verilmez. Worker kilit
// üretemez: iptal yalnızca lisans imzalı SMI1 ile gelir. Telemetri (D1) hatası yutulur.
// Günlükte lisans anahtarı, nonce, gövde ve gizli değer yer almaz.

import {
  ALGORITMA, GUID, NONCE, utcMetin, utcCoz, base64UrlCoz, bastakiSifirlariAt, ayniBaytlar, anahtarDuzenle, ozetHex,
  iptalKaydiCoz, sertifikaCoz, durumBelgesiImzala, gunluk,
} from "./belgeler.js";
import { lisansDogrula, gomuluAcikAnahtar } from "./lisans.js";
import { kurulumKaydiOku, ilkGorulmeDurumu, gorulmeAnahtari, uretimSonra } from "./iptal.js";
import { sayacArtir } from "./sayac.js";
import { telemetriHazirla, telemetriYaz, _testIcinSifirla as telemetriSifirla } from "./telemetri.js";

export const DURUM_YOLU = "/lisans/durum";
export const LISANS_BASLIGI = "X-SmartMenu-Lisans";
export const GOVDE_EN_COK = 4096;
export const SERT_ONBELLEK_MS = 10 * 60000;
export const GORULME_TTL_SN = 400 * 86400;      // iptalgorulme anahtarı 400 gün sonra kendiliğinden silinir
export const DURUM_SINIRI_SAAT = 30;            // kurulum başına saatte (protokol §11.2/4)
export const TELEMETRI_SAAT_BASI = 4;           // saatin ilk 4 isteği D1'e yazar (kota koruması)
const GORULME_BELLEK_EN_COK = 1000;

export const ILETI = {
  tamam: "tamam",
  sertSuresi: "Durum sertifikasının süresi dolmuş; Lisans Yönetimi'ni açın.",
  istek: (alan) => "İstek geçersiz (" + alan + ").",
  lisans: "Geçerli bir SmartMenuOS lisansı gerekli.",
  yontem: "Yalnızca POST.",
  sinir: "Çok sık soruldu; 10 dakika sonra yeniden denenecek.",
  hizmetYok: "Uzaktan durum hizmeti henüz kurulmadı.",
  hizmet: "Durum hizmeti şu an kullanılamıyor.",
};

// ------------------------------------------------------------------ isolate önbellekleri

let sertOnbellek = null;     // { acik, cozulmus, alindiMs } — yalnızca GEÇERLİ sertifika, 10 dk; gizliyle uyuşmazsa atılır
let gizliOnbellek = null;    // { metin, deger: { anahtar, n } | null } — metin aynıysa yeniden içe alınmaz
const gorulmeYazilan = new Map(); // "<k>/<sıra>" → Date (aynı isolate'te ikinci kez yazılmaz)

/** Yalnız sınama: modül önbelleklerini boşaltır. */
export function _testIcinSifirla() {
  sertOnbellek = null;
  gizliOnbellek = null;
  gorulmeYazilan.clear();
  telemetriSifirla();
}

/**
 * ayar.acikAnahtar   : Promise<CryptoKey> | CryptoKey — lisans açık anahtarı (yoksa gömülü)
 * ayar.simdi         : () => Date
 * ayar.sayacOnbellegi: Cache benzeri | null — undefined ise adlandırılmış Cache API, null ise sınır yok
 */
export async function lisansDurumIstegi(istek, env, ctx, ayar = {}) {
  try {
    return await isle(istek, env, ctx, ayar);
  } catch {
    gunluk("beklenmeyen", null);
    return hizmetHatasi("beklenmeyen");
  }
}

async function isle(istek, env, ctx, ayar) {
  const simdi = ayar.simdi ? ayar.simdi() : new Date();

  // 1. Yöntem ve gövde.
  if (istek.method !== "POST") return json(405, { hata: "yontem", ileti: ILETI.yontem }, { Allow: "POST" });

  const metin = await govdeOku(istek, GOVDE_EN_COK);
  if (metin === null) return istekHatasi("govde");
  let j;
  try {
    j = JSON.parse(metin);
  } catch {
    return istekHatasi("govde");
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return istekHatasi("govde");

  // 2. Lisans (geçmezse KV'ye, D1'e ve sayaca HİÇ dokunulmaz).
  const acik = await (ayar.acikAnahtar || gomuluAcikAnahtar());
  const baslik = istek.headers.get(LISANS_BASLIGI) || "";
  const lisans = await lisansDogrula(baslik, acik);
  if (!lisans) return json(403, { hata: "lisans", ileti: ILETI.lisans });

  const k = lisans.kurulumKimligi;
  if (typeof j.kurulum !== "string" || !GUID.test(j.kurulum) || j.kurulum.toLowerCase() !== k) return istekHatasi("kurulum");

  // 3. Nonce ve kasa saati.
  if (typeof j.nonce !== "string" || !NONCE.test(j.nonce)) return istekHatasi("nonce");
  const kasaSaati = utcCoz(j.kasaSaatiUtc);
  if (!kasaSaati) return istekHatasi("kasaSaatiUtc");

  // 4. Kurulum başına yumuşak sınır.
  const n = await sayacArtir(ayar.sayacOnbellegi, "durum", k, simdi);
  if (n > DURUM_SINIRI_SAAT) return json(429, { hata: "sinir", ileti: ILETI.sinir }, { "Retry-After": "600" });

  let yanit;
  try {
    yanit = await durumCevabi({ env, lisans, baslik, nonce: j.nonce, acik, simdi });
  } catch {
    gunluk("beklenmeyen", k);
    yanit = hizmetHatasi("beklenmeyen");
  }

  // Telemetri: lisans + gövde geçerli her istekte (429 hariç), saatin ilk 4'ünde.
  if (n <= TELEMETRI_SAAT_BASI) {
    let yazim = null;
    try {
      yazim = telemetriYaz(env.TELEMETRI, telemetriHazirla({ govde: j, lisans, kasaSaati, simdi }, yanit.status));
    } catch {
      gunluk("d1-hata", k);
    }
    if (yazim) {
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(yazim);
      else await yazim;
    }
  }
  return yanit;
}

async function durumCevabi({ env, lisans, baslik, nonce, acik, simdi }) {
  const k = lisans.kurulumKimligi;

  // 5. Sertifika ve durum gizli anahtarı.
  const kv = env.GUNCELLEME;
  if (!kv) {
    gunluk("kv-hata", k);
    return hizmetHatasi("kv");
  }

  const s = await sertifikaAl(kv, acik, simdi);
  if (s.durum === "hata") {
    gunluk("kv-hata", k);
    return hizmetHatasi("kv");
  }
  if (s.durum === "yok") return json(501, { hizmet: "yok", ileti: ILETI.hizmetYok });
  if (s.durum === "bozuk") {
    gunluk("sert-bozuk", k);
    return hizmetHatasi("sert");
  }
  const sert = s.sert;

  const gizli = await durumGizliAl(env.DURUM_GIZLI);
  if (!gizli) {
    gunluk("gizli-yok", k);
    return hizmetHatasi("gizli");
  }
  if (!ayniBaytlar(bastakiSifirlariAt(sert.modulus), bastakiSifirlariAt(gizli.n))) {
    // Anahtar değişiminde yeni gizli eski sertifikayla karşılaşabilir (KV yayılması): uyuşmayan
    // sertifika önbellekte tutulmaz, sonraki istek KV'den yeniden okur (10 dk 503 sürmesin).
    sertOnbellek = null;
    gunluk("gizli-uyusmuyor", k);
    return hizmetHatasi("gizli");
  }

  // 6. Kurulum kaydı (tek kv.get).
  const kayit = await kurulumKaydiOku(kv, k);
  if (kayit.durum === "hata") {
    gunluk("kv-hata", k);
    return hizmetHatasi("kv");
  }
  if (kayit.durum === "bozuk") {
    gunluk("kayit-bozuk", k);
    return hizmetHatasi("kayit");
  }

  // 7. İptal kaydı: imza + işaret + tam 7 alan + kurulum; tutmazsa 503 (temiz cevap uydurulmaz).
  let iptal = null;
  let sira = "0";
  let ilkGorulme = "";
  if (kayit.iptalMetni !== null) {
    const ik = await iptalKaydiCoz(kayit.iptalMetni, acik);
    if (!ik || ik.kurulum !== k) {
      gunluk("kayit-bozuk", k);
      return hizmetHatasi("kayit");
    }
    iptal = ik.metin;
    sira = ik.sira;
    if (ik.durum === 2 || ik.durum === 3) ilkGorulme = utcMetin(await ilkGorulmeBelirle(kv, k, ik.sira, simdi));
  }

  // Yenilenmiş anahtar: bu kurulumun, başlıktakinden farklı ve daha SONRA üretilmiş olmalı.
  // Tutmazsa yalnızca anahtar atlanır.
  let anahtar = null;
  let ozet = "";
  if (kayit.anahtarMetni !== null) {
    const a = anahtarDuzenle(kayit.anahtarMetni);
    const l2 = await lisansDogrula(a, acik);
    if (l2 && l2.kurulumKimligi === k && a !== anahtarDuzenle(baslik) && uretimSonra(l2.uretimUtc, lisans.uretimUtc)) {
      anahtar = a;
      ozet = await ozetHex(a);
    }
  }

  // 9. Taze imzalı cevap.
  const durum = await durumBelgesiImzala({
    kurulum: k, nonce, sunucuSaatiUtc: utcMetin(simdi), sira, iptalIlkGorulmeUtc: ilkGorulme, teslimAnahtarOzeti: ozet,
  }, gizli.anahtar);

  const ileti = sert.bitis.getTime() < simdi.getTime() ? ILETI.sertSuresi : ILETI.tamam;
  return json(200, { sertifika: sert.metin, durum, iptal, anahtar, ileti });
}

// 8. İptalin bu kuruluma ilk sunulduğu an: KV'de varsa o, yoksa şimdi (bir kez yazılır).
// Yazma hatası cevabı bozmaz (alan bu cevapta "şimdi" gider). KV sonradan tutarlı olduğu
// için aynı isolate'te bellekten verilir. Okuma hatası "yok" demek değildir: var olan ilk
// görülmenin üzerine yazılmaz, belleğe de alınmaz; alan yalnızca bu cevapta "şimdi" gider
// (kasa kendi ilk görmesiyle küçüğünü alır, kilit ötelenmez).
async function ilkGorulmeBelirle(kv, k, sira, simdi) {
  const anahtar = k + "/" + sira;
  const bellek = gorulmeYazilan.get(anahtar);
  if (bellek) return bellek;

  const simdiSn = new Date(Math.floor(simdi.getTime() / 1000) * 1000);
  const okunan = await ilkGorulmeDurumu(kv, k, sira, simdi);
  if (okunan.durum === "hata") {
    gunluk("kv-hata", k);
    return simdiSn;
  }

  let d = okunan.an;
  if (!d) {
    d = simdiSn;
    try {
      await kv.put(gorulmeAnahtari(k, sira), utcMetin(d), { expirationTtl: GORULME_TTL_SN });
    } catch {
      gunluk("gorulme-yazilamadi", k);
    }
  }

  if (gorulmeYazilan.size >= GORULME_BELLEK_EN_COK) gorulmeYazilan.clear();
  gorulmeYazilan.set(anahtar, d);
  return d;
}

/** KV "sert" (SMC1). Dönüş { durum: "var"|"yok"|"hata"|"bozuk", sert }. Yalnız geçerli olan önbelleğe girer. */
async function sertifikaAl(kv, acik, simdi) {
  const t = simdi.getTime();
  if (sertOnbellek && sertOnbellek.acik === acik && t - sertOnbellek.alindiMs >= 0 && t - sertOnbellek.alindiMs < SERT_ONBELLEK_MS)
    return { durum: "var", sert: sertOnbellek.cozulmus };

  let metin;
  try {
    metin = await kv.get("sert");
  } catch {
    return { durum: "hata" };
  }
  if (metin === null || metin === undefined) return { durum: "yok" };

  const sert = await sertifikaCoz(metin, acik);
  if (!sert) return { durum: "bozuk" };

  sertOnbellek = { acik, cozulmus: sert, alindiMs: t };
  return { durum: "var", sert };
}

const JWK_ALANLARI = ["n", "e", "d", "p", "q", "dp", "dq", "qi"];

/**
 * DURUM_GIZLI secret'ı (JWK). İçe alma yalnızca kty + sekiz RSA alanıyla yeniden kurulan
 * nesneyle yapılır (key_ops/use/alg uyuşmazlığı bozmasın). Dönüş { anahtar, n } ya da null.
 */
async function durumGizliAl(metin) {
  if (typeof metin !== "string" || metin.length === 0 || metin.length > 16384) return null;
  if (gizliOnbellek && gizliOnbellek.metin === metin) return gizliOnbellek.deger;

  let deger = null;
  try {
    const j = JSON.parse(metin);
    if (j && typeof j === "object" && j.kty === "RSA" && JWK_ALANLARI.every((a) => typeof j[a] === "string" && j[a] !== "")) {
      const temiz = { kty: "RSA" };
      for (const a of JWK_ALANLARI) temiz[a] = j[a];
      const n = base64UrlCoz(j.n);
      const anahtar = await crypto.subtle.importKey("jwk", temiz, ALGORITMA, false, ["sign"]);
      deger = { anahtar, n };
    }
  } catch {
    deger = null;
  }

  gizliOnbellek = { metin, deger };
  return deger;
}

/**
 * Gövdeyi en çok enCok bayt okur (Content-Length yalan söylese de parça parça sayılır).
 * Fazlası, bozuk Content-Length ya da geçersiz UTF-8 → null.
 */
export async function govdeOku(istek, enCok) {
  const uzunluk = istek.headers.get("Content-Length");
  if (uzunluk !== null && (!/^\d+$/.test(uzunluk) || Number(uzunluk) > enCok)) return null;
  if (!istek.body) return "";

  const okuyucu = istek.body.getReader();
  const parcalar = [];
  let toplam = 0;
  for (;;) {
    const { done, value } = await okuyucu.read();
    if (done) break;
    toplam += value.byteLength;
    if (toplam > enCok) {
      try {
        await okuyucu.cancel();
      } catch {
        // okuyucu zaten kapalı
      }
      return null;
    }
    parcalar.push(value);
  }

  const baytlar = new Uint8Array(toplam);
  let i = 0;
  for (const p of parcalar) {
    baytlar.set(p, i);
    i += p.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(baytlar);
  } catch {
    return null;
  }
}

function json(durum, nesne, ek = {}) {
  return new Response(JSON.stringify(nesne), {
    status: durum,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...ek,
    },
  });
}

function istekHatasi(alan) {
  return json(400, { hata: "istek", alan, ileti: ILETI.istek(alan) });
}

function hizmetHatasi(neden) {
  return json(503, { hata: "hizmet", neden, ileti: ILETI.hizmet });
}
