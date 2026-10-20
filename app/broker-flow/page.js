"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { idxGet, isoDaysAgo, todayIso, readCache, writeCache } from "../../lib/idxClient";
import { formatRp, formatShares, formatPrice, formatNumber } from "../../lib/brokerMath";
import styles from "./broker-flow.module.css";

const WATCH_KEY = "brokerstalker.watchlist";
const CACHE_TTL_MS = 15 * 60 * 1000; // hasil per broker+ticker+rentang tahan 15 menit

function parseTickers(text) {
  return [
    ...new Set(
      String(text || "")
        .toUpperCase()
        .split(/[^A-Z0-9]+/)
        .filter((c) => c.length === 4)
    ),
  ].slice(0, 30);
}

// Sinyal dari net value total vs net 5 hari terakhir.
function signalOf(r) {
  if (r.error) return { label: "ERROR", cls: styles.sigSell };
  if (r.missing || !r.days) return { label: "TIDAK ADA DATA", cls: styles.sigFlat };
  const pos = r.netVal > 0;
  const recent = r.last5 > 0;
  if (pos && recent) return { label: "MASIH BELI", cls: styles.sigBuy };
  if (!pos && !recent) return { label: "MASIH JUAL", cls: styles.sigSell };
  if (pos && !recent) return { label: "AMBIL PROFIT?", cls: styles.sigWarn };
  if (!pos && recent) return { label: "BALIK BELI?", cls: styles.sigWarn };
  return { label: "DATAR", cls: styles.sigFlat };
}

