// GET via proxy lokal /api/idx — API key tidak pernah menyentuh browser.
// Dipakai oleh semua halaman yang butuh data IDX Edge.
export async function idxGet(path, params = {}) {
  const qs = new URLSearchParams({ path });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, v);
  }
  const res = await fetch(`/api/idx?${qs.toString()}`);
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* body bukan JSON */
  }
  if (!res.ok) {
    const msg =
      (json && (json.error || json.message || json.detail)) ||
      `Request gagal (HTTP ${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return json;
}

// Util tanggal (dipanggil dari event handler / effect — aman untuk prerender Next 16).
export function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ---- Cache hasil analisa di browser (hemat kuota: buka ulang halaman = 0 request) ----
// shortcut: menyimpan respons mentah apa adanya; bersihkan bila localStorage mulai penuh.
export function readCache(key) {
  try {
    const v = JSON.parse(localStorage.getItem(`brokerstalker.c.${key}`) || "null");
    return v && v.exp > Date.now() ? v.payload : null;
  } catch {
    return null;
  }
}

export function writeCache(key, payload, ttlMs) {
  const at = Date.now();
  try {
    localStorage.setItem(
      `brokerstalker.c.${key}`,
      JSON.stringify({ exp: at + ttlMs, at, payload })
    );
  } catch {
    /* storage penuh / private mode */
  }
  return at; // waktu simpan (dipakai indikator cache)
}

// Seperti readCache tapi menyertakan waktu simpan — untuk indikator "dari cache pukul …".
export function readCacheMeta(key) {
  try {
    const v = JSON.parse(localStorage.getItem(`brokerstalker.c.${key}`) || "null");
    if (!v || v.exp <= Date.now()) return null;
    return { payload: v.payload, savedAt: v.at ?? null, expires: v.exp };
  } catch {
    return null;
  }
}

// "14:32" dari timestamp (dipakai di indikator cache; hanya dirender klien-side).
export function cacheTimeLabel(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// Pasar tutup → data tidak berubah lagi hari ini, cache boleh tahan lama.
export function cacheTtlMs(price) {
  const closed = !price || price.no_trade_today === true || price.market_state !== "open";
  return closed ? 12 * 60 * 60 * 1000 : 15 * 60 * 1000;
}
