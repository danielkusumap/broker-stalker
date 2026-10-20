"use client";

import { useEffect, useMemo, useState } from "react";
import { idxGet, isoDaysAgo, todayIso, readCache, writeCache } from "../../lib/idxClient";
import { matchInventory, formatNumber, formatShares, formatLot, formatPrice, formatPct, formatRp } from "../../lib/brokerMath";
// Shell halaman/table dari modul bersama (dipakai /screener & /movers) + gaya chart dari Broker Stalker.
import styles from "../screener/screener.module.css";
import chart from "../broker-stalker/broker-stalker.module.css";

const PALETTE = ["#38bdf8", "#f472b6", "#facc15", "#4ade80", "#c084fc", "#fb923c", "#22d3ee", "#f87171", "#a3e635", "#818cf8"];
const PAD = { l: 78, r: 78, t: 18, b: 30 };
const TTL_OPEN_MS = 15 * 60 * 1000;
const TTL_CLOSED_MS = 12 * 60 * 60 * 1000;

// duplikat kecil dari broker-stalker (chart util) — biar tiap route tetap mandiri
function nearestIdx(clientX, rect, viewBoxW, len) {
  if (!rect || !rect.width || len <= 0) return 0;
  const vx = ((clientX - rect.left) / rect.width) * viewBoxW;
  const t = (vx - PAD.l) / (viewBoxW - PAD.l - PAD.r);
  return Math.max(0, Math.min(len - 1, Math.round(t * (len - 1))));
}
const fmtDate = (d) => String(d).slice(5).split("-").reverse().join("/");

// --- indikator sederhana dari OHLCV (tanpa library, tanpa request) ---
function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// drawdown berjalan: seberapa jauh harga di bawah puncaknya sepanjang waktu
function drawdownSeries(closes) {
  let peak = -Infinity;
  return closes.map((c) => {
    if (c > peak) peak = c;
    return peak > 0 ? ((c - peak) / peak) * 100 : 0;
  });
}

const MA20_COLOR = "#facc15";
const MA60_COLOR = "#c084fc";

// ------------- CHART CANDLE: OHLC + panel volume + MA20/MA60 -------------
const PAD_C = { l: 78, r: 78, t: 18, b: 26 };
const PRICE_PANE_H = 250;

