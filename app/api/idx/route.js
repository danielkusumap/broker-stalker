const UPSTREAM = "https://stock.arjum.com";

// Cache server-side (TTL adaptif: data hari berjalan pendek, rentang historis panjang).
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_TTL_OLD_MS = 12 * 60 * 60 * 1000;
const cache = new Map(); // key → { body, contentType, expires }
const pending = new Map(); // key → Promise hasil fetch (dedupe permintaan paralel identik)

function ttlFor(upstream) {
  const day = upstream.searchParams.get("end_date") || upstream.searchParams.get("date");
  const todayUtc = new Date().toISOString().slice(0, 10);
  // rentang/hari yang sudah lewat tidak akan berubah lagi
  return day && day < todayUtc ? CACHE_TTL_OLD_MS : CACHE_TTL_MS;
}

async function fetchUpstream(upstream, apiKey) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(upstream, {
        headers: { "X-API-Key": apiKey, Accept: "application/json" },
        cache: "no-store",
      });
      return {
        status: res.status,
        ok: res.ok,
        body: await res.text(),
        contentType: res.headers.get("Content-Type") || "application/json",
      };
    } catch (err) {
      lastErr = err; // retry 1x kalau koneksi ke upstream terputus
    }
  }
  throw lastErr;
}

// Proxy server-side ke REST API IDX Edge.
// API key dibaca dari .env.local (IDX_API_KEY) dan TIDAK pernah sampai ke browser.
// Bentuk permintaan: GET /api/idx?path=/api/history/BBCA&start_date=...
export async function GET(request) {
  const apiKey = process.env.IDX_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "IDX_API_KEY belum diset. Isi file .env.local lalu restart dev server." },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(request.url);
  const path = searchParams.get("path");
  if (!path || !path.startsWith("/")) {
    return Response.json({ error: "Param 'path' wajib diisi (diawali /)." }, { status: 400 });
  }
  // Hanya endpoint /api/* yang boleh diteruskan.
  if (!path.startsWith("/api/")) {
    return Response.json({ error: "Hanya path /api/* yang diizinkan." }, { status: 400 });
  }

  const upstream = new URL(path, UPSTREAM);
  for (const [key, value] of searchParams.entries()) {
    if (key !== "path") upstream.searchParams.set(key, value);
  }

  const cacheKey = upstream.toString();
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) {
    return new Response(hit.body, {
      status: 200,
      headers: {
        "Content-Type": hit.contentType,
        "X-Cache": "HIT",
        "Cache-Control": "private, max-age=60",
      },
    });
  }

  try {
    // Dedupe: permintaan identik yang berjalan bersamaan cukup 1 fetch upstream.
    let p = pending.get(cacheKey);
    if (!p) {
      p = fetchUpstream(upstream, apiKey).finally(() => pending.delete(cacheKey));
      pending.set(cacheKey, p);
    }
    const { status, ok, body, contentType } = await p;
    if (ok) {
      cache.set(cacheKey, { body, contentType, expires: Date.now() + ttlFor(upstream) });
      // batasi ukuran cache (64 entri paling baru)
      if (cache.size > 64) cache.delete(cache.keys().next().value);
    }
    return new Response(body, {
      status,
      headers: { "Content-Type": contentType, "X-Cache": "MISS" },
    });
  } catch (err) {
    return Response.json(
      { error: `Gagal menghubungi server IDX: ${err.message}` },
      { status: 502 }
    );
  }
}
