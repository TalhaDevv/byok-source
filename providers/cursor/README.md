# Cursor sağlayıcısı

Bu klasör Cursor BYOK köprüsünün tamamıdır. AntiGravity motorundan bağımsızdır.

| Dosya | İş |
| --- | --- |
| `index.js` | Yerel vekil, yerel CA, Cursor `settings.json` proxy yazımı |
| `agent.js` | Cursor Agent isteklerinin yakalanması ve modele çevrilmesi |
| `catalog.js` | Model kimliği, görünen ad, hash normalizasyonu |

Uygulama bu klasörü yalnızca `main.js` içindeki şu satırdan yükler:

```js
const cursor = require("./providers/cursor");
```

## Bilinen durum

Cursor tarafı şu an **çalışmıyor**. Modeller seçildikten sonra istekler retry döngüsünde kalıyor; yanıt tamamlanmıyor. Yerel vekil ve sertifika kurulumu açılıyor olsa da sohbet akışı kırık.

Bunun nedeni büyük olasılıkla Cursor Agent protokolünün (BidiAppend / RunSSE) bu köprüdeki yeniden yazımıyla uyuşmaması. Sistemin değiştirilmesi veya düzeltilmesi gerekiyor. Yama bu klasörün içinde yapılmalı; AntiGravity motoruna (`engine.js`) dokunmaya gerek yok.

## Kaldırmak

1. `providers/cursor` klasörünü sil.
2. `main.js` içinde `require("./providers/cursor")` satırını ve `cursor.*` çağrılarını kaldır.
3. `preload.js` içindeki `cursor*` köprülerini kaldır.
4. `renderer` içinde Cursor sekmesini (`data-tab="cursor"` ve ilgili fonksiyonlar) kaldır.
5. `package.json` `build.files` listesinden `providers/cursor/**/*` satırını sil.

## Düzeltmek

Önce `agent.js` içindeki yakalanan yollara ve gövde dönüşümüne bak. Retry'da kalan çağrı genelde `RunSSE` veya `BidiAppend` yanıtının Cursor'un beklediği protobuf/SSE biçiminde olmamasından çıkar. `index.js` vekil katmanını, protokol düzelmeden değiştirme.
