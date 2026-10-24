# SmartMenuOS güncelleme sunucusu

`smartmenuos.com/guncelleme/*` isteklerini karşılayan Cloudflare Worker.
Kaynağı ve testleri SmartMenuOS deposunda (`tools/GuncellemeSunucusu`); buradaki
dosyalar oradan kopyalanır, değişiklik önce orada yapılıp sınanır.

- `/guncelleme/<kanal>.txt`: imzalı sürüm bildirimi, herkese açık
- `/guncelleme/paket/<parça>`: kurulum paketinin parçası, yalnızca geçerli imzalı
  lisansı olan kasaya (süresi bitmiş lisans da olur)

Paket dosyaları bu depoda değil, Workers KV'de durur.
