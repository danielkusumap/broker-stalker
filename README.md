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

Dua cara akses, pilih satu sesuai deploy:

**A. Lewat panel (Dokploy/Coolify/dll) — default, tanpa publish port**

```bash
docker compose up -d --build
```

Arahkan domain di panel ke service **`app`**, port **3000** (port internal container). Panel menghubungkan Traefik langsung ke network Docker, jadi tidak ada port host yang dipakai dan tidak bisa bentrok. Basic auth aktif dari `proxy.js`.

**B. Domain menembak port host (VPS + reverse proxy sendiri)**

```bash
docker compose -f docker-compose.yml -f docker-compose.direct.yml up -d --build
```

Ini membuka `APP_DIRECT_PORT` (default `3000`) di host. Arahkan domain ke port itu, atau lebih aman ke nginx di `APP_PORT` (`9101`).

> Kalau muncul `Bind for 0.0.0.0:3000 failed: port is already allocated`, artinya ada proses/container lain di port 3000. Cek dengan `docker ps --filter "publish=3000"`, lalu pakai cara **A**, atau ganti `APP_DIRECT_PORT` ke port yang bebas.

Yang terjadi:

- `app` — Next.js standalone (port 3000, internal).
- `nginx` — reverse proxy + basic auth tambahan, publish di `APP_PORT` (9101).
- `./data` di host di-mount ke `/app/data`, jadi database SQLite tidak hilang saat container di-rebuild.

Database hanya cache. Kalau `/app/data` tidak bisa ditulis (mis. bind mount milik root), aplikasi tetap jalan: cache pindah ke `/tmp/broker-stalker` dan alasannya muncul di log. Cek lewat field `db` di respons `/api/bs2/summary` — isinya path cache yang dipakai, atau `nonaktif`.

```bash
docker compose logs app | grep bs2/db   # lihat kalau cache sedang fallback
```



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

