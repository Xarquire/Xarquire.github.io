// Worker'ın verdiği metinlerdeki destek satırı. Kasadaki tek kaynak
// src/RestaurantSystem.Core/DestekBilgisi.cs; Worker aynı metni elle taşır ve biçimi
// (numara "0542 354 08 51", e-posta) DestekBilgisiTests ile test/wrangler.test.mjs denetler.

export const DESTEK_SATIRI = "WhatsApp 0542 354 08 51 · smartmenuoss@gmail.com";

// Askıya alınmış ya da iptal edilmiş lisansa uyarı süresi bitince paket yerine verilir.
export const DURDURULDU_METNI = "Lisansınız durduruldu. Güncelleme verilemiyor. Lütfen bizi arayın: " + DESTEK_SATIRI;
