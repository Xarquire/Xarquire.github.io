// smartmenuos.com Worker'ı. Site dosyaları (smartmenu/) doğrudan sunulur;
// Worker yalnızca /guncelleme/* için çalışır (wrangler.jsonc → run_worker_first).

import { guncellemeIstegi } from "./guncelleme.js";

export default {
  async fetch(istek, env) {
    const yol = new URL(istek.url).pathname;
    if (yol.startsWith("/guncelleme/")) return guncellemeIstegi(istek, env);
    return env.ASSETS.fetch(istek);
  },
};
