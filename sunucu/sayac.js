// Kurulum başına yumuşak istek sınırı (protokol §11.2/4). Cache API'de saatlik kova;
// KV'ye YAZMAZ (yazma kotası korunur). Sayaç veri merkezi başına ve atomik değildir:
// güvenlik sınırı değil, KV/D1 kotası korumasıdır. Asıl patlama koruması Cloudflare'in
// IP başına hız sınırı kuralı (yollar.js).
//
// Adlandırılmış önbellek kullanılır (caches.default değil): ziyaretçiye hiç sunulmaz.

export const SAYAC_ONBELLEK_ADI = "smartmenuos-sayac";
const KOK = "https://smartmenuos.com/__sayac/";

/**
 * Bu saatteki istek sayısını bir artırıp döner. onbellekAyari: undefined → adlandırılmış
 * Cache API önbelleği; null → sınır yok. Önbellek yoksa ya da hata verirse 1 döner (sınır yok).
 * tur: "durum" ya da "paket".
 */
export async function sayacArtir(onbellekAyari, tur, kurulum, simdi) {
  let c = onbellekAyari;
  if (c === undefined) {
    try {
      c = typeof caches === "undefined" ? null : await caches.open(SAYAC_ONBELLEK_ADI);
    } catch {
      c = null;
    }
  }
  if (!c) return 1;

  const kova = Math.floor(simdi.getTime() / 3600000);
  const anahtar = new Request(KOK + tur + "/" + kurulum + "/" + kova);
  try {
    const eski = await c.match(anahtar);
    const n = (eski ? parseInt(await eski.text(), 10) || 0 : 0) + 1;
    await c.put(anahtar, new Response(String(n), { headers: { "Cache-Control": "max-age=3700" } }));
    return n;
  } catch {
    return 1;
  }
}
