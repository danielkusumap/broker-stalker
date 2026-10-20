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
cp .env.example .env     # isi IDX_API_KEY, BASIC_AUTH_USER, BASIC_AUTH_PASSWORD
docker compose up -d --build
```

Dua pintu masuk, pakai salah satu:

- **Port 3000** — aplikasi langsung, dipakai kalau domain diarahkan ke `:3000`. Basic auth aktif di level aplikasi (`proxy.js`).
- **Port 9101** — lewat nginx (reverse proxy + basic auth). Cocok kalau mau satu port untuk semua.

Kredensial sama untuk keduanya, jadi tidak ada prompt dobel.

Yang terjadi:

- `app` — Next.js standalone (port 3000).
- `nginx` — reverse proxy + basic auth tambahan.
- `./data` di host di-mount ke `/app/data`, jadi database SQLite tidak hilang saat container di-rebuild.

Perintah harian:

```bash
docker compose logs -f app      # lihat log
docker compose up -d            # WAJIB setelah ganti kredensial di .env
docker compose down             # stop (data tetap di ./data)
```

> **Penting:** setelah mengganti `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` di `.env`, jalankan `docker compose up -d` (bukan `restart`) supaya env baru terbaca.

## 3. Login

Basic auth diminta sekali per sesi browser, lalu browser mengirim ulang otomatis.

| Kondisi | Password diminta? |
| --- | --- |
| `NODE_ENV=production` (Docker, `npm start`) + `BASIC_AUTH_PASSWORD` terisi | ya |
| `npm run dev` | tidak |
| `BASIC_AUTH_ENABLED=false` | tidak (matikan auth) |
| `BASIC_AUTH_PASSWORD` kosong | tidak |

Kalau lupa password: lihat `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` di `.env`.

## 4. File konfigurasi

| File | Ikut git? | Isi |
| --- | --- | --- |
| `.env` | tidak | key API, port, kredensial basic auth |
| `.env.example` | ya | template kosong untuk disalin |
| `proxy.js` | ya | basic auth level aplikasi |
| `docker-compose.yml` | ya | service `app` + `nginx` |
| `Dockerfile` | ya | build Next.js standalone |
| `nginx/Dockerfile`, `nginx/default.conf` | ya | reverse proxy + basic auth |
| `data/` | tidak | database SQLite lokal |

## 5. Variabel environment

| Nama | Default | Keterangan |
| --- | --- | --- |
| `IDX_API_KEY` | — | wajib, key API IDX Edge |
| `BS2_DB_PATH` | `./data/market.db` | di Docker di-override jadi `/app/data/market.db` |
| `APP_DIRECT_PORT` | `3000` | port aplikasi langsung di host |
| `APP_PORT` | `9101` | port nginx di host |
| `BASIC_AUTH_USER` | `stalker` | user basic auth |
| `BASIC_AUTH_PASSWORD` | — | password basic auth |
| `BASIC_AUTH_ENABLED` | ikut `NODE_ENV` | `true`/`false` untuk paksa nyala/mati |

