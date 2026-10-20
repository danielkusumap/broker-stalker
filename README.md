# Broker Stalker

Dashboard broker summary IDX: tracking transaksi per broker per tahap (ATH / Bullish / Bearish / Distribusi) dengan data historis yang disimpan lokal di SQLite.

## 1. Jalan lokal

```bash
npm install
cp .env.example .env     # lalu isi IDX_API_KEY
npm run dev
```

Buka http://localhost:3000

Kalau `.env` belum ada, aplikasi tetap jalan tapi halaman yang butuh data IDX akan error dengan pesan `IDX_API_KEY belum diset`.

## 2. Jalan dengan Docker Compose

```bash
cp .env.example .env     # isi IDX_API_KEY, APP_PORT, BASIC_AUTH_USER, BASIC_AUTH_PASSWORD
docker compose up -d --build
```

Buka http://localhost:9101 (atau sesuai `APP_PORT`).

Yang terjadi:

- `app` — Next.js standalone (port 3000, tidak dibuka ke host).
- `nginx` — reverse proxy + basic auth. Password dibaca dari `.env` saat container start, browser hanya minta sekali per sesi.
- `./data` di host di-mount ke `/app/data`, jadi database SQLite tidak hilang saat container di-rebuild.

Perintah harian:

```bash
docker compose logs -f app      # lihat log
docker compose restart nginx    # setelah ganti BASIC_AUTH_PASSWORD
docker compose down             # stop (data tetap di ./data)
```

> **Penting:** setelah mengganti `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` di `.env`, jalankan `docker compose up -d` (bukan hanya `restart`) supaya container nginx dibuat ulang dengan env baru.

## 3. File konfigurasi

| File | Ikut git? | Isi |
| --- | --- | --- |
| `.env` | tidak | key API, port, kredensial basic auth |
| `.env.example` | ya | template kosong untuk disalin |
| `docker-compose.yml` | ya | service `app` + `nginx` |
| `Dockerfile` | ya | build Next.js standalone |
| `nginx/Dockerfile`, `nginx/default.conf` | ya | reverse proxy + basic auth |
| `data/` | tidak | database SQLite lokal |

## 4. Variabel environment

| Nama | Default | Keterangan |
| --- | --- | --- |
| `IDX_API_KEY` | — | wajib, key API IDX Edge |
| `BS2_DB_PATH` | `./data/market.db` | di Docker di-override jadi `/app/data/market.db` |
| `APP_PORT` | `9101` | port web di host |
| `BASIC_AUTH_USER` | `stalker` | user basic auth |
| `BASIC_AUTH_PASSWORD` | — | password basic auth |
