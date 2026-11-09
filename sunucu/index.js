// smartmenuos.com Worker'ı. Site dosyaları (smartmenu/) doğrudan sunulur; Worker yalnızca
// /guncelleme/* ve /lisans/durum için çalışır (site/wrangler.jsonc → run_worker_first, yollar.js).
// Her gün 03:30 UTC'de 180 gün görülmeyen kasa satırları D1'den silinir (scheduled).

import { guncellemeIstegi } from "./guncelleme.js";
import { lisansDurumIstegi, DURUM_YOLU } from "./lisans-durum.js";
import { telemetriBuda } from "./telemetri.js";

export default {
  async fetch(istek, env, ctx) {
    const yol = new URL(istek.url).pathname;
    if (yol.startsWith("/guncelleme/")) return guncellemeIstegi(istek, env);
    if (yol === DURUM_YOLU) return lisansDurumIstegi(istek, env, ctx);
    return env.ASSETS.fetch(istek);
  },

  async scheduled(olay, env, ctx) {
    ctx.waitUntil(telemetriBuda(env.TELEMETRI, new Date(olay.scheduledTime)));
  },
};