// ---- MODE BALIK: input kode broker → cek posisinya di banyak emitens sekaligus.
// 1 ticker = 1 request (`brokers=` di query) — user diberi tahu biayanya di UI.
export default function BrokerFlowPage() {
  const router = useRouter();
  const [broker, setBroker] = useState("");
  const [tickersText, setTickersText] = useState("");
  const [rangeDays, setRangeDays] = useState(30);
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [ranBroker, setRanBroker] = useState(""); // broker yang dipakai pada hasil yang sedang tampil
  const [ranStart, setRanStart] = useState(""); // tanggal mulai hasil yang sedang tampil
  const bootRan = useRef(false);

  // muat watchlist tersimpan + state dari URL (?b=ZP&t=BBCA,BBRI&d=30)
  useEffect(() => {
    let saved = "";
    try {
      saved = localStorage.getItem(WATCH_KEY) || "";
    } catch {
      saved = "";
    }
    const qs = new URLSearchParams(window.location.search);
    const qBroker = (qs.get("b") || "").toUpperCase();
    const qTickers = qs.get("t");
    const qDays = Number(qs.get("d"));
    /* eslint-disable react-hooks/set-state-in-effect */
    if (qBroker && /^[A-Z0-9]{2,4}$/.test(qBroker)) setBroker(qBroker);
    setTickersText(qTickers || saved);
    if ([7, 30, 90].includes(qDays)) setRangeDays(qDays);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  // ---- jalankan pemeriksaan (sequential, ada progres) ----
  async function runFlow(override = {}) {
    const b = String(override.broker ?? broker).trim().toUpperCase();
    const text = override.text ?? tickersText;
    const days = override.days ?? rangeDays;
    const list = parseTickers(text);
    if (!/^[A-Z0-9]{2,4}$/.test(b)) {
      setError("Kode broker 2–4 karakter, mis. ZP atau HD.");
      return;
    }
    if (!list.length) {
      setError("Isi minimal 1 ticker (4 huruf), dipisah koma — mis. BBCA,BBRI,ASII.");
      return;
    }
    setError("");
    setNote("");
    setRows([]);
    setProgress(0);
    setRunning(true);
    setRanBroker(b); // link "Stalker" harus memakai broker INI, bukan isi input yang mungkin sudah diubah

    const start = isoDaysAgo(days);
    const end = todayIso();
    setRanStart(start); // idem untuk rentang: pakai tanggal mulai hasil, bukan preset saat klik
    const out = [];
    let cachedCount = 0;

    for (let i = 0; i < list.length; i++) {
      const code = list[i];
      const cacheKey = `fl|${b}|${code}|${start}|${end}`;
      // cache klien 15 menit: klik ulang / buka ulang link tidak memakai kuota lagi
      const cached = readCache(cacheKey);
      if (cached) {
        cachedCount += 1;
        out.push(cached);
        setRows([...out]);
        setProgress(i + 1);
        continue;
      }
      try {
        const json = await idxGet(`/api/broker-accumulation/${code}`, {
          start_date: start,
          end_date: end,
          brokers: b,
          top: 1,
        });
        const s = (json.series || [])[0];
        const pts = (s && s.points) || [];
        let row;
        if (!pts.length) {
          row = { code, missing: true };
        } else {
          const netVal = pts.reduce((a, p) => a + (p.nval || 0), 0);
          const netVol = pts.reduce((a, p) => a + (p.nvol || 0), 0);
          const last5 = pts.slice(-5).reduce((a, p) => a + (p.nval || 0), 0);
          const last = pts[pts.length - 1] || {};
          row = {
            code,
            netVal,
            netVol,
            days: pts.length,
            last5,
            lastPrice: last.bavg ?? last.savg ?? null,
          };
        }
        writeCache(cacheKey, row, CACHE_TTL_MS);
        out.push(row);
      } catch (err) {
        out.push({ code, error: err.message });
      }
      // update progres/hasil live (dipanggil dari handler async, bukan effect)
      setRows([...out]);
      setProgress(i + 1);
    }

    setRunning(false);
    setNote(
      `${list.length} ticker diperiksa · ${start} → ${end} · ${list.length} request` +
        (cachedCount ? ` (${cachedCount} dari cache, 0 request)` : "")
    );

    // simpan watchlist + tulis state ke URL (shareable)
    try {
      localStorage.setItem(WATCH_KEY, list.join(","));
    } catch {
      /* storage penuh / private mode */
    }
    const qs = new URLSearchParams({ b, t: list.join(","), d: String(days) });
    window.history.replaceState(null, "", `${window.location.pathname}?${qs.toString()}`);
  }

  // auto-run saat dibuka via link: ?b=ZP&t=BBCA,BBRI&d=30
  useEffect(() => {
    if (bootRan.current) return;
    const qs = new URLSearchParams(window.location.search);
    const qBroker = (qs.get("b") || "").toUpperCase();
    const qTickers = qs.get("t");
    if (!/^[A-Z0-9]{2,4}$/.test(qBroker) || !qTickers) return;
    bootRan.current = true;
    // Boot fetch dari link bersifat on-mount; jalankan sekali.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    runFlow({
      broker: qBroker,
      text: qTickers,
      days: [7, 30, 90].includes(Number(qs.get("d"))) ? Number(qs.get("d")) : 30,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      if (a.error || a.missing) return 1;
      if (b.error || b.missing) return -1;
      return Math.abs(b.netVal || 0) - Math.abs(a.netVal || 0);
    });
  }, [rows]);

  const totalNet = rows.reduce((s, r) => s + (r.netVal || 0), 0);
  const tickerCount = parseTickers(tickersText).length;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>🔄 Broker Flow</h1>
      <p className={styles.subtitle}>
        Mode balik dari Broker Stalker: masukkan <b>satu kode broker</b>, lalu lihat arah uangnya
        di banyak emitens sekaligus — net value, net 5 hari terakhir, dan sinyal masih beli /
        masih jual. Watchlist tersimpan otomatis di browser ini.
      </p>

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          runFlow();
        }}
      >
        <label className={styles.field}>
          <span>Kode broker</span>
          <input
            className={styles.inputBroker}
            value={broker}
            onChange={(e) => setBroker(e.target.value.toUpperCase())}
            placeholder="ZP"
            maxLength={4}
            autoComplete="off"
            aria-label="Kode broker 2-4 karakter"
          />
        </label>
        <label className={styles.field}>
          <span>Daftar ticker (pisah koma)</span>
          <input
            className={styles.inputTickers}
            value={tickersText}
            onChange={(e) => setTickersText(e.target.value.toUpperCase())}
            placeholder="BBCA,BBRI,ASII,BBTN,BMAS"
            autoComplete="off"
            aria-label="Daftar ticker dipisah koma"
          />
        </label>
        <div className={styles.presets} role="group" aria-label="Rentang waktu">
          {[[7, "7h"], [30, "30h"], [90, "90h"]].map(([d, label]) => (
            <button
              key={d}
              type="button"
              className={styles.presetBtn}
              aria-pressed={rangeDays === d}
              onClick={() => setRangeDays(d)}
              style={
                rangeDays === d
                  ? { background: "rgba(56,189,248,0.16)", color: "var(--primary)" }
                  : undefined
              }
            >
              {label}
            </button>
          ))}
        </div>
        <button className={styles.primaryBtn} type="submit" disabled={running}>
          {running ? `Memuat ${progress}/${tickerCount}…` : "Cek broker"}
        </button>
        {tickerCount > 0 && (
          <span className={styles.hint}>
            {tickerCount} ticker ≈ {tickerCount} request kuota
          </span>
        )}
      </form>

      {error && <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>}
      {note && !error && <div className={`${styles.banner} ${styles.bannerWarn}`}>ℹ️ {note}</div>}

      {sorted.length > 0 && (
        <section className={styles.card}>
          <div className={styles.cardTitle}>
            🧭 Hasil lintas emiten — broker <b>{broker}</b>
            <small> · urut |net| terbesar · total net {formatRp(totalNet, true)}</small>
          </div>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Ticker</th>
                  <th scope="col">Sinyal</th>
                  <th scope="col" className={styles.num}>Net (Rp)</th>
                  <th scope="col" className={styles.num}>Net (lembar)</th>
                  <th scope="col" className={styles.num}>5 hari (Rp)</th>
                  <th scope="col" className={styles.num}>Hari aktif</th>
                  <th scope="col" className={styles.num}>Avg beli</th>
                  <th scope="col">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const sig = signalOf(r);
                  if (r.error) {
                    return (
                      <tr key={r.code}>
                        <td className={styles.code}>{r.code}</td>
                        <td><span className={`${styles.sig} ${sig.cls}`}>{sig.label}</span></td>
                        <td colSpan={5} className={styles.sub}>{r.error}</td>
                        <td>–</td>
                      </tr>
                    );
                  }
                  if (r.missing) {
                    return (
                      <tr key={r.code}>
                        <td className={styles.code}>{r.code}</td>
                        <td><span className={`${styles.sig} ${sig.cls}`}>{sig.label}</span></td>
                        <td colSpan={5} className={styles.sub}>
                          Broker ini tidak tercatat transaksi di {r.code} pada rentang ini.
                        </td>
                        <td>
                          <button
                            type="button"
                            className={styles.stalkerBtn}
                            onClick={() =>
                              router.push(
                                `/broker-stalker?code=${r.code}&start=${ranStart || isoDaysAgo(rangeDays)}&brokers=${ranBroker || broker}`
                              )
                            }
                          >
                            🔍 Stalker →
                          </button>
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={r.code}>
                      <td className={styles.code}>{r.code}</td>
                      <td>
                        <span className={`${styles.sig} ${sig.cls}`}>{sig.label}</span>
                      </td>
                      <td className={`${styles.num} ${r.netVal >= 0 ? styles.up : styles.down}`}>
                        {formatRp(r.netVal, true)}
                      </td>
                      <td className={`${styles.num} ${r.netVol >= 0 ? styles.up : styles.down}`}>
                        {formatShares(r.netVol)}
                      </td>
                      <td className={`${styles.num} ${r.last5 >= 0 ? styles.up : styles.down}`}>
                        {formatRp(r.last5, true)}
                      </td>
                      <td className={styles.num}>{formatNumber(r.days)}</td>
                      <td className={styles.num}>{formatPrice(r.lastPrice)}</td>
                      <td>
                        <button
                          type="button"
                          className={styles.stalkerBtn}
                          onClick={() =>
                            router.push(
                              `/broker-stalker?code=${r.code}&start=${ranStart || isoDaysAgo(rangeDays)}&brokers=${ranBroker || broker}`
                            )
                          }
                        >
                          🔍 Stalker →
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer className={styles.footer}>
        <b>Catatan:</b> sinyal disimpulkan dari <i>net value harian broker</i> pada rentang terpilih
        (5 hari terakhir vs total) — inferensi, bukan fakta posisi. Kuota terpakai 1 request per
        ticker; data di-cache proxy 5 menit. Bukan rekomendasi beli/jual.
      </footer>
    </div>
  );
}
