# SmartMenuOS sunucusu

`smartmenuos.com/guncelleme/*` ve `smartmenuos.com/lisans/durum` isteklerini karşılayan Cloudflare Worker.
Kaynağı ve testleri SmartMenuOS deposunda (`tools/GuncellemeSunucusu`); buradaki dosyalar oradan kopyalanır,
değişiklik önce orada yapılıp sınanır.

- `/guncelleme/<kanal>.txt`: imzalı sürüm bildirimi, herkese açık
- `/guncelleme/paket/<parça>`: paket parçası, yalnızca geçerli imzalı lisansı olan kasaya; askıya alınmış ya da
  iptal edilmiş lisansa uyarı süresinden sonra verilmez
- `/lisans/durum`: kasaya imzalı lisans durumu

Paket dosyaları ve gizli anahtarlar bu depoda değil; paketler Workers KV'de, durum anahtarı Cloudflare'in gizli
değerlerinde durur.
