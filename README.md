# Narto Player

Player drama lokal dengan katalog tersimpan dan pencarian langsung dari Narto Drama.

## Jalankan

```bash
node server.js
```

Buka `http://localhost:8902`. Node.js diperlukan; tidak ada paket yang perlu dipasang.

`catalog.json` berisi 6.504 judul unik dari snapshot lama, **bukan seluruh katalog Narto Drama saat ini**. Saat pengguna mengetik di pencarian, hasil diambil langsung dari halaman pencarian Narto Drama. Episode dan media juga diminta saat judul dipilih, sehingga ketersediaannya mengikuti sumber.

Tampilan kaca dan tata letak video tinggi berlaku pada layar mobile. CSS desktop tetap menggunakan tata letak sebelumnya.
