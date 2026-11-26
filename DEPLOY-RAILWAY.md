# Deploy ke Railway (bot jalan 24 jam tanpa PC)

Butuh dua service di satu project Railway: **waha** (WhatsApp) dan **bot** (kode dari repo GitHub ini).

## 1. Buat project
1. Daftar di https://railway.com (login pakai GitHub), pilih plan Hobby (~$5/bulan).
2. New Project > Empty Project.

## 2. Service "waha"
1. + Create > Docker Image > `devlikeapro/waha:latest`. Rename service menjadi `waha`.
2. Settings > Networking > Generate Domain (port 3000). Catat URL-nya, mis. `https://waha-xxxx.up.railway.app`.
3. Klik kanan service > Attach Volume, mount path: `/app/.sessions` (agar login WhatsApp tidak hilang).
4. Variables (isi nilai acak buatan sendiri, jangan dikirim ke chat):
   - `WAHA_API_KEY` = teks acak panjang
   - `WAHA_DASHBOARD_USERNAME` = admin
   - `WAHA_DASHBOARD_PASSWORD` = password kuat
   - `WHATSAPP_SWAGGER_USERNAME` = admin
   - `WHATSAPP_SWAGGER_PASSWORD` = sama dengan password dashboard
   - `WHATSAPP_RESTART_ALL_SESSIONS` = True
   - `WHATSAPP_HOOK_EVENTS` = message.any
   - `WHATSAPP_HOOK_URL` = diisi setelah langkah 3 (URL bot + `/webhook?token=...`)

## 3. Service "bot"
1. + Create > GitHub Repo > pilih repo ini. Railway otomatis membaca `Dockerfile` dan `railway.json`.
2. Settings > Networking > Generate Domain (port 8080). Catat URL-nya, mis. `https://bot-xxxx.up.railway.app`.
3. Attach Volume, mount path: `/app/data` (riwayat chat & draft).
4. Variables:
   - `ANTHROPIC_API_KEY` = key dari console.anthropic.com
   - `ADMIN_NUMBER` = nomor WA pribadi Elha, mis. 6281234567890
   - `WAHA_URL` = URL waha dari langkah 2.2
   - `WAHA_API_KEY` = sama persis dengan di service waha
   - `WEBHOOK_TOKEN` = teks acak panjang
   - `BOT_MODE` = draft
   - `PORT` = 8080
5. Kembali ke service waha, isi `WHATSAPP_HOOK_URL` = `https://bot-xxxx.up.railway.app/webhook?token=<WEBHOOK_TOKEN>`.

## 4. Scan QR
Buka `https://waha-xxxx.up.railway.app/dashboard`, login, isi API key, start session `default`, scan QR dari HP (WhatsApp > Perangkat tertaut).

## 5. Tes
Kirim chat dari nomor lain ke nomor bisnis. Draft akan masuk ke WA Elha; balas `kirim 1`.
Cek: `https://bot-xxxx.up.railway.app/health` harus menampilkan `"ok":true`.

## Update pengetahuan bot
Edit file di `knowledge/` langsung di GitHub, commit. Railway otomatis deploy ulang.
