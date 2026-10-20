"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { idxGet, isoDaysAgo, readCache, writeCache } from "../../lib/idxClient";
import { formatNumber, formatPct, formatPrice, formatRp } from "../../lib/brokerMath";
// Halaman daftar (seperti /screener) → memakai modul CSS yang sama biar tampilannya konsisten.
import styles from "../screener/screener.module.css";

const TABS = [
  { key: "chg", label: "Gainers / Losers" },
  { key: "value", label: "Top Nilai" },
  { key: "lot", label: "Top Lot" },
  { key: "freq", label: "Top Frekuensi" },
];

const MOVERS_TTL_MS = 5 * 60 * 1000; // agregat harian — cukup 5 menit

async function fetchMovers(by) {
  const key = `movers|${by}`;
  const cached = readCache(key);
  if (cached) return cached;
  const fresh = await idxGet("/api/movers", { by, n: 20 });
  writeCache(key, fresh, MOVERS_TTL_MS);
  return fresh;
}

export default function MoversPage() {
  const router = useRouter();
  const [by, setBy] = useState("chg");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const json = await fetchMovers("chg");
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function pick(kind) {
    setBy(kind);
    setError("");
    setLoading(true);
    try {
      setData(await fetchMovers(kind));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function openStalker(code) {
    router.push(`/broker-stalker?code=${code}&start=${isoDaysAgo(60)}`);
  }

  const lists = data
    ? by === "chg"
      ? [
          ["🟢 Top Gainers", data.gainers || []],
          ["🔴 Top Losers", data.losers || []],
        ]
      : [[`Top ${TABS.find((t) => t.key === by)?.label || by}`, data.top || []]]
    : [];

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>📈 Movers</h1>
      <p className={styles.subtitle}>
        Peringkat dari agregat harian (bukan window menit): gainer/loser, atau teratas per nilai,
        lot, dan frekuensi. Klik kode untuk dianalisa di Broker Stalker. Hasil di-cache 5 menit.
      </p>

      <div className={styles.toolbar}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`${styles.stalkerBtn} ${by === t.key ? styles.activeBtn : ""}`}
            aria-pressed={by === t.key}
            onClick={() => pick(t.key)}
          >
            {t.label}
          </button>
        ))}
        <span className={styles.meta}>
          {data?.market?.label || ""}
          {data?.count != null ? ` · ${formatNumber(data.count)} saham ikut perhitungan` : ""}
        </span>
      </div>

      {error && <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>}

      {data?.count === 0 && (
        <div className={`${styles.banner} ${styles.bannerError}`}>
          Peringkat harian <b>kosong di server data IDX Edge</b>
          {data?.market?.label ? ` · status pasar: ${data.market.label}` : ""}
          {data?.market?.next_open ? ` · buka ${data.market.next_open}` : ""}. Ini bukan tanda
          bursa libur: kalau tetap kosong padahal pasar sudah tutup, berarti agregat peringkat
          harian belum diisi server — data harga &amp; broker untuk ticker tertentu tetap normal
          (cek di Broker Stalker).
        </div>
      )}

      {loading && !data && (
        <div className={styles.card}>
          {[...Array(6)].map((_, i) => (
            <div key={i} className={styles.skelBar} style={{ width: `${92 - i * 6}%` }} />
          ))}
        </div>
      )}

      {lists.map(([title, rows]) => (
        <section key={title} className={styles.card} style={{ marginBottom: 14 }}>
          <div className={styles.cardTitle}>
            {title}
            <small> · {formatNumber(rows.length)} baris</small>
          </div>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Kode</th>
                  <th scope="col" className={styles.num}>Harga</th>
                  <th scope="col" className={styles.num}>Perubahan</th>
                  <th scope="col" className={styles.num}>%</th>
                  <th scope="col" className={styles.num}>Frek</th>
                  <th scope="col" className={styles.num}>Lot</th>
                  <th scope="col" className={styles.num}>Nilai</th>
                  <th scope="col">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.code}>
                    <td>
                      <button
                        type="button"
                        className={styles.codeLink}
                        onClick={() => openStalker(r.code)}
                      >
                        {r.code}
                      </button>
                    </td>
                    <td className={styles.num}>{formatPrice(r.last_price)}</td>
                    <td className={`${styles.num} ${r.change >= 0 ? styles.up : styles.down}`}>
                      {formatNumber(r.change)}
                    </td>
                    <td className={`${styles.num} ${r.change_pct >= 0 ? styles.up : styles.down}`}>
                      {formatPct(r.change_pct, 2)}
                    </td>
                    <td className={styles.num}>{formatNumber(r.freq)}</td>
                    <td className={styles.num}>{formatNumber(r.lot)}</td>
                    <td className={styles.num}>{formatRp(r.value)}</td>
                    <td>
                      <button
                        type="button"
                        className={styles.stalkerBtn}
                        onClick={() => openStalker(r.code)}
                      >
                        🔍 Stalker
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
