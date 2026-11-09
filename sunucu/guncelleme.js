// /guncelleme/* istekleri.
//
//   GET /guncelleme/<kanal>.txt         imzalı sürüm bildirimi (SMG1 ya da 1.8.0+
//                                       SMG2; Worker imzaya bakmaz, olduğu gibi
//                                       verir). Herkese açık: içinde müşteri bilgisi
//                                       yok, imzası kasada denetleniyor.
//   GET /guncelleme/paket/<parça adı>   kurulum paketinin bir parçası. Yalnızca
//                                       X-SmartMenu-Lisans başlığında geçerli
//                                       imzalı lisans gönderen kasaya verilir.
//                                       1.8.0: lisans askıya alınmış ya da iptal
//                                       edilmişse uyarı süresi bitince 403
//                                       (paket kapısı, iptal.js); kurulum başına
//                                       saatte en çok 120 parça.
//
// Dosyalar Workers KV'de: "guncelleme/<kanal>.txt" ve "paket/<parça adı>".
// Lisans Yönetimi → Güncelleme sayfası önce parçaları, sonra bildirimi yükler.
//
// 1.8.0 (G10): bildirim veri merkezi başına 60 sn önbellekte (adlandırılmış Cache API;
// ziyaretçiye sunulmaz). KV okumasını azaltır; Worker istek sınırını korumaz (onu
// Cloudflare'in hız sınırı kuralı korur, README). Yayın ya da "Yayını durdur" kasalara
// en geç bu kadar gecikmeyle (artı KV'nin kendi yayılması) ulaşır. Önbellek hata verirse
// KV'den okunur. Geri alma: Worker değişkeni BILDIRIM_ONBELLEGI=0 (yeniden yayın gerekmez; panelden
// eklenen değişkeni bir sonraki wrangler deploy siler, kalıcısı wrangler.jsonc "vars": README).
// İstemciye giden yanıt değişmez (no-cache, no-store).

import { lisansDogrula, gomuluAcikAnahtar } from "./lisans.js";
import { paketKapisi } from "./iptal.js";
import { sayacArtir } from "./sayac.js";
import { DURDURULDU_METNI } from "./destek.js";
import { gunluk } from "./belgeler.js";

export const LISANS_BASLIGI = "X-SmartMenu-Lisans";
export const PAKET_SINIRI_SAAT = 120; // kurulum başına saatte parça isteği
export const BILDIRIM_ONBELLEK_ADI = "smartmenuos-bildirim";
export const BILDIRIM_ONBELLEK_SANIYE = 60;
const BILDIRIM_KOK = "https://smartmenuos.com/__bildirim/";

const KANAL = /^\/guncelleme\/([a-z0-9-]{1,32})\.txt$/;
const PARCA = /^\/guncelleme\/paket\/([A-Za-z0-9._-]{1,120})$/;

/**
 * acikAnahtar: lisans açık anahtarı (yoksa gömülü). ayar.simdi: () => Date;
 * ayar.sayacOnbellegi: Cache benzeri | null (undefined → Cache API, null → sınır yok).
 * ayar.bildirimOnbellegi: Cache benzeri | null (undefined → adlandırılmış Cache API; null → kapalı).
 * ayar.bekle: (Promise) => void — önbelleğe yazma yanıtı bekletmesin (ctx.waitUntil); yoksa beklenir.
 */