function CandleChart({ rows, ma20, ma60 }) {
  const W = 960;
  const H = 360;
  const VOL_H = 70;
  const [hoverIdx, setHoverIdx] = useState(null);

  const model = useMemo(() => {
    if (!rows || rows.length < 2) return null;
    const dates = rows.map((r) => r.date);
    const opens = rows.map((r) => r.open ?? r.close ?? 0);
    const highs = rows.map((r) => r.high ?? r.close ?? 0);
    const lows = rows.map((r) => r.low ?? r.close ?? 0);
    const closes = rows.map((r) => r.close ?? 0);
    const vols = rows.map((r) => r.volume ?? 0);
    const maxVol = Math.max(1, ...vols);

    let pMin = Math.min(...lows);
    let pMax = Math.max(...highs);
    if (pMin === pMax) {
      pMin -= 1;
      pMax += 1;
    }
    const pad = (pMax - pMin) * 0.05;
    pMin -= pad;
    pMax += pad;

    const priceBottom = PAD_C.t + PRICE_PANE_H;
    const x = (i) => PAD_C.l + (dates.length <= 1 ? 0 : (i / (dates.length - 1)) * (W - PAD_C.l - PAD_C.r));
    const yP = (v) => PAD_C.t + (1 - (v - pMin) / (pMax - pMin)) * (priceBottom - PAD_C.t);
    const yV = (v) => H - PAD_C.b - (v / maxVol) * VOL_H;
    const cw = Math.max(1, ((W - PAD_C.l - PAD_C.r) / Math.max(dates.length, 1)) * 0.62);
    const maPath = (arr) =>
      (arr || [])
        .map((v, i) => (v == null ? null : `${i && arr[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${yP(v).toFixed(1)}`))
        .filter(Boolean)
        .join(" ");
    return { dates, opens, highs, lows, closes, vols, x, yP, yV, cw, pMin, pMax, priceBottom, maxVol, maPath };
  }, [rows]);

  if (!model) return null;
  const { dates, opens, highs, lows, closes, vols, x, yP, yV, cw, pMin, pMax, priceBottom, maxVol, maPath } = model;
  const h = hoverIdx != null && hoverIdx >= 0 && hoverIdx < dates.length ? hoverIdx : null;

  function handleMove(e) {
    setHoverIdx(nearestIdx(e.clientX, e.currentTarget.getBoundingClientRect(), W, dates.length));
  }
  function handleTouch(e) {
    const t = e.touches && e.touches[0];
    if (t) setHoverIdx(nearestIdx(t.clientX, e.currentTarget.getBoundingClientRect(), W, dates.length));
  }
  const tipPct = h != null ? (x(h) / W) * 100 : 0;
  const tipStyle = {
    left: `${tipPct}%`,
    transform: tipPct > 62 ? "translateX(-100%)" : tipPct < 10 ? "translateX(0)" : "translateX(-50%)",
  };
  const dateTickIdx = [...new Set([0, Math.floor((dates.length - 1) / 3), Math.floor((2 * (dates.length - 1)) / 3), dates.length - 1])];
  const pTicks = [pMin, (pMin + pMax) / 2, pMax];
  const row = h == null ? null : rows[h];

  return (
    <div className={chart.chartWrap} onMouseMove={handleMove} onMouseLeave={() => setHoverIdx(null)} onTouchStart={handleTouch} onTouchMove={handleTouch}>
      <svg viewBox={`0 0 ${W} ${H}`} className={chart.svg} role="img" aria-label="Chart candlestick OHLC dan volume">
        {/* grid harga */}
        {pTicks.map((v, i) => (
          <g key={`t${i}`}>
            <line x1={PAD_C.l} y1={yP(v)} x2={W - PAD_C.r} y2={yP(v)} stroke="rgba(148,163,184,0.15)" strokeWidth="1" />
            <text x={PAD_C.l - 6} y={yP(v) + 4} textAnchor="end" className={chart.axis}>{formatPrice(Math.round(v))}</text>
          </g>
        ))}
        {/* batas panel volume */}
        <line x1={PAD_C.l} y1={H - PAD_C.b} x2={W - PAD_C.r} y2={H - PAD_C.b} stroke="rgba(148,163,184,0.35)" strokeWidth="1" />
        <text x={PAD_C.l - 6} y={H - PAD_C.b - VOL_H / 2} textAnchor="end" className={chart.axis}>vol</text>
        <text x={PAD_C.l - 6} y={yV(maxVol) + 8} textAnchor="end" className={chart.axis}>{formatShares(maxVol)}</text>

        {/* candle */}
        {dates.map((d, i) => {
          const up = closes[i] >= opens[i];
          const col = up ? "#22c55e" : "#ef4444";
          const yO = yP(opens[i]);
          const yC = yP(closes[i]);
          return (
            <g key={d}>
              <line x1={x(i)} y1={yP(highs[i])} x2={x(i)} y2={yP(lows[i])} stroke={col} strokeWidth="1" opacity="0.85" />
              <rect x={x(i) - cw / 2} y={Math.min(yO, yC)} width={cw} height={Math.max(1, Math.abs(yC - yO))} fill={col} />
              <rect x={x(i) - cw / 2} y={yV(vols[i])} width={cw} height={Math.max(1, H - PAD_C.b - yV(vols[i]))} fill={col} opacity="0.35" />
            </g>
          );
        })}

        {/* MA20/MA60 */}
        {maPath(ma60) && <path d={maPath(ma60)} fill="none" stroke={MA60_COLOR} strokeWidth="1.4" strokeDasharray="5 4" opacity="0.85" />}
        {maPath(ma20) && <path d={maPath(ma20)} fill="none" stroke={MA20_COLOR} strokeWidth="1.4" strokeDasharray="5 4" opacity="0.9" />}

        {/* label tanggal */}
        {dateTickIdx.map((i) => (
          <text key={`d${i}`} x={x(i)} y={H - 8} textAnchor="middle" className={chart.axis}>{fmtDate(dates[i])}</text>
        ))}

        {/* legend */}
        <g>
          <rect x={PAD_C.l} y={2} width={14} height={3} fill={MA20_COLOR} />
          <text x={PAD_C.l + 18} y={8} className={chart.axis}>MA20</text>
          <rect x={PAD_C.l + 60} y={2} width={14} height={3} fill={MA60_COLOR} />
          <text x={PAD_C.l + 78} y={8} className={chart.axis}>MA60</text>
          <text x={PAD_C.l + 124} y={8} className={chart.axis}>volume (lembar) di panel bawah</text>
        </g>

        {/* crosshair */}
        {h != null && (
          <g pointerEvents="none">
            <line x1={x(h)} y1={PAD_C.t} x2={x(h)} y2={H - PAD_C.b} stroke="#38bdf8" strokeDasharray="3 3" strokeWidth="1" opacity="0.85" />
            <circle cx={x(h)} cy={yP(closes[h])} r="3" fill="#e2e8f0" style={{ stroke: "var(--surface)", strokeWidth: 1.5 }} />
          </g>
        )}
      </svg>

      {row && (
        <div className={chart.chartTip} style={tipStyle}>
          <div className={chart.tipHead}>
            <b>{fmtDate(dates[h])}</b>
            <span className={row.close >= row.open ? styles.up : styles.down}>
              {formatPct(row.change_pct, 2)}
            </span>
          </div>
          <div className={chart.tipRow}>
            O/H/L/C{" "}
            <b>
              {formatPrice(row.open)} / {formatPrice(row.high)} / {formatPrice(row.low)} /{" "}
              {formatPrice(row.close)}
            </b>
          </div>
          <div className={chart.tipRow}>
            volume <b>{formatShares(row.volume)}</b>
          </div>
          <div className={chart.tipRow}>
            nilai <b>{formatRp(row.value)}</b>
          </div>
          <div className={chart.tipRow}>
            avg harian <b>{formatPrice(row.avg)}</b>
          </div>
          {(ma20?.[h] != null || ma60?.[h] != null) && (
            <div className={chart.tipRow}>
              MA20/MA60{" "}
              <b>
                {ma20?.[h] != null ? formatPrice(Math.round(ma20[h])) : "–"} /{" "}
                {ma60?.[h] != null ? formatPrice(Math.round(ma60[h])) : "–"}
              </b>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function parseBrokers(text) {
  return [...new Set(String(text || "").toUpperCase().split(/[^A-Z0-9]+/).filter((c) => c.length >= 2 && c.length <= 4))];
}

// ------------- CHART INVENTORY: harga (Rp, kiri) + tumpukan posisi broker (lembar, kanan) ----
function InventoryChart({ dates, closes, bands, onHoverIdx, splitIdx, ma20, ma60 }) {
  const W = 960;
  const H = 340;
  const maxTotal = Math.max(1, ...bands.map((b) => Math.max(...b.upper)));
  let pMin = Math.min(...closes);
  let pMax = Math.max(...closes);
  if (pMin === pMax) {
    pMin -= 1;
    pMax += 1;
  }
  const pad = (pMax - pMin) * 0.06;
  pMin -= pad;
  pMax += pad;
  const x = (i) => PAD.l + (dates.length <= 1 ? 0 : (i / (dates.length - 1)) * (W - PAD.l - PAD.r));
  const yS = (v) => PAD.t + (1 - v / maxTotal) * (H - PAD.t - PAD.b);
  const yP = (v) => PAD.t + (1 - (v - pMin) / (pMax - pMin)) * (H - PAD.t - PAD.b);
  const bandPath = (b) =>
    `${b.upper.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yS(v).toFixed(1)}`).join(" ")} ` +
    `${[...b.lower].reverse().map((v, j) => `L${x(dates.length - 1 - j).toFixed(1)},${yS(v).toFixed(1)}`).join(" ")} Z`;
  const pricePath = closes.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yP(v).toFixed(1)}`).join(" ");
  const maPath = (arr) =>
    arr
      .map((v, i) => (v == null ? null : `${i && arr[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${yP(v).toFixed(1)}`))
      .filter(Boolean)
      .join(" ");
  const ticks = [0, maxTotal / 2, maxTotal];
  const pTicks = [pMin, (pMin + pMax) / 2, pMax];
  const dateTickIdx = [...new Set([0, Math.floor((dates.length - 1) / 3), Math.floor((2 * (dates.length - 1)) / 3), dates.length - 1])];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={chart.svg} role="img" aria-label="Chart inventory broker dan harga">
      {splitIdx >= 0 && splitIdx < dates.length && (
        <rect x={x(splitIdx)} y={PAD.t} width={Math.max(0, x(dates.length - 1) + 12 - x(splitIdx))} height={H - PAD.t - PAD.b} fill="rgba(56,189,248,0.06)" />
      )}
      {ticks.map((v, i) => (
        <g key={`t${i}`}>
          <line x1={PAD.l} y1={yS(v)} x2={W - PAD.r} y2={yS(v)} stroke="rgba(148,163,184,0.15)" strokeWidth="1" />
          <text x={PAD.l - 6} y={yS(v) + 4} textAnchor="end" className={chart.axis}>{formatShares(v)}</text>
        </g>
      ))}
      {pTicks.map((v, i) => (
        <text key={`p${i}`} x={W - PAD.r + 6} y={yP(v) + 4} textAnchor="start" className={chart.axis}>{formatPrice(Math.round(v))}</text>
      ))}
      {dateTickIdx.map((i) => (
        <text key={`d${i}`} x={x(i)} y={H - 8} textAnchor="middle" className={chart.axis}>{fmtDate(dates[i])}</text>
      ))}

      {/* tumpukan posisi per broker */}
      {bands.map((b) => (
        <path key={b.code} d={bandPath(b)} fill={b.color} opacity="0.55" />
      ))}

      {/* harga + MA20/MA60 */}
      <path d={pricePath} fill="none" stroke="#e2e8f0" strokeWidth="2" opacity="0.9" />
      {maPath(ma60) && <path d={maPath(ma60)} fill="none" stroke={MA60_COLOR} strokeWidth="1.4" strokeDasharray="5 4" opacity="0.85" />}
      {maPath(ma20) && <path d={maPath(ma20)} fill="none" stroke={MA20_COLOR} strokeWidth="1.4" strokeDasharray="5 4" opacity="0.9" />}

      {/* legend (maks 8 broker supaya tidak tumpang tindih) */}
      <g>
        <rect x={PAD.l} y={2} width={14} height={3} fill="#e2e8f0" />
        <text x={PAD.l + 18} y={8} className={chart.axis}>harga</text>
        <rect x={PAD.l + 62} y={2} width={14} height={3} fill={MA20_COLOR} />
        <text x={PAD.l + 80} y={8} className={chart.axis}>MA20</text>
        <rect x={PAD.l + 116} y={2} width={14} height={3} fill={MA60_COLOR} />
        <text x={PAD.l + 134} y={8} className={chart.axis}>MA60</text>
        {bands.slice(0, 8).map((b, i) => (
          <g key={b.code} transform={`translate(${PAD.l + 180 + i * 95}, 0)`}>
            <rect x={0} y={2} width={10} height={10} fill={b.color} />
            <text x={14} y={11} className={chart.axis}>{b.code}</text>
          </g>
        ))}
        {bands.length > 8 && (
          <text x={PAD.l + 180 + 8 * 95} y={11} className={chart.axis}>+{bands.length - 8}</text>
        )}
      </g>

      {/* crosshair */}
      {onHoverIdx != null && (
        <g pointerEvents="none">
          <line x1={x(onHoverIdx)} y1={PAD.t} x2={x(onHoverIdx)} y2={H - PAD.b} stroke="#38bdf8" strokeDasharray="3 3" strokeWidth="1" opacity="0.85" />
          <circle cx={x(onHoverIdx)} cy={yP(closes[onHoverIdx])} r="3.5" fill="#e2e8f0" style={{ stroke: "var(--surface)", strokeWidth: 1.5 }} />
        </g>
      )}
    </svg>
  );
}

export default function InventoryPage() {
  const [ticker, setTicker] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [brokerInput, setBrokerInput] = useState("");
  const [data, setData] = useState(null); // { code, start, end, rows, series }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [hover, setHover] = useState(null);
  const [view, setView] = useState("inv"); // "inv" | "candle"
  const [cacheNote, setCacheNote] = useState("");

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setEndDate(todayIso());
    setStartDate(isoDaysAgo(120));
    const qs = new URLSearchParams(window.location.search);
    const c = (qs.get("code") || "").toUpperCase();
    if (/^[A-Z0-9]{4}$/.test(c)) setTicker(c);
    if (qs.get("start")) setStartDate(qs.get("start"));
    if (qs.get("brokers")) setBrokerInput((qs.get("brokers") || "").toUpperCase());
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  // ---- muat: 2 request (history + akumulasi broker), cache klien ----
  async function load(e, override = {}) {
    e && e.preventDefault();
    const code = String(override.code ?? ticker).trim().toUpperCase();
    const start = String(override.start ?? startDate);
    const brokers = parseBrokers(override.brokers ?? brokerInput);
    if (!/^[A-Z0-9]{4}$/.test(code)) {
      setFieldError("Ticker harus 4 karakter, misal BBCA.");
      return;
    }
    if (!start) {
      setFieldError("Isi tanggal mulai.");
      return;
    }
    setFieldError("");
    setError("");
    const end = endDate || todayIso();
    const key = `inv|${code}|${start}|${end}|${brokers.join(",")}`;

    if (!override.force) {
      const cached = readCache(key);
      if (cached) {
        setData(cached);
        setCacheNote(`dari cache · 0 request`);
        return;
      }
    }

    setLoading(true);
    try {
      const [history, accum] = await Promise.all([
        idxGet(`/api/history/${code}`, { start_date: start, end_date: end, limit: 500 }),
        idxGet(`/api/broker-accumulation/${code}`, {
          start_date: start,
          end_date: end,
          top: 5,
          ...(brokers.length ? { brokers: brokers.join(",") } : {}),
        }),
      ]);
      const payload = {
        code,
        start,
        end,
        rows: (history.rows || history.candles || []).sort((a, b) => String(a.date).localeCompare(String(b.date))),
        series: accum.series || [],
      };
      writeCache(key, payload, end < todayIso() ? TTL_CLOSED_MS : TTL_OPEN_MS);
      setData(payload);
      setCacheNote("");
    } catch (err) {
      setError(err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  // ---- hitung posisi per broker (average-cost, tanpa request tambahan) ----
  const results = useMemo(() => {
    if (!data) return [];
    const lastClose = data.rows.length ? data.rows[data.rows.length - 1].close : null;
    const lastDate = data.rows.length ? data.rows[data.rows.length - 1].date : null;
    return data.series
      .map((s) => {
        const inv = matchInventory(s.points || []);
        return {
          code: s.broker_code,
          name: s.broker_name || s.broker_code,
          shares: inv.shares,
          avgCost: inv.avgCost,
          peak: inv.peak,
          timeline: inv.timeline,
          lastClose,
          lastDate,
          diffPct: inv.shares > 0 && inv.avgCost > 0 && lastClose ? ((lastClose - inv.avgCost) / inv.avgCost) * 100 : null,
          value: inv.shares > 0 && lastClose ? inv.shares * lastClose : 0,
        };
      })
      .sort((a, b) => b.shares - a.shares);
  }, [data]);

  // pita tumpukan: carry-forward posisi tiap broker lalu ditumpuk
  const bands = useMemo(() => {
    if (!data || !results.length) return [];
    const dates = data.rows.map((r) => r.date);
    let base = new Array(dates.length).fill(0);
    return results.map((b, i) => {
      const byDate = new Map(b.timeline.map((t) => [t.date, t.shares]));
      let last = 0;
      const shares = dates.map((d) => {
        if (byDate.has(d)) last = byDate.get(d);
        return last;
      });
      const lower = [...base];
      const upper = shares.map((v, j) => base[j] + v);
      base = upper;
      return { code: b.code, color: PALETTE[i % PALETTE.length], shares, lower, upper };
    });
  }, [data, results]);

  const dates = data ? data.rows.map((r) => r.date) : [];
  const closes = data ? data.rows.map((r) => r.close ?? 0) : [];

  // ---- statistik OHLCV (0 request, dari data history yang sama) ----
  const stats = useMemo(() => {
    if (!data || data.rows.length < 2) return null;
    const rows = data.rows;
    const cls = rows.map((r) => r.close ?? 0);
    const ma20 = sma(cls, 20);
    const ma60 = sma(cls, 60);
    const dd = drawdownSeries(cls);
    const last = rows[rows.length - 1];
    const n = Math.min(20, rows.length);
    const avgVal = rows.slice(-n).reduce((s, r) => s + (r.value || 0), 0) / n;
    const ma20Last = ma20[ma20.length - 1];
    const ma60Last = ma60[ma60.length - 1];
    return {
      ma20,
      ma60,
      dd,
      lastDate: last.date,
      lastValue: last.value || 0,
      avgVal,
      liqPct: avgVal > 0 ? ((last.value || 0) / avgVal) * 100 : null,
      ddNow: dd[dd.length - 1],
      ddWorst: Math.min(...dd),
      vsMa20: ma20Last ? ((last.close - ma20Last) / ma20Last) * 100 : null,
      vsMa60: ma60Last ? ((last.close - ma60Last) / ma60Last) * 100 : null,
      ma20Last,
      ma60Last,
    };
  }, [data]);
  const h = hover != null && hover >= 0 && hover < dates.length ? hover : null;
  const totalsAtH = h == null ? null : bands.reduce((s, b) => s + b.shares[h], 0);
  const closeAtH = h == null ? null : closes[h];
  const tipPct = h != null ? ((PAD.l + (dates.length <= 1 ? 0 : (h / (dates.length - 1)) * (960 - PAD.l - PAD.r))) / 960) * 100 : 0;
  const stalkerUrl = (code, broker) =>
    `/broker-stalker?code=${data?.code || ""}&start=${startDate}${broker ? `&brokers=${broker}` : ""}`;

  function handleMove(e) {
    const idx = nearestIdx(e.clientX, e.currentTarget.getBoundingClientRect(), 960, dates.length);
    setHover(idx);
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>📦 Inventory Chart</h1>
      <p className={styles.subtitle}>
        Satu ticker, dua sumbu: <b>kurva harga</b> (Rp, kiri) dan <b>tumpukan posisi broker</b>
        (lembar, kanan) hasil average-cost dari net harian. 2 request. Untuk analisa lanjutan
        (fase, ledger realisasi, order flow) klik <b>Stalker ↗</b> — terbuka di tab baru.
      </p>

      <form className={styles.form} onSubmit={(e) => load(e, { force: true })}>
        <label className={styles.field}>
          <span>Ticker</span>
          <input
            className={`${styles.input} ${styles.inputCode}`}
            value={ticker}
            onChange={(e) => {
              setTicker(e.target.value.toUpperCase());
              setFieldError("");
            }}
            placeholder="BBCA"
            maxLength={4}
            aria-label="Kode saham 4 karakter"
          />
        </label>
        <label className={styles.field}>
          <span>Mulai</span>
          <input
            type="date"
            className={styles.input}
            value={startDate}
            max={endDate || undefined}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>Broker (opsional, pisah koma)</span>
          <input
            className={`${styles.input} ${styles.inputBrokers}`}
            value={brokerInput}
            onChange={(e) => setBrokerInput(e.target.value.toUpperCase())}
            placeholder="ZP,YU"
            aria-label="Filter kode broker, opsional"
          />
        </label>
        <button
          type="submit"
          className={`${styles.stalkerBtn} ${styles.activeBtn}`}
          disabled={loading}
        >
          {loading ? "Memuat…" : "Muat chart"}
        </button>
        {data && (
          <a
            className={styles.stalkerBtn}
            href={stalkerUrl()}
            target="_blank"
            rel="noopener noreferrer"
          >
            🔍 Buka {data.code} di Broker Stalker ↗
          </a>
        )}
        {cacheNote && <span className={styles.meta}>· {cacheNote}</span>}
        {fieldError && <span className={styles.fieldErr}>{fieldError}</span>}
      </form>

      {error && <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>}

      {loading && !data && (
        <div className={styles.card}>
          {[...Array(6)].map((_, i) => (
            <div key={i} className={styles.skelBar} style={{ width: `${92 - i * 6}%` }} />
          ))}
        </div>
      )}

      {data && (
        <section className={styles.card} style={{ marginBottom: 14 }}>
          <div className={styles.cardTitle}>
            {data.code} · {data.rows.length} hari bursa · {results.length} broker
            <small>
              {" · "}harga dipakai: penutupan terakhir{" "}
              {results.length ? results[0].lastDate : "–"} · arahkan kursor untuk detail
            </small>
            <span className={styles.toolbar} style={{ float: "right", marginBottom: 0 }}>
              <button
                type="button"
                className={`${styles.stalkerBtn} ${view === "inv" ? styles.activeBtn : ""}`}
                aria-pressed={view === "inv"}
                onClick={() => setView("inv")}
              >
                📦 Inventory
              </button>
              <button
                type="button"
                className={`${styles.stalkerBtn} ${view === "candle" ? styles.activeBtn : ""}`}
                aria-pressed={view === "candle"}
                onClick={() => setView("candle")}
              >
                🕯️ Candle + volume
              </button>
            </span>
          </div>
          {view === "candle" ? (
            <CandleChart rows={data.rows} ma20={stats?.ma20} ma60={stats?.ma60} />
          ) : (
          <div
            className={chart.chartWrap}
            onMouseMove={handleMove}
            onMouseLeave={() => setHover(null)}
            onTouchStart={handleMove}
            onTouchMove={handleMove}
          >
            <InventoryChart dates={dates} closes={closes} bands={bands} onHoverIdx={h} splitIdx={-1} ma20={stats?.ma20} ma60={stats?.ma60} />
            {h != null && (
              <div
                className={chart.chartTip}
                style={{
                  left: `${tipPct}%`,
                  transform: tipPct > 62 ? "translateX(-100%)" : tipPct < 10 ? "translateX(0)" : "translateX(-50%)",
                }}
              >
                <div className={chart.tipHead}>
                  <b>{fmtDate(dates[h])}</b>
                  <span>harga {formatPrice(closeAtH)}</span>
                </div>
                <div className={chart.tipRow}>
                  avg harian <b>{formatPrice(data.rows[h].avg)}</b>
                </div>
                <div className={chart.tipRow}>
                  nilai <b>{formatRp(data.rows[h].value)}</b>
                </div>
                {stats && (
                  <div className={chart.tipRow}>
                    drawdown <b className={styles.down}>{formatPct(stats.dd[h], 1, false)}</b>
                  </div>
                )}
                <div className={chart.tipRow}>
                  total posisi <b>{formatShares(totalsAtH)}</b>
                </div>
                {bands
                  .filter((b) => b.shares[h] > 0)
                  .map((b) => (
                    <div key={b.code} className={chart.tipRow}>
                      <span className={chart.tipDot} style={{ background: b.color }} />
                      {b.code}
                      <b>{formatShares(b.shares[h])}</b>
                    </div>
                  ))}
              </div>
            )}
          </div>
          )}
        </section>
      )}

      {data && stats && (
        <section className={styles.card} style={{ marginBottom: 14 }}>
          <div className={styles.cardTitle}>
            📐 Statistik OHLCV
            <small> · dari data history yang sama · 0 request · penutupan {stats.lastDate}</small>
          </div>
          <div className={styles.statGrid}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Drawdown sekarang / terburuk</span>
              <b className={styles.down}>
                {formatPct(stats.ddNow, 1, false)} / {formatPct(stats.ddWorst, 1, false)}
              </b>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Harga vs MA20 / MA60</span>
              <b className={stats.vsMa20 == null ? "" : stats.vsMa20 >= 0 ? styles.up : styles.down}>
                {formatPct(stats.vsMa20, 1)}
              </b>{" "}
              <b className={stats.vsMa60 == null ? "" : stats.vsMa60 >= 0 ? styles.up : styles.down}>
                {formatPct(stats.vsMa60, 1)}
              </b>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Likuiditas: nilai {stats.lastDate} vs rata-rata 20 hari</span>
              <b>{formatRp(stats.lastValue)}</b> / {formatRp(stats.avgVal)}
              {stats.liqPct != null && (
                <span className={styles.meta}> ({formatPct(stats.liqPct, 0, false)})</span>
              )}
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>MA20 / MA60 terkini</span>
              <b>{formatPrice(stats.ma20Last)}</b> / <b>{formatPrice(stats.ma60Last)}</b>
            </div>
          </div>
        </section>
      )}

      {results.length > 0 && (
        <section className={styles.card}>
          <div className={styles.cardTitle}>
            Inventory vs harga
            <small> · selisih = (harga − avg cost) ÷ avg cost · harga dari penutupan terakhir</small>
          </div>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Broker</th>
                  <th scope="col" className={styles.num}>Posisi</th>
                  <th scope="col" className={styles.num}>Avg cost</th>
                  <th scope="col" className={styles.num}>Harga</th>
                  <th scope="col" className={styles.num}>Selisih</th>
                  <th scope="col" className={styles.num}>Nilai posisi</th>
                  <th scope="col">Analisa lanjutan</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.code}>
                    <td>
                      <span className={styles.codeLink}>{r.code}</span>
                      <div className={styles.summary}>{r.name}</div>
                    </td>
                    <td className={styles.num}>
                      {formatShares(r.shares)}
                      <div className={styles.summary}>{formatLot(r.shares)}</div>
                    </td>
                    <td className={styles.num}>{r.shares > 0 ? formatPrice(r.avgCost) : "–"}</td>
                    <td className={styles.num}>{formatPrice(r.lastClose)}</td>
                    <td className={`${styles.num} ${r.diffPct == null ? "" : r.diffPct >= 0 ? styles.up : styles.down}`}>
                      {r.diffPct == null ? "–" : formatPct(r.diffPct)}
                    </td>
                    <td className={styles.num}>{r.value ? formatRp(r.value) : "–"}</td>
                    <td>
                      <a
                        className={styles.stalkerBtn}
                        href={stalkerUrl(r.code, r.code)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Buka ${data.code} + broker ${r.code} di Broker Stalker (tab baru)`}
                      >
                        🔍 Stalker ↗
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
