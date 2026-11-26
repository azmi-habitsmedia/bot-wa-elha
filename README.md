# Bot WhatsApp Habits Media (WAHA + Claude)

Bot ini membalas chat WhatsApp client dengan gaya bahasa Elha, memakai pengetahuan dari `knowledge/second-brain-bot-whatsapp.md` dan `knowledge/panduan-gaya-bahasa-elha.md`.

Alurnya:

```
Client WhatsApp ──> WAHA (terhubung ke nomor WA) ──webhook──> bot ──> Claude API
                                     ^                                   │
                                     └──────────── sendText ─────────────┘
```

WAHA dan bot berjalan berdampingan di Docker pada satu komputer, jadi **tidak perlu URL publik**.

## Cara kerja bot

- **Mode `draft` (default, disarankan di awal).** Bot tidak membalas client. Setiap usulan balasan dikirim ke WhatsApp Elha (nomor `ADMIN_NUMBER`). Elha tinggal membalas:
  - `kirim 5` untuk mengirim draft #5 apa adanya
  - `ubah 5 teks balasan versi Elha` untuk mengirim versi yang sudah diedit
  - `batal 5` untuk membuang draft
- **Mode `auto`.** Di jam kerja (Senin–Jumat 09.00–17.00 WIB) bot langsung membalas client. Hal yang perlu keputusan (harga, diskon, deal, invoice, medpart, topik sensitif) dibalas dengan balasan sementara, lalu ringkasannya dikirim ke Elha. Di luar jam kerja, bot kembali membuat draft.
- **Elha bisa ambil alih kapan saja.** Begitu Elha membalas client secara manual dari HP, bot berhenti di chat itu selama 12 jam.
- Bot mengabaikan grup, status, dan channel. Nomor keluarga/teman/tim bisa dimasukkan ke `IGNORE_NUMBERS`.
- Bot menunggu 10 detik setelah bubble terakhir client, supaya beberapa pesan beruntun dibalas sekali.
- Perintah lain dari nomor Elha: `status`, `mode draft`, `mode auto`, `mode off`, `jeda 62812xxx`, `lanjut 62812xxx`, `bantuan`.

## Langkah setup (sekitar 20 menit)

1. **Pasang Docker Desktop** di PC/laptop Windows: https://www.docker.com/products/docker-desktop/ lalu jalankan sampai statusnya "Engine running".
2. **Buat API key Claude** di https://console.anthropic.com/settings/keys (isi saldo/billing dulu di menu Billing).
3. **Siapkan file `.env`.** Di folder `bot-wa-waha`, salin `.env.example` menjadi `.env`, lalu buka dengan Notepad dan isi:
   - `ANTHROPIC_API_KEY` = API key dari langkah 2
   - `ADMIN_NUMBER` = nomor WA pribadi Elha, contoh `6281234567890`
   - `WAHA_API_KEY`, `WEBHOOK_TOKEN`, `WAHA_DASHBOARD_PASSWORD` = teks acak buatan sendiri
   - Jangan pernah kirim isi `.env` ke chat atau ke orang lain.
4. **Jalankan.** Buka PowerShell di folder `bot-wa-waha`, lalu ketik:
   ```
   docker compose up -d --build
   ```
5. **Scan QR WhatsApp.** Buka http://localhost:3000/dashboard, login dengan username/password dashboard dari `.env`. Saat diminta API key, isi `WAHA_API_KEY`. Start session bernama `default`, lalu scan QR dari HP: WhatsApp > Perangkat tertaut > Tautkan perangkat.
6. **Tes.** Dari nomor lain, kirim chat ke nomor bisnis. Dalam ±15 detik, draft balasan akan masuk ke WhatsApp Elha. Balas `kirim 1` untuk mengirimnya.
7. **Cek log bila ada masalah:** `docker compose logs -f bot`

Untuk mematikan: `docker compose down`. Login WhatsApp tetap tersimpan di folder `waha-sessions`.

## Memperbarui pengetahuan bot

Edit file `.md` di folder `knowledge/` (misalnya mengisi rate card resmi di bagian 6), lalu jalankan `docker compose restart bot`.

## Hosting: PC sendiri atau VPS

- **PC/laptop sendiri.** Gratis dan cocok untuk uji coba. Bot hanya jalan selama PC menyala, Docker Desktop terbuka, dan tidak sleep.
- **VPS (disarankan untuk dipakai harian).** Server Linux kecil (1–2 GB RAM, sekitar Rp70–150 ribu/bulan, misalnya Biznet Gio, IDCloudHost, DigitalOcean). Langkahnya sama: pasang Docker, salin folder ini, isi `.env`, `docker compose up -d --build`. Dashboard dibuka lewat SSH tunnel (`ssh -L 3000:localhost:3000 user@ip-vps`) karena port sengaja hanya dibuka untuk localhost.

## Catatan penting

- WAHA bukan API resmi WhatsApp. Ada risiko nomor diblokir WhatsApp jika dipakai untuk spam. Bot ini hanya membalas chat masuk, jadi risikonya kecil, tetapi tetap disarankan memakai nomor bisnis, bukan nomor pribadi.
- Bot tidak bisa membuka lampiran (proposal PDF, gambar). Bot hanya mengonfirmasi penerimaan dan meneruskan ke Elha.
- Jika client bertanya "ini bot?", bot menjawab jujur bahwa ini asisten admin yang membantu Elha. Ubah aturan ini di `src/server.js` (bagian `RULES`) jika Elha ingin berbeda.
- Jika perintah `kirim 1` dari HP Elha tidak dikenali, lihat log (`docker compose logs bot`). WhatsApp kadang memakai ID berakhiran `@lid`; salin ID yang muncul di log ke `ADMIN_NUMBER`.
- Biaya Claude: dengan model `claude-sonnet-5-5` dan prompt caching, kira-kira beberapa ratus rupiah per balasan. Pantau di console.anthropic.com > Usage.