export async function guncellemeIstegi(istek, env, acikAnahtar, ayar = {}) {
  if (istek.method !== "GET" && istek.method !== "HEAD")
    return metin(405, "Yalnızca GET.", { Allow: "GET, HEAD" });

  const kv = env && env.GUNCELLEME;
  if (!kv) return metin(503, "Güncelleme sunucusu henüz hazır değil.");

  const yol = new URL(istek.url).pathname;

  let m = KANAL.exec(yol);
  if (m) {
    const bildirim = await bildirimOku(kv, m[1], env, ayar);
    if (bildirim === null) return metin(404, "Bu kanal için yayında güncelleme yok.");
    return yanit(istek, bildirim, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
    });
  }

  m = PARCA.exec(yol);
  if (m && !m[1].includes("..")) {
    const lisans = await lisansDogrula(istek.headers.get(LISANS_BASLIGI) || "", acikAnahtar);
    if (!lisans) return metin(403, "Geçerli bir SmartMenuOS lisansı gerekli.");

    const simdi = ayar.simdi ? ayar.simdi() : new Date();
    const n = await sayacArtir(ayar.sayacOnbellegi, "paket", lisans.kurulumKimligi, simdi);
    if (n > PAKET_SINIRI_SAAT)
      return metin(429, "Çok sık indirme isteği; 10 dakika sonra yeniden deneyin.", { "Retry-After": "600" });

    // Paket kapısı (L7): askı/iptalde kasanın kilit anı geçtiyse paket verilmez. Kapı
    // hata verirse paket verilir (fail open; güncelleme kesilmesin, Worker kilit üretmez).
    let kapi = null;
    try {
      kapi = await paketKapisi(kv, lisans, acikAnahtar || gomuluAcikAnahtar(), simdi);
    } catch {
      gunluk("kapi-hata", lisans.kurulumKimligi);
    }
    if (kapi && kapi.durduruldu) return metin(403, DURDURULDU_METNI, { "X-SmartMenu-Neden": "durduruldu" });

    const veri = await kv.get("paket/" + m[1], { type: "stream" });
    if (veri === null) return metin(404, "Parça bulunamadı.");
    return yanit(istek, veri, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
  }

  return metin(404, "Bulunamadı.");
}

async function bildirimOnbellegi(env, ayar) {
  if (env && String(env.BILDIRIM_ONBELLEGI) === "0") return null;
  let c = ayar.bildirimOnbellegi;
  if (c === undefined) {
    try {
      c = typeof caches === "undefined" ? null : await caches.open(BILDIRIM_ONBELLEK_ADI);
    } catch {
      c = null;
    }
  }
  return c || null;
}

/**
 * Kanalın bildirimi (metin) ya da yayın yoksa null. Önce önbellek: kayıt 60 sn'den yeniyse
 * (X-Onbellek-Zaman; Cache API'nin kendi süresine güvenilmez) KV okunmaz. "Yayın yok" da
 * 60 sn saklanır (X-Yok). Önbellek hatası KV'ye düşer (fail open).
 */
async function bildirimOku(kv, kanal, env, ayar) {
  const c = await bildirimOnbellegi(env, ayar);
  const simdi = (ayar.simdi ? ayar.simdi() : new Date()).getTime();
  const anahtar = c ? new Request(BILDIRIM_KOK + kanal) : null;

  if (c) {
    try {
      const k = await c.match(anahtar);
      if (k) {
        const zaman = parseInt(k.headers.get("X-Onbellek-Zaman") || "", 10);
        const yas = simdi - zaman;
        if (Number.isFinite(zaman) && yas >= 0 && yas <= BILDIRIM_ONBELLEK_SANIYE * 1000) {
          if (k.headers.get("X-Yok") === "1") return null;
          return await k.text();
        }
      }
    } catch {
      // önbellek okunamadı: KV
    }
  }

  const bildirim = await kv.get("guncelleme/" + kanal + ".txt");

  if (c) {
    const basliklar = {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "max-age=" + BILDIRIM_ONBELLEK_SANIYE,
      "X-Onbellek-Zaman": String(simdi),
    };
    if (bildirim === null) basliklar["X-Yok"] = "1";
    const yaz = (async () => {
      try {
        await c.put(anahtar, new Response(bildirim === null ? "" : bildirim, { headers: basliklar }));
      } catch {
        // yazılamadı: bir sonraki istek KV'den okur
      }
    })();
    if (typeof ayar.bekle === "function") ayar.bekle(yaz);
    else await yaz;
  }

  return bildirim;
}

function yanit(istek, govde, basliklar) {
  if (istek.method === "HEAD") {
    if (govde && typeof govde.cancel === "function") govde.cancel();
    return new Response(null, { status: 200, headers: basliklar });
  }
  return new Response(govde, { status: 200, headers: basliklar });
}

function metin(durum, ileti, ek = {}) {
  return new Response(ileti + "\n", {
    status: durum,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...ek },
  });
}
