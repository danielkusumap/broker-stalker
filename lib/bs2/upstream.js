// Klien REST IDX Edge khusus server (API key tidak pernah ke browser).
const UPSTREAM = "https://stock.arjum.com";

export async function apiGet(path, params = {}) {
  const key = process.env.IDX_API_KEY;
  if (!key) throw new Error("IDX_API_KEY belum diset di .env.local");

  const url = new URL(path, UPSTREAM);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: { "X-API-Key": key, Accept: "application/json" },
    cache: "no-store",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* body bukan JSON */
  }
  if (!res.ok) {
    const msg = json?.error || json?.message || json?.detail || `HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  if (!json) throw new Error("Respons API bukan JSON");
  return json;
}

export async function fetchSummary(code, start, end) {
  const json = await apiGet(`/api/broker-summary/${code}`, {
    start_date: start,
    end_date: end,
    broker_limit: 500,
    net: "true",
  });
  return json.brokers || [];
}

export async function fetchHistory(code, start, end) {
  const json = await apiGet(`/api/history/${code}`, {
    start_date: start,
    end_date: end,
    limit: 500,
  });
  return json.rows || json.candles || [];
}

export async function fetchDaily(code, start, end, brokers) {
  const json = await apiGet(`/api/broker-accumulation/${code}`, {
    start_date: start,
    end_date: end,
    brokers: brokers?.length ? brokers.join(",") : undefined,
    top: brokers?.length ? undefined : 5,
  });
  return json.series || [];
}
