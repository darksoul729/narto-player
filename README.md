# Narto Player

Player drama lokal dengan katalog tersimpan dan pencarian langsung dari Narto Drama.

## Jalankan

```bash
node server.js
```

Buka `http://localhost:8902`. Node.js diperlukan; tidak ada paket yang perlu dipasang.

`catalog.json` dimulai dari snapshot lama berisi 6.504 judul unik, **bukan seluruh katalog Narto Drama saat ini**. Server menambahkan judul dari dua halaman utama terbaru saat mulai, setiap jam, dan ketika tombol **Update katalog** ditekan. Jika ada kata pencarian saat tombol ditekan, hasil pencarian itu ikut disimpan. Pembaruan menyimpan data secara atomik dan mempertahankan judul lama bila sumber gagal. Saat pengguna mengetik di pencarian, hasil diambil langsung dari Narto Drama. Episode dan media juga diminta saat judul dipilih, sehingga ketersediaannya mengikuti sumber.

Narto Drama tidak menyediakan daftar lengkap yang dapat diverifikasi lewat halaman utama ini. Jumlah lokal adalah jumlah judul yang sudah tersimpan, bukan klaim cakupan 100%.

Tampilan kaca dan tata letak video tinggi berlaku pada layar mobile. CSS desktop tetap menggunakan tata letak sebelumnya.
