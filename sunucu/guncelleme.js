// /guncelleme/* istekleri.
//
//   GET /guncelleme/<kanal>.txt         imzalı sürüm bildirimi (SMG1). Herkese
//                                       açık: içinde müşteri bilgisi yok, imzası
//                                       kasada denetleniyor.
//   GET /guncelleme/paket/<parça adı>   kurulum paketinin bir parçası. Yalnızca
//                                       X-SmartMenu-Lisans başlığında geçerli
//                                       imzalı lisans gönderen kasaya verilir.
//
// Dosyalar Workers KV'de: "guncelleme/<kanal>.txt" ve "paket/<parça adı>".
// Lisans Yönetimi → Güncelleme sayfası önce parçaları, sonra bildirimi yükler.

import { lisansDogrula } from "./lisans.js";

export const LISANS_BASLIGI = "X-SmartMenu-Lisans";

const KANAL = /^\/guncelleme\/([a-z0-9-]{1,32})\.txt$/;
const PARCA = /^\/guncelleme\/paket\/([A-Za-z0-9._-]{1,120})$/;

export async function guncellemeIstegi(istek, env, acikAnahtar) {
  if (istek.method !== "GET" && istek.method !== "HEAD")
    return metin(405, "Yalnızca GET.", { Allow: "GET, HEAD" });

  const kv = env && env.GUNCELLEME;
  if (!kv) return metin(503, "Güncelleme sunucusu henüz hazır değil.");

  const yol = new URL(istek.url).pathname;

  let m = KANAL.exec(yol);
  if (m) {
    const bildirim = await kv.get("guncelleme/" + m[1] + ".txt");
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
