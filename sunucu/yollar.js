// Worker'ın çalıştığı yollar ve Cloudflare hız sınırı kuralı: tek kaynak.
// site/wrangler.jsonc (run_worker_first, crons) ve README'deki ifadeler bununla aynı
// olmalı; test/wrangler.test.mjs denetler.

// wrangler.jsonc → assets.run_worker_first (kalan her şey site dosyalarından gelir).
export const WORKER_YOLLARI = ["/guncelleme/*", "/lisans/durum"];

// Cloudflare → Security → WAF → Rate limiting rules (ücretsiz planda tek kural, IP başına).
export const HIZ_SINIRI_IFADESI =
  '(starts_with(http.request.uri.path, "/guncelleme/")) or (http.request.uri.path eq "/lisans/durum")';

// Panel starts_with kabul etmezse.
export const HIZ_SINIRI_YEDEK_IFADE =
  '(http.request.uri.path contains "/guncelleme/") or (http.request.uri.path eq "/lisans/durum")';

/** Hız sınırı ifadesinin kapsadığı yol mu (ifadeyle aynı anlam; sınama içindir). */
export function hizSiniriKapsar(yol) {
  return yol.startsWith("/guncelleme/") || yol === "/lisans/durum";
}

// Telemetri temizliği: her gün 03:30 UTC (06:30 Türkiye).
export const TEMIZLIK_ZAMANI = "30 3 * * *";
