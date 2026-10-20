"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { idxGet, isoDaysAgo } from "../../lib/idxClient";
import { formatNumber } from "../../lib/brokerMath";
import styles from "./screener.module.css";

function bucketBadge(bucket) {
  const b = String(bucket || "").toLowerCase();
  if (b.includes("neg") || b.includes("sell") || b.includes("distrib"))
    return `${styles.badge} ${styles.badgeNeg}`;
  if (b.includes("pos") || b.includes("buy") || b.includes("akumul") || b.includes("accum"))
    return `${styles.badge} ${styles.badgePos}`;
  return styles.badge;
}

function raw(v) {
  if (v == null || v === "") return "–";
  if (typeof v === "number") return v.toLocaleString("id-ID", { maximumFractionDigits: 2 });
  return String(v);
}

// Pipeline screener → stalker: 1 request di-load sekali (di-cache proxy 5 menit),
// tiap baris punya tombol kirim ke Broker Stalker.
export default function ScreenerPage() {
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const json = await idxGet("/api/screener/latest");
        if (!cancelled) {
          setRows(json.rows || []);
          setMeta({
            count: json.count ?? (json.rows || []).length,
            cachedFor: json.cached_for_seconds ?? null,
            fetchedAt: json.fetched_at || null,
          });
        }
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

  function goStalker(code) {
    router.push(`/broker-stalker?code=${code}&start=${isoDaysAgo(84)}`);
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>📊 Screener Cepat</h1>
      <p className={styles.subtitle}>
        Hasil screener IDX Edge + akumulasi broker, siap dialihkan ke Broker Stalker — klik tombol
        di barisnya. (1 request; hasil di-cache proxy 5 menit.)
      </p>

      {error && <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>}

      {meta && (
        <div className={styles.meta}>
          {formatNumber(meta.count)} saham
          {meta.cachedFor != null && ` · umur data ${meta.cachedFor} detik`}
          {meta.fetchedAt && ` · diambil ${meta.fetchedAt}`}
        </div>
      )}

      <div className={styles.card}>
        {loading && (
          <>
            {[...Array(8)].map((_, i) => (
              <div key={i} className={styles.skelBar} style={{ width: `${95 - i * 5}%` }} />
            ))}
          </>
        )}

        {!loading && rows.length === 0 && !error && (
          <p className={styles.meta}>Screener kosong — coba lagi nanti.</p>
        )}

        {rows.length > 0 && (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Kode</th>
                  <th scope="col">Nama</th>
                  <th scope="col">Bucket</th>
                  <th scope="col">Ringkasan</th>
                  <th scope="col" className={styles.num}>WR event</th>
                  <th scope="col" className={styles.num}>Drawdown</th>
                  <th scope="col">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.code}>
                    <td className={styles.code}>{r.code}</td>
                    <td>
                      <div>{raw(r.name)}</div>
                      <div className={styles.summary}>{r.note || "–"}</div>
                    </td>
                    <td>
                      <span className={bucketBadge(r.bucket)}>{raw(r.bucket)}</span>
                    </td>
                    <td className={styles.summary}>{raw(r.summary)}</td>
                    <td className={styles.num}>{raw(r.wr_event)}</td>
                    <td className={`${styles.num} ${styles.down}`}>
                      {r.drawdown != null && r.drawdown !== "" ? `-${raw(Math.abs(Number(r.drawdown) || 0))}` : "–"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className={styles.stalkerBtn}
                        onClick={() => goStalker(r.code)}
                      >
                        🔍 Stalker →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
