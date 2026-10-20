"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeBroker,
  priceChangeBetween,
  suggestSplitDate,
  intensityPct,
  resultsToCsv,
  ledgerToCsv,
  formatNumber,
  formatShares,
  formatLot,
  formatRp,
  formatPct,
  formatPrice,
} from "../../lib/brokerMath";
import { idxGet, isoDaysAgo, todayIso, readCacheMeta, cacheTimeLabel, writeCache, cacheTtlMs } from "../../lib/idxClient";
import styles from "./broker-stalker.module.css";

const PALETTE = ["#38bdf8", "#f472b6", "#facc15", "#4ade80", "#c084fc", "#fb923c", "#22d3ee", "#f87171", "#a3e635", "#818cf8"];

// Indeks titik data terdekat dari posisi pointer (pemetaan viewBox-aware).
function nearestIdx(clientX, rect, viewBoxW, len) {
  if (!rect || !rect.width || len <= 0) return 0;
  const vx = ((clientX - rect.left) / rect.width) * viewBoxW;
  const t = (vx - PAD.l) / (viewBoxW - PAD.l - PAD.r);
  return Math.max(0, Math.min(len - 1, Math.round(t * (len - 1))));
}

// "2026-10-08" → "08/10/2026"
function fmtDate(d) {
  return String(d).slice(5).split("-").reverse().join("/");
}

// Tanggal default "batas fase": 10 hari bursa dari akhir data (urut naik).
function defaultSplitDate(rows, fallback) {
  const dates = rows.map((r) => r.date).sort();
  if (dates.length > 10) return dates[dates.length - 10];
  if (dates.length > 1) return dates[0];
  return fallback;
}

export default function BrokerStalkerPage() {
  const [ticker, setTicker] = useState("");
  // Tanggal default diisi SETELAH mount (new Date() tidak boleh ikut prerender).
  const [startDate, setStartDate] = useState("");
  const [today, setToday] = useState("");
  const [splitDate, setSplitDate] = useState("");
  const [data, setData] = useState(null); // { code, start, end, accum, price, history }
  const [extra, setExtra] = useState({}); // key → series[] (refetch broker manual)
  const [selected, setSelected] = useState([]); // kode broker terpilih
  const [brokerInput, setBrokerInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [fetchingBrokers, setFetchingBrokers] = useState(false);
  const [error, setError] = useState("");
  const [brokerError, setBrokerError] = useState("");
  const [fieldError, setFieldError] = useState(""); // validasi inline (di bawah input)
  const [toast, setToast] = useState(""); // feedback aksi singkat
  const [cacheInfo, setCacheInfo] = useState(null); // { fromCache, at } — sumber data yang tampil
  const toastTimer = useRef(null);
  const bootRan = useRef(false); // auto-run sekali saat dibuka via link berparameter
  const tickerRef = useRef(null); // fokus input saat tekan shortcut "/"
  // ---- fitur tambahan (tanpa/opsional kuota) ----
  const [simPrice, setSimPrice] = useState(null); // what-if harga (recompute lokal)
  const [insiders, setInsiders] = useState(null); // overlay insider (null = belum dimuat)
  const [flowData, setFlowData] = useState(null); // order flow hari terakhir
  const [marketInfo, setMarketInfo] = useState(null); // jumlah saham beredar
  const [levelsData, setLevelsData] = useState(null); // zona akumulasi per level harga
  const [analysis, setAnalysis] = useState(null); // output analisa mesin (teks)
  const [loadingExtra, setLoadingExtra] = useState(""); // "insiders" | "flow" | "mcap" | "levels" | "analysis"
  const [phaseChanges, setPhaseChanges] = useState([]); // alert fase berubah antar-kunjungan

  function showToast(msg) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2600);
  }

  useEffect(() => {
    // Tanggal "hari ini" harus dihitung setelah mount — new Date() tidak
    // boleh dievaluasi saat prerender (Next 16: unstable value).
    /* eslint-disable react-hooks/set-state-in-effect */
    setToday(todayIso());
    setStartDate((prev) => prev || isoDaysAgo(84));
    // State dipulihkan dari URL (shareable link): ?code=&start=&split=&brokers=
    const qs = new URLSearchParams(window.location.search);
    const qCode = (qs.get("code") || "").toUpperCase();
    const qStart = qs.get("start");
    const qSplit = qs.get("split");
    const qBrokers = qs.get("brokers");
    if (qStart) setStartDate(qStart);
    if (qSplit) setSplitDate(qSplit);
    if (qBrokers) {
      // kode broker IDX umumnya 2 huruf (ZP, YU, HD) — izinkan 2–4 karakter
      setSelected([
        ...new Set(qBrokers.split(",").filter((c) => /^[A-Z0-9]{2,4}$/.test(c))),
      ]);
    }
    if (/^[A-Z0-9]{4}$/.test(qCode)) setTicker(qCode);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const historyRows = useMemo(() => {
    if (!data) return [];
    const rows = data.history.rows || data.history.candles || [];
    return [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [data]);

  // ---- fetch awal (3 request sekali jalan) ----
  // override: { code, start, split, force } — dipakai boot dari URL & preset rentang.
  // force=true hanya dari tombol submit (user minta data baru).
  async function run(e, override = {}) {
    e && e.preventDefault();
    const code = String(override.code ?? ticker).trim().toUpperCase();
    const start = String(override.start ?? startDate);
    if (!/^[A-Z0-9]{4}$/.test(code)) {
      setFieldError("Ticker harus 4 karakter, misal BBCA.");
      return;
    }
    if (!start) {
      setFieldError("Pilih tanggal mulai pantau.");
      return;
    }
    setFieldError("");
    setError("");
    setBrokerError("");

    const end = today || todayIso();
    const keepSplit = override.split || (data && data.code === code && splitDate) || "";

    // Cache klien: pasar tutup → 12 jam, pasar buka → 15 menit. Hemat 3 request per buka ulang.
    if (!override.force) {
      const hit = readCacheMeta(`${code}|${start}|${end}`);
      if (hit) {
        applyLoaded(hit.payload, keepSplit);
        setCacheInfo({ fromCache: true, at: hit.savedAt });
        showToast(`Data ${code} dari cache · 0 request`);
        return;
      }
    }

    setLoading(true);
    try {
      const [accum, price, history] = await Promise.all([
        idxGet(`/api/broker-accumulation/${code}`, { start_date: start, end_date: end, top: 5 }),
        idxGet(`/api/price/${code}`),
        idxGet(`/api/history/${code}`, { start_date: start, end_date: end, limit: 500 }),
      ]);
      const payload = { code, start, end, accum, price, history };
      const savedAt = writeCache(`${code}|${start}|${end}`, payload, cacheTtlMs(price));
      applyLoaded(payload, keepSplit);
      setCacheInfo({ fromCache: false, at: savedAt });
      showToast(`Analisa ${code} dimuat · 3 request`);
    } catch (err) {
      setError(err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  // Terapkan hasil (dari API atau cache) ke state.
  function applyLoaded(payload, keepSplit) {
    const { code, start, history } = payload;
    const rows = (history.rows || history.candles || []).sort((a, b) =>
      String(a.date).localeCompare(String(b.date))
    );
    setData(payload);
    setExtra({});
    // reset data tambahan & simulasi untuk ticker baru
    setInsiders(null);
    setFlowData(null);
    setMarketInfo(null);
    setLevelsData(null);
    setAnalysis(null);
    setSimPrice(null);
    setPhaseChanges([]);
    if (data && data.code !== code) setSelected([]); // ganti ticker → bersihkan pilihan
    setSplitDate(keepSplit || defaultSplitDate(rows, start));
  }

  // preset 1m/3m/6m/1y — kalau data sudah ada, langsung fetch ulang
  function applyPreset(days) {
    const start = isoDaysAgo(days);
    setStartDate(start);
    setFieldError("");
    if (data) run(null, { start });
  }

  // ---- cache untuk ticker + rentang yang sedang diisi (kunci sama dengan run()) ----
  // `today` baru terisi setelah mount; sebelum itu kunci dikosongkan supaya tidak
  // memanggil new Date() saat prerender (batasan Next 16).
  const cacheKeyNow = today ? `${String(ticker).trim().toUpperCase()}|${startDate}|${today}` : "";
  const cacheHitNow = cacheKeyNow ? readCacheMeta(cacheKeyNow) : null;

  // Tombol eksplisit: pakai data cache tanpa menyentuh API (0 request).
  function loadFromCache() {
    const key = `${String(ticker).trim().toUpperCase()}|${startDate}|${today || todayIso()}`;
    const hit = readCacheMeta(key);
    if (!hit) {
      showToast("Belum ada cache untuk ticker + rentang ini");
      return;
    }
    const keep = data && data.code === hit.payload.code ? splitDate : "";
    applyLoaded(hit.payload, keep);
    setCacheInfo({ fromCache: true, at: hit.savedAt });
    showToast("Dimuat dari cache · 0 request");
  }

  // Auto-run saat dibuka lewat link berparameter: ?code=BBCA&start=...&split=...&brokers=...
  useEffect(() => {
    if (bootRan.current) return;
    const qs = new URLSearchParams(window.location.search);
    const qCode = (qs.get("code") || "").toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(qCode)) return;
    bootRan.current = true;
    // Boot fetch saat dibuka via link — side effect on-mount yang sah.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    run(null, {
      code: qCode,
      start: qs.get("start") || isoDaysAgo(84),
      split: qs.get("split") || "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shortcut keyboard: "/" memfokuskan input ticker (selama tidak sedang mengetik).
  useEffect(() => {
    function onKey(e) {
      const tag = document.activeElement?.tagName;
      if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag || "")) {
        e.preventDefault();
        tickerRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // sinkronkan state ke URL → link bisa dibagikan / di-bookmark
  useEffect(() => {
    if (!data) return;
    const qs = new URLSearchParams();
    qs.set("code", data.code);
    qs.set("start", data.start);
    if (splitDate) qs.set("split", splitDate);
    if (selected.length) qs.set("brokers", selected.join(","));
    window.history.replaceState(null, "", `${window.location.pathname}?${qs.toString()}`);
  }, [data, splitDate, selected]);

  // ---- series yang sudah di-fetch (awal + refetch manual) ----
  const allSeries = useMemo(() => {
    if (!data) return [];
    const map = new Map();
    for (const s of data.accum.series || []) map.set(s.broker_code, s);
    for (const series of Object.values(extra)) {
      for (const s of series) map.set(s.broker_code, s);
    }
    return [...map.values()];
  }, [data, extra]);

  // ---- refetch broker terpilih yang belum ada di data ----
  const seriesByKey = useMemo(() => {
    const m = new Map(allSeries.map((s) => [s.broker_code, s]));
    return m;
  }, [allSeries]);

  const missingKey = useMemo(() => {
    if (!data) return "";
    const missing = selected.filter((c) => !seriesByKey.has(c));
    return missing.join(",");
  }, [selected, seriesByKey, data]);

  useEffect(() => {
    if (!data || !missingKey) return;
    let cancelled = false;
    (async () => {
      setFetchingBrokers(true);
      setBrokerError("");
      const key = `${data.code}|${data.start}|${data.end}|${missingKey}`;
      try {
        const json = await idxGet(`/api/broker-accumulation/${data.code}`, {
          start_date: data.start,
          end_date: data.end,
          brokers: missingKey,
        });
        const series = json.series || [];
        if (!cancelled) {
          setExtra((prev) => ({ ...prev, [key]: series }));
          const found = new Set(series.map((s) => s.broker_code));
          const notFound = missingKey.split(",").filter((c) => !found.has(c));
          if (notFound.length) {
            setBrokerError(
              `Broker ${notFound.join(", ")} tidak ada data di rentang ini (kode salah atau tidak transaksi pada rentang tsb).`
            );
          }
        }
      } catch (err) {
        if (!cancelled) setBrokerError(`Gagal ambil broker ${missingKey}: ${err.message}`);
      } finally {
        if (!cancelled) setFetchingBrokers(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, missingKey]);

  // ---- kandidat: top buyers/sellers + semua broker yang sudah ter-fetch ----
  const candidates = useMemo(() => {
    if (!data) return [];
    const map = new Map();
    for (const b of data.accum.top_buyers || []) map.set(b.broker_code, b);
    for (const b of data.accum.top_sellers || []) map.set(b.broker_code, b);
    for (const s of allSeries) if (!map.has(s.broker_code)) map.set(s.broker_code, { broker_code: s.broker_code, broker_name: s.broker_name, total_nval: null });
    return [...map.values()];
  }, [data, allSeries]);

  // ---- hasil analisa per broker terpilih ----
  const lastPrice = data?.price?.last_price ?? null;
  // harga yang DIPAKAI hitungan: hasil simulasi what-if bila aktif, selain itu harga aktual
  const activePrice = simPrice != null ? simPrice : lastPrice;
  // total nilai transaksi pada rentang (dari history) → normalisasi intensitas net broker
  const totalValue = useMemo(
    () => historyRows.reduce((s, r) => s + (r.value || 0), 0),
    [historyRows]
  );
  const results = useMemo(() => {
    if (!data) return [];
    return selected
      .map((code) => {
        const s = seriesByKey.get(code);
        if (!s) return null;
        const r = analyzeBroker(s, splitDate, activePrice);
        r.intensity = intensityPct(r.netVal, totalValue);
        return r;
      })
      .filter(Boolean);
  }, [selected, seriesByKey, splitDate, activePrice, totalValue, data]);

  // ---- urut tabel & ringkasan inventory (0 request, semua dari data yang sudah ada) ----
  const [sortKey, setSortKey] = useState(""); // "" = urutan asli
  const [sortDir, setSortDir] = useState(-1);
  const [faseFilter, setFaseFilter] = useState("all");
  const [realizedOnly, setRealizedOnly] = useState(false);
  const [candFilter, setCandFilter] = useState("");

  const faseCounts = useMemo(
    () => results.reduce((a, r) => ({ ...a, [r.fase.key]: (a[r.fase.key] || 0) + 1 }), {}),
    [results]
  );

  function toggleSort(key) {
    if (sortKey === key) setSortDir((d) => -d);
    else {
      setSortKey(key);
      setSortDir(-1);
    }
  }

  const tableResults = useMemo(() => {
    let base = faseFilter === "all" ? results : results.filter((r) => r.fase.key === faseFilter);
    if (realizedOnly) base = base.filter((r) => r.ledger.length > 0);
    if (!sortKey) return base;
    const val = (r) => (sortKey === "netVal2" ? r.phase.netVal2 : r[sortKey]);
    return [...base].sort((a, b) => {
      const x = val(a) ?? 0;
      const y = val(b) ?? 0;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * sortDir;
    });
  }, [results, sortKey, sortDir, faseFilter, realizedOnly]);

  // ---- 5 realisasi terakhir lintas broker terpilih (0 request) ----
  const recentSales = useMemo(() => {
    const all = [];
    for (const r of results) for (const l of r.ledger) all.push({ ...l, broker: r.code });
    return all.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);
  }, [results]);

  const totals = useMemo(() => {
    const t = results.reduce(
      (a, r) => {
        const live = r.shares > 0;
        a.shares += r.shares;
        a.invested += live ? r.shares * r.avgCost : 0;
        a.marketValue += live ? r.shares * (activePrice ?? 0) : 0;
        a.unrealized += live ? r.unrealized : 0;
        a.realized += r.realized || 0;
        a.netVal2 += r.phase.netVal2;
        a.netVol2 += r.phase.netVol2;
        a.peak += r.peak;
        return a;
      },
      {
        shares: 0,
        invested: 0,
        marketValue: 0,
        unrealized: 0,
        realized: 0,
        netVal2: 0,
        netVol2: 0,
        peak: 0,
      }
    );
    t.avgCost = t.shares > 0 ? t.invested / t.shares : null;
    t.pnl = t.unrealized + t.realized;
    return t;
  }, [results, activePrice]);

  // ---- preset batas fase (0 request): 10 hari bursa · akhir bulan lalu · di peak posisi ----
  const phasePresets = useMemo(() => {
    if (!data || !historyRows.length || !results.length) return [];
    const dates = historyRows.map((r) => r.date);
    const out = [{ label: "10 hari bursa", value: defaultSplitDate(historyRows, data.start) }];

    const firstOfMonth = `${(today || "").slice(0, 7)}-01`; // `today` selalu terisi saat data sudah ada
    const prev = dates.filter((d) => d < firstOfMonth).pop();
    if (prev) out.push({ label: "akhir bulan lalu", value: prev });

    const maps = results.map((r) => new Map(r.timeline.map((t) => [t.date, t.shares])));
    const state = maps.map(() => 0);
    let best = null;
    for (const d of dates) {
      let sum = 0;
      maps.forEach((m, i) => {
        if (m.has(d)) state[i] = m.get(d);
        sum += state[i];
      });
      if (!best || sum > best.sum) best = { date: d, sum };
    }
    if (best) out.push({ label: "di peak posisi", value: best.date });

    // buang duplikat nilai
    const seen = new Set();
    return out.filter((p) => p.value && !seen.has(p.value) && seen.add(p.value));
  }, [data, historyRows, results, today]);

  // ---- info harga + kesegaran ----
  const priceInfo = useMemo(() => {
    if (!data) return null;
    const p = data.price || {};
    // data_ts = jam trade HARI INI (null = belum ada trade); no_trade_today = freq/lot/value nol.
    const live = p.data_ts != null && p.no_trade_today === false;
    const label = p.market_label || p.market_state || "";
    return {
      last: p.last_price ?? null,
      sourceDate: p.source_date || null,
      dataTs: p.data_ts || null,
      marketState: p.market_state || "unknown",
      marketLabel: label,
      live,
      changePct: p.change_pct ?? null,
      note: live
        ? `Live — transaksi terakhir hari ini ${p.data_ts} · ${label}`
        : p.data_ts
          ? `Bukan live — pasar ${label.toLowerCase()}; trade terakhir hari ini ${p.data_ts}`
          : `Belum ada transaksi hari ini — pasar ${label.toLowerCase()}; harga dari penutupan terakhir${p.source_date ? ` (${p.source_date})` : ""}`,
    };
  }, [data]);

  // ---- konteks harga selama fase 2 ----
  const phase2Price = useMemo(() => {
    if (!data || !splitDate || historyRows.length < 2) return null;
    return priceChangeBetween(historyRows, splitDate, historyRows[historyRows.length - 1].date);
  }, [data, splitDate, historyRows]);

  const phase1Price = useMemo(() => {
    if (!data || !splitDate || historyRows.length < 2) return null;
    return priceChangeBetween(historyRows, data.start, splitDate);
  }, [data, splitDate, historyRows]);

  // ---- warning global ----
  const globalWarnings = useMemo(() => {
    const w = [];
    if (priceInfo && !priceInfo.live) w.push(priceInfo.note + ".");
    if (historyRows.length === 0) w.push("Riwayat harga kosong untuk rentang ini — chart & % harga tidak tersedia.");
    if (data && selected.length === 0) w.push("Belum ada broker dipilih — pilih dari daftar saran atau ketik kode broker.");
    if (data && !splitDate) w.push("Batas fase belum diisi — pilih tanggal pembagi Fase 1 / Fase 2.");
    if (data && splitDate && splitDate <= data.start) w.push("Batas fase di tanggal mulai pantau — seluruh rentang dihitung sebagai Fase 2 (tracking).");
    if (data && splitDate && historyRows.length && splitDate > historyRows[historyRows.length - 1].date) {
      w.push("Batas fase melewati akhir data — Fase 2 kosong (semua dihitung Fase 1). Geser tanggalnya kembali.");
    }
    const avail = data?.history?.data_available;
    if (data && avail?.start && avail.start > data.start) {
      w.push(
        `Data ${data.code} hanya tersedia sejak ${avail.start} — rentang yang Anda minta lebih panjang dari data nyata (angka sebelum tanggal itu tidak ada).`
      );
    }
    return w;
  }, [priceInfo, historyRows, data, selected, splitDate]);

  function toggleBroker(code) {
    const on = selected.includes(code);
    setSelected(on ? selected.filter((c) => c !== code) : [...selected, code]);
    showToast(`Broker ${code} ${on ? "dihapus" : "ditambahkan"}`);
    setBrokerError("");
  }

  function addManualBrokers(e) {
    e.preventDefault();
    const codes = brokerInput
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((c) => c.length >= 2 && c.length <= 4); // kode broker: 2–4 karakter (ZP, YU, HD, ...)
    if (!codes.length) {
      setBrokerError("Format kode broker salah — 2–4 karakter, dipisah koma, mis. ZP atau ZP,YU.");
      return;
    }
    const added = codes.filter((c) => !selected.includes(c));
    setSelected((prev) => [...new Set([...prev, ...codes])]);
    setBrokerInput("");
    setBrokerError("");
    if (added.length) showToast(`Broker ${added.join(", ")} ditambahkan`);
    else showToast("Broker sudah ada di daftar");
  }

  // ---- Alert perubahan fase sejak pemeriksaan terakhir (localStorage, tanpa backend) ----
  useEffect(() => {
    if (!data || !results.length) return;
    let store = {};
    try {
      store = JSON.parse(localStorage.getItem("srjum.stalker.snapshots") || "{}");
    } catch {
      store = {};
    }
    const changes = [];
    const next = { ...store };
    for (const r of results) {
      const k = `${data.code}|${r.code}`;
      const prev = store[k];
      if (prev && prev.fase !== r.fase) {
        changes.push({ broker: r.code, from: prev.fase, to: r.fase, when: prev.date });
      }
      next[k] = { fase: r.fase, date: today || data.end };
    }
    try {
      localStorage.setItem("srjum.stalker.snapshots", JSON.stringify(next));
    } catch {
      /* private mode / storage penuh */
    }
    // Sinkron dengan localStorage (sistem eksternal) — pola yang sah.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhaseChanges(changes);
  }, [data, results, today]);

  // ---- Usul batas fase otomatis (change-point dari net harian broker terpilih) ----
  function applyAutoSplit() {
    if (!data || historyRows.length < 12) {
      showToast("Data belum cukup untuk usul split (min. ±12 bar)");
      return;
    }
    const netByDate = {};
    for (const r of results) {
      for (const t of r.timeline) netByDate[t.date] = (netByDate[t.date] || 0) + t.nval;
    }
    const dates = historyRows.map((r) => r.date);
    const s = suggestSplitDate(dates, netByDate);
    if (!s) {
      showToast("Tidak ada perubahan arah net yang jelas — split manual saja");
      return;
    }
    setSplitDate(s);
    showToast(`Batas fase diusulkan pada ${s}`);
  }

  // ---- Data tambahan on-demand (masing-masing +1 request) ----
  async function loadInsiders() {
    if (!data) return;
    setLoadingExtra("insiders");
    try {
      const json = await idxGet(`/api/insiders/${data.code}`, { limit: 50 });
      const items = json.items || [];
      setInsiders(items);
      showToast(`${items.length} transaksi insider dimuat`);
    } catch (err) {
      showToast(`Insider gagal: ${err.message}`);
    } finally {
      setLoadingExtra("");
    }
  }

  // order flow satu hari; onlyBroker (dari ledger) menyaring lawan transaksinya
  async function loadFlow(date = lastDataDate, onlyBroker = "") {
    if (!data) return;
    setLoadingExtra("flow");
    try {
      const json = await idxGet("/api/done-details", {
        code: data.code,
        date,
        per_page: 100,
      });
      setFlowData({
        date: json.date || date,
        rows: json.data || [],
        broker: onlyBroker,
        total: json.total ?? null,
      });
      showToast(onlyBroker ? `Order flow ${date} · ${onlyBroker}` : "Order flow dimuat");
    } catch (err) {
      showToast(`Order flow gagal: ${err.message}`);
    } finally {
      setLoadingExtra("");
    }
  }

  async function loadMcap() {
    if (!data) return;
    setLoadingExtra("mcap");
    try {
      const json = await idxGet("/api/market-cap", { codes: data.code });
      const row = (json.data || [])[0];
      setMarketInfo(row || null);
      showToast(row ? `Saham beredar: ${formatShares(row.listed_shares)}` : "Data tidak ditemukan");
    } catch (err) {
      showToast(`Saham beredar gagal: ${err.message}`);
    } finally {
      setLoadingExtra("");
    }
  }

  // Analisa mesin: deskripsi teknikal + rekomendasi level (entry/target/SL) dari server.
  async function loadAnalysis() {
    if (!data) return;
    setLoadingExtra("analysis");
    const key = `an|${data.code}`;
    const cached = readCache(key);
    if (cached) {
      setAnalysis(cached);
      setLoadingExtra("");
      showToast("Analisa mesin dari cache · 0 request");
      return;
    }
    try {
      const json = await idxGet(`/api/analysis/${data.code}`);
      const text = json.output || json.analysis || JSON.stringify(json, null, 2);
      setAnalysis(text);
      writeCache(key, text, 12 * 60 * 60 * 1000); // snapshot harian → 12 jam
      showToast("Analisa mesin dimuat");
    } catch (err) {
      showToast(`Analisa mesin gagal: ${err.message}`);
    } finally {
      setLoadingExtra("");
    }
  }

  // Zona akumulasi: di HARGA berapa uang berpindah (pasangan buyer/seller per level).
  // Jangan kirim param net/flow/all_data — broker_levels hanya ada tanpa param itu.
  async function loadLevels() {
    if (!data) return;
    setLoadingExtra("levels");
    try {
      const json = await idxGet(`/api/broker-summary/${data.code}`, {
        start_date: data.start,
        end_date: data.end,
        level_limit: 50,
      });
      const levels = json.broker_levels || [];
      setLevelsData({
        levels,
        from: json.broker_start_date || json.broker_date_min || data.start,
        to: json.broker_end_date || json.broker_date_max || data.end,
      });
      showToast(`${levels.length} level harga dimuat`);
    } catch (err) {
      showToast(`Zona akumulasi gagal: ${err.message}`);
    } finally {
      setLoadingExtra("");
    }
  }

  // ---- Export CSV hasil tabel (lokal, tanpa request) ----
  function exportCsv() {
    const csv = resultsToCsv(results, {
      code: data?.code,
      start: data?.start,
      end: data?.end,
      split: splitDate,
      price: activePrice,
    });
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }); // BOM → Excel ID aman
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `broker-${data?.code || "hasil"}-${data?.end || ""}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("CSV diunduh");
  }

  // ---- Export CSV ledger realisasi (baris per hari jual) ----
  function exportLedgerCsv() {
    const csv = ledgerToCsv(results, { code: data?.code, start: data?.start, end: data?.end });
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ledger-${data?.code || "hasil"}-${data?.end || ""}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("CSV ledger diunduh");
  }

  const lastDataDate = data
    ? historyRows.length
      ? historyRows[historyRows.length - 1].date
      : data.end
    : today || "";

  // batas slider simulasi what-if (±30% dari harga aktual)
  const simMin = lastPrice ? Math.max(1, Math.round(lastPrice * 0.7)) : 0;
  const simMax = lastPrice ? Math.max(1, Math.round(lastPrice * 1.3)) : 1;
  const simStep = lastPrice ? Math.max(1, Math.round(lastPrice * 0.01)) : 1;

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <h1 className={styles.title}>🔍 Broker Stalker</h1>
        <p className={styles.subtitle}>
          Lacak sisa barang broker per emiten — posisi vs harga terkini, realized/unrealized,
          dan apakah masih kumpul, trimming, atau distribusi.
        </p>
      </header>

      {/* ---- FORM ---- */}
      <form className={styles.form} onSubmit={(e) => run(e, { force: true })}>
        <label className={styles.field}>
          <span>Ticker</span>
          <input
            ref={tickerRef}
            className={styles.inputCode}
            value={ticker}
            onChange={(e) => {
              setTicker(e.target.value.toUpperCase());
              setFieldError("");
            }}
            placeholder="BBCA"
            maxLength={4}
            autoComplete="off"
            aria-label="Kode saham, 4 karakter"
          />
        </label>
        <label className={styles.field}>
          <span>Mulai pantau</span>
          <input
            type="date"
            className={styles.inputDate}
            value={startDate}
            max={today || undefined}
            onChange={(e) => {
              setStartDate(e.target.value);
              setFieldError("");
            }}
          />
        </label>
        <div className={styles.presets} role="group" aria-label="Preset rentang waktu">
          {[["1m", 30], ["3m", 90], ["6m", 180], ["1y", 365]].map(([label, days]) => (
            <button
              key={label}
              type="button"
              className={styles.presetBtn}
              onClick={() => applyPreset(days)}
            >
              {label}
            </button>
          ))}
        </div>
        <button className={styles.primaryBtn} type="submit" disabled={loading}>
          {loading ? "Memuat…" : data ? "🌐 Ambil data baru" : "Analisa (data baru)"}
        </button>
        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={loadFromCache}
          disabled={loading || !cacheHitNow}
          title={
            cacheHitNow
              ? `Data tersimpan di cache pukul ${cacheTimeLabel(cacheHitNow.savedAt)} — 0 request`
              : "Belum ada cache untuk ticker + rentang tanggal ini"
          }
        >
          {cacheHitNow ? "📦 Muat dari cache (0 request)" : "📦 Cache kosong"}
        </button>
        {data && (
          <span className={styles.hint}>
            {cacheInfo?.fromCache ? "📦 data dari cache" : "🌐 data baru diambil"}
            {cacheInfo?.at ? ` pukul ${cacheTimeLabel(cacheInfo.at)}` : ""} · {data.code} ·{" "}
            {data.start} → {data.end} · geser tanggal fase di bawah tanpa fetch ulang
          </span>
        )}
        {fieldError && (
          <span className={styles.fieldError} role="alert">
            {fieldError}
          </span>
        )}
      </form>

      {error && <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>}

      {/* ---- SKELETON LOADING (anti layout shift) ---- */}
      {loading && !data && (
        <>
          <div className={styles.skelGrid}>
            <div className={styles.skeleton}>
              <div className={styles.skelBar} style={{ width: "40%" }} />
              <div className={styles.skelBar} style={{ width: "65%", height: 28 }} />
              <div className={styles.skelBar} style={{ width: "80%" }} />
            </div>
            <div className={styles.skeleton}>
              <div className={styles.skelBar} style={{ width: "50%" }} />
              <div className={styles.skelBar} style={{ width: "90%" }} />
              <div className={styles.skelBar} style={{ width: "70%" }} />
            </div>
          </div>
          <div className={styles.skeleton}>
            {[...Array(6)].map((_, i) => (
              <div key={i} className={styles.skelBar} style={{ width: `${95 - i * 6}%` }} />
            ))}
          </div>
        </>
      )}

      {/* ---- EMPTY STATE: cara pakai + contoh ---- */}
      {!data && !loading && (
        <section className={styles.hero}>
          <div className={styles.heroTitle}>Mulai dalam 3 langkah</div>
          <div className={styles.heroSteps}>
            <div className={styles.heroStep}>
              <b>1.</b> Masukkan ticker &amp; rentang tanggal, tekan <b>Analisa</b> (≈3 request data).
            </div>
            <div className={styles.heroStep}>
              <b>2.</b> Pilih broker yang mau distalk dari saran top buyers/sellers — atau ketik
              kode broker sendiri.
            </div>
            <div className={styles.heroStep}>
              <b>3.</b> Geser <b>batas fase</b> untuk membagi periode Bangun Posisi vs Tracking;
              baca sisa barang, realized &amp; unrealized di tabel.
            </div>
          </div>
          <div className={styles.exampleRow}>
            Contoh:
            {["BBCA", "CUAN", "DSSA"].map((c) => (
              <button
                key={c}
                type="button"
                className={styles.chip}
                onClick={() => {
                  setTicker(c);
                  run(null, { code: c, start: startDate || isoDaysAgo(84) });
                }}
              >
                <b>{c}</b>
              </button>
            ))}
            <span>(klik untuk langsung analisa · tekan &ldquo;/&rdquo; untuk fokus input)</span>
          </div>
        </section>
      )}

      {/* ---- KARTU HARGA + KENDALI FASE ---- */}
      {data && (
        <section className={styles.grid2}>
          <div className={styles.card}>
            <div className={styles.cardTitle}>
              {data.code}{" "}
              <span
                className={`${styles.badge} ${
                  priceInfo?.live ? styles.badgeLive : styles.badgeClosed
                }`}
              >
                {priceInfo?.marketLabel || "—"}
              </span>
            </div>
            <div className={styles.priceRow}>
              <span className={styles.price}>{formatPrice(priceInfo?.last)}</span>
              {priceInfo?.changePct != null && (
                <span className={priceInfo.changePct >= 0 ? styles.up : styles.down}>
                  {formatPct(priceInfo.changePct, 2)}
                </span>
              )}
            </div>
            <div className={styles.freshness}>{priceInfo?.note}</div>
            <div className={styles.freshness}>
              Data harga: {priceInfo?.sourceDate || "–"} · broker &amp; harga historis: {data.start} → {lastDataDate}
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>⚙️ Kendali rentang</div>
            <label className={styles.field}>
              <span>Batas fase (Fase 1 akumulasi | Fase 2 tracking)</span>
              <input
                type="date"
                className={styles.inputDateWide}
                value={splitDate}
                min={data.start}
                max={lastDataDate}
                onChange={(e) => setSplitDate(e.target.value)}
              />
            </label>
            <div className={styles.phaseInfo}>
              <span>Fase 1: {data.start} → {splitDate || "—"}</span>
              <span>Fase 2: {splitDate || "—"} → {lastDataDate}</span>
            </div>
            {phase1Price && (
              <div className={styles.phaseInfo}>
                <span>Harga Fase 1: <b className={phase1Price.pct >= 0 ? styles.up : styles.down}>{formatPct(phase1Price.pct)}</b></span>
                <span>Harga Fase 2: <b className={phase2Price?.pct >= 0 ? styles.up : styles.down}>{phase2Price ? formatPct(phase2Price.pct) : "–"}</b></span>
              </div>
            )}
            <div className={styles.phaseInfo}>
              <button type="button" className={styles.secondaryBtn} onClick={applyAutoSplit}>
                ✨ Usul split otomatis
              </button>
              <span className={styles.hint}>deteksi perubahan arah net — tanpa fetch</span>
            </div>
            {phasePresets.length > 0 && (
              <div className={styles.phaseInfo}>
                <span className={styles.hint}>Preset batas:</span>
                {phasePresets.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={styles.chip}
                    onClick={() => setSplitDate(p.value)}
                    title={`Batas fase → ${p.value}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ---- DATA TAMBAHAN (on-demand, masing-masing +1 request) ---- */}
      {data && (
        <section className={styles.extraRow} aria-label="Data tambahan opsional">
          <span className={styles.hint}>Data tambahan (opsional · +1 request):</span>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={loadInsiders}
            disabled={!!loadingExtra || !!insiders}
          >
            {loadingExtra === "insiders"
              ? "Memuat…"
              : insiders
                ? `✅ Insider (${insiders.length})`
                : "🧑‍💼 Insider"}
          </button>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => loadFlow()}
            disabled={!!loadingExtra || !!flowData}
          >
            {loadingExtra === "flow" ? "Memuat…" : flowData ? "✅ Order flow" : "📜 Order flow"}
          </button>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={loadMcap}
            disabled={!!loadingExtra || !!marketInfo}
          >
            {loadingExtra === "mcap"
              ? "Memuat…"
              : marketInfo
                ? "✅ % beredar"
                : "📦 % saham beredar"}
          </button>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={loadLevels}
            disabled={!!loadingExtra || !!levelsData}
          >
            {loadingExtra === "levels"
              ? "Memuat…"
              : levelsData
                ? `✅ Zona akumulasi (${levelsData.levels.length})`
                : "🧩 Zona akumulasi"}
          </button>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={loadAnalysis}
            disabled={!!loadingExtra || !!analysis}
          >
            {loadingExtra === "analysis"
              ? "Memuat…"
              : analysis
                ? "✅ Analisa mesin"
                : "🧠 Analisa mesin"}
          </button>
        </section>
      )}

      {/* ---- WARNING ---- */}
      {globalWarnings.map((w) => (
        <div key={w} className={`${styles.banner} ${styles.bannerWarn}`}>
          ⚠️ {w}
        </div>
      ))}

      {/* ---- ALERT: fase berubah sejak pemeriksaan terakhir ---- */}
      {phaseChanges.length > 0 && (
        <div className={`${styles.banner} ${styles.bannerInfo}`} role="status">
          🔄 Fase berubah sejak pemeriksaan terakhir:{" "}
          {phaseChanges
            .map((c) => `${c.broker} (${c.from} → ${c.to}${c.when ? `, sejak ${c.when}` : ""})`)
            .join(" · ")}
          <button
            type="button"
            className={styles.chipX}
            style={{ float: "right" }}
            onClick={() => setPhaseChanges([])}
            aria-label="Tutup notifikasi perubahan fase"
          >
            ✕
          </button>
        </div>
      )}
      {brokerError && <div className={`${styles.banner} ${styles.bannerError}`}>{brokerError}</div>}

      {/* ---- PEMILIHAN BROKER ---- */}
      {data && (
        <section className={styles.card}>
          <div className={styles.cardTitle}>
            🎯 Pilih broker yang mau distalk {fetchingBrokers && <small>(mengambil data…)</small>}
          </div>
          {fetchingBrokers && (
            <div className={styles.skelBar} style={{ width: "45%", marginBottom: 10 }} />
          )}
          {candidates.length > 6 && (
            <input
              className={styles.inputManual}
              value={candFilter}
              onChange={(e) => setCandFilter(e.target.value.toUpperCase())}
              placeholder="Cari kode / nama broker…"
              autoComplete="off"
              aria-label="Cari kandidat broker"
              style={{ marginBottom: 10 }}
            />
          )}
          <div className={styles.chips}>
            {candidates
              .filter(
                (c) =>
                  !candFilter ||
                  c.broker_code.includes(candFilter) ||
                  String(c.broker_name || "").toUpperCase().includes(candFilter)
              )
              .map((c) => {
              const on = selected.includes(c.broker_code);
              return (
                <button
                  key={c.broker_code}
                  type="button"
                  className={`${styles.chip} ${on ? styles.chipOn : ""}`}
                  onClick={() => toggleBroker(c.broker_code)}
                  title={c.broker_name || c.broker_code}
                  aria-pressed={on}
                >
                  <b>{c.broker_code}</b>
                  {c.total_nval != null && (
                    <i className={c.total_nval >= 0 ? styles.up : styles.down}>
                      {" "}{formatRp(c.total_nval, true)}
                    </i>
                  )}
                </button>
              );
            })}
          </div>
          <form className={styles.manualRow} onSubmit={addManualBrokers}>
            <input
              className={styles.inputManual}
              value={brokerInput}
              onChange={(e) => setBrokerInput(e.target.value.toUpperCase())}
              placeholder="Kode broker manual, mis. ZP,YU (Enter untuk tambah)"
              autoComplete="off"
              aria-label="Tambah kode broker manual, dipisah koma"
            />
            <button className={styles.secondaryBtn} type="submit">+ Tambah</button>
          </form>
          {selected.length > 0 && (
            <div className={styles.selectedRow}>
              Distalk:{" "}
              {selected.map((c) => (
                <span key={c} className={`${styles.chip} ${styles.chipOn}`}>
                  {c}
                  <button
                    type="button"
                    className={styles.chipX}
                    onClick={() => toggleBroker(c)}
                    aria-label={`Hapus broker ${c} dari pantauan`}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ---- KUNCI PEMBACAAN ---- */}
      {results.length > 0 && (
        <section className={styles.card}>
          <div className={styles.cardTitle}>📖 Kunci pembacaan</div>
          <ul className={styles.narrative}>
            {phase2Price && (
              <li>
                Harga {phase2Price.pct >= 0 ? "naik" : "turun"} {formatPct(Math.abs(phase2Price.pct), 1, false)}% selama
                fase tracking ({phase2Price.from} → {phase2Price.to}) — konteks untuk membaca aksi broker di bawah.
              </li>
            )}
            {results.map((r) => (
              <li key={r.code}>
                <b>{r.code}</b> ({r.name}){" "}
                <span style={{ color: r.fase.color }}>
                  {r.fase.emoji} {r.fase.label}
                </span>
                {" — sisa "}
                <b>{formatShares(r.shares)}</b>
                {r.shares > 0 && r.avgCost > 0 && (
                  <>
                    , avg cost {formatPrice(r.avgCost)}
                    {r.unrealPct != null && (
                      <>
                        {" → unrealized "}
                        <b className={r.unrealized >= 0 ? styles.up : styles.down}>
                          {formatRp(r.unrealized, true)} ({formatPct(r.unrealPct)})
                        </b>
                      </>
                    )}
                  </>
                )}
                {r.realized !== 0 && (
                  <>
                    {", realized "}
                    <b className={r.realized >= 0 ? styles.up : styles.down}>
                      {formatRp(r.realized, true)}
                    </b>
                  </>
                )}
                {" · net fase 2: "}
                <b className={r.phase.netVal2 >= 0 ? styles.up : styles.down}>
                  {formatRp(r.phase.netVal2, true)}
                </b>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---- KOMPOSISI PROFIT & KUALITAS DATA ---- */}
      {results.length > 0 && (
        <section className={styles.card}>
          <div className={styles.cardTitle}>
            💰 Komposisi profit &amp; kualitas data
            <small> realized = sudah dinikmati · unrealized = mengambang · BEP = avg cost</small>
          </div>
          <div className={styles.breakList}>
            {results.map((r) => {
              const realized = r.realized || 0;
              const unreal = r.shares > 0 ? r.unrealized : 0;
              const total = Math.abs(realized) + Math.abs(unreal) || 1;
              const wR = (Math.abs(realized) / total) * 100;
              const wU = (Math.abs(unreal) / total) * 100;
              const totalPnl = realized + unreal;
              return (
                <div key={r.code} className={styles.breakRow}>
                  <div className={styles.breakHead}>
                    <b>{r.code}</b>
                    <span className={totalPnl >= 0 ? styles.up : styles.down}>
                      Total {formatRp(totalPnl, true)}
                    </span>
                    <span className={styles.sub}>
                      BEP {r.avgCost > 0 ? formatPrice(r.avgCost) : "–"} · yakin {r.confidence}%
                      {r.intensity != null &&
                        ` · net ${formatPct(r.intensity, 2)} dari total nilai transaksi`}
                    </span>
                  </div>
                  <div
                    className={styles.stackBar}
                    role="img"
                    aria-label={`Komposisi ${r.code}: realized ${formatRp(realized, true)}, unrealized ${formatRp(unreal, true)}`}
                  >
                    <div
                      className={styles.stackReal}
                      style={{ width: `${wR}%` }}
                      title={`Realized ${formatRp(realized, true)} (${wR.toFixed(0)}%)`}
                    />
                    <div
                      className={styles.stackUnreal}
                      style={{ width: `${wU}%` }}
                      title={`Unrealized ${formatRp(unreal, true)} (${wU.toFixed(0)}%)`}
                    />
                  </div>
                  <div className={styles.breakLegend}>
                    <span className={styles.dotReal} /> realized {formatRp(realized, true)} (
                    {wR.toFixed(0)}%)
                    <span className={styles.dotUnreal} /> unrealized {formatRp(unreal, true)} (
                    {wU.toFixed(0)}%)
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ---- LEDGER REALISASI: realisasi kapan saja ---- */}
      {results.some((r) => r.ledger.length > 0) && (
        <section className={styles.card}>
          <div className={styles.cardTitle}>
            🧾 Ledger realisasi — jualan tanggal berapa, harga vs modal saat itu
            <small> · klik broker untuk rincian · komisi/pajak belum dihitung</small>
            <button
              type="button"
              className={styles.secondaryBtn}
              style={{ float: "right" }}
              onClick={exportLedgerCsv}
            >
              ⬇ Export ledger
            </button>
          </div>
          {recentSales.length > 0 && (
            <div className={styles.chips}>
              <span className={styles.hint}>Jual terakhir:</span>
              {recentSales.map((s) => (
                <span
                  key={`${s.broker}-${s.date}`}
                  className={styles.chip}
                  style={{ cursor: "default" }}
                  title={`${s.broker} ${formatShares(s.qty)} @ ${formatPrice(s.price)} · avg cost ${formatPrice(s.cost)}`}
                >
                  {s.date} · <b>{s.broker}</b> {formatShares(s.qty)} @ {formatPrice(s.price)}
                  <i className={s.realizedDay >= 0 ? styles.up : styles.down}>
                    {" "}
                    {formatRp(s.realizedDay, true)}
                  </i>
                </span>
              ))}
            </div>
          )}
          {results
            .filter((r) => r.ledger.length > 0)
            .map((r) => (
              <details key={r.code} className={styles.ledger}>
                <summary>
                  <b>{r.code}</b>
                  <span className={styles.sub}>
                    {r.sellDays} hari jual · {formatShares(r.soldTotal)} terjual
                    {r.avgSellPrice != null && ` · rata-rata jual ${formatPrice(Math.round(r.avgSellPrice))}`}
                  </span>
                  <b className={r.realized >= 0 ? styles.up : styles.down}>
                    realized {formatRp(r.realized, true)}
                  </b>
                  <span className={styles.sub}>
                    Fase 1 {formatRp(r.realizedF1, true)} · Fase 2 {formatRp(r.realizedF2, true)}
                  </span>
                </summary>
                <div className={styles.tableScroll}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">Tanggal</th>
                        <th scope="col" className={styles.num}>Terjual</th>
                        <th scope="col" className={styles.num}>Harga jual</th>
                        <th scope="col" className={styles.num}>Avg cost</th>
                        <th scope="col" className={styles.num}>Realized hari itu</th>
                        <th scope="col" className={styles.num}>Kumulatif</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.ledger.map((l) => (
                        <tr key={l.date}>
                          <td>
                            {l.date}
                            <button
                              type="button"
                              className={styles.sortBtn}
                              onClick={() => loadFlow(l.date, r.code)}
                              title={`Lihat order flow ${l.date} (transaksi ${r.code} saja)`}
                              aria-label={`Lihat order flow ${l.date} untuk broker ${r.code}`}
                            >
                              📜
                            </button>
                            {l.rough && <div className={styles.sub}>estimasi kasar</div>}
                          </td>
                          <td className={styles.num}>
                            {formatShares(l.qty)}
                            {l.outsideQty > 0 && (
                              <div className={styles.sub}>
                                +{formatShares(l.outsideQty)} di luar rentang
                              </div>
                            )}
                          </td>
                          <td className={styles.num}>{formatPrice(l.price)}</td>
                          <td className={styles.num}>{formatPrice(l.cost)}</td>
                          <td className={`${styles.num} ${l.realizedDay >= 0 ? styles.up : styles.down}`}>
                            {formatRp(l.realizedDay, true)}
                          </td>
                          <td className={`${styles.num} ${l.realizedCum >= 0 ? styles.up : styles.down}`}>
                            {formatRp(l.realizedCum, true)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
        </section>
      )}

      {/* ---- TABEL ---- */}
      {results.length > 0 && (
        <section className={styles.card}>
          <div className={styles.cardTitle}>
            📋 Posisi per broker
            {simPrice != null && (
              <span className={`${styles.badge} ${styles.badgeLive}`}>
                simulasi @ {formatPrice(simPrice)}
              </span>
            )}
            <button
              type="button"
              className={styles.secondaryBtn}
              style={{ float: "right" }}
              onClick={exportCsv}
            >
              ⬇ Export CSV
            </button>
          </div>
          <div className={styles.simRow}>
            <label htmlFor="simPrice" className={styles.hint}>
              🧪 Simulasi harga
            </label>
            <input
              id="simPrice"
              type="range"
              min={simMin}
              max={simMax}
              step={simStep}
              value={simPrice != null ? simPrice : lastPrice || simMin}
              disabled={!lastPrice}
              onChange={(e) => setSimPrice(Number(e.target.value))}
              aria-label="Harga simulasi untuk hitung ulang unrealized"
            />
            <b className={styles.num}>{formatPrice(simPrice != null ? simPrice : lastPrice)}</b>
            <button
              type="button"
              className={styles.chipX}
              onClick={() => setSimPrice(null)}
              disabled={simPrice == null}
              aria-label="Kembali ke harga aktual"
            >
              reset
            </button>
          </div>
          <div className={styles.chips}>
            {[
              ["all", "Semua"],
              ["accumulate", "🟢 Kumpul"],
              ["trimming", "🟡 Trimming"],
              ["distribusi", "🔴 Distribusi"],
              ["flat", "⚪ Flat"],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`${styles.chip} ${faseFilter === key ? styles.chipOn : ""}`}
                aria-pressed={faseFilter === key}
                onClick={() => setFaseFilter(key)}
              >
                {label}
                {key !== "all" && ` (${faseCounts[key] || 0})`}
              </button>
            ))}
            <button
              type="button"
              className={`${styles.chip} ${realizedOnly ? styles.chipOn : ""}`}
              aria-pressed={realizedOnly}
              onClick={() => setRealizedOnly((v) => !v)}
            >
              💵 ada realisasi ({results.filter((r) => r.ledger.length > 0).length})
            </button>
            {(faseFilter !== "all" || realizedOnly) && (
              <span className={styles.hint}>
                menampilkan {tableResults.length} dari {results.length} broker
              </span>
            )}
          </div>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Broker</th>
                  <th scope="col" className={styles.num}>
                    Sisa barang
                    <span
                      className={styles.term}
                      tabIndex={0}
                      role="img"
                      aria-label="Perkiraan lembar yang masih dipegang broker sejak tanggal mulai pantau, hasil average-cost matching atas net harian"
                      title="Perkiraan lembar yang masih dipegang broker sejak tanggal mulai pantau (average-cost matching atas net harian)."
                    >
                      ?
                    </span>
                    <button
                      type="button"
                      className={styles.sortBtn}
                      onClick={() => toggleSort("shares")}
                      aria-label="Urutkan berdasarkan sisa barang"
                    >
                      {sortKey === "shares" ? (sortDir < 0 ? "▼" : "▲") : "↕"}
                    </button>
                  </th>
                  <th scope="col" className={styles.num}>
                    Avg cost
                    <span
                      className={styles.term}
                      tabIndex={0}
                      role="img"
                      aria-label="Harga rata-rata beli broker, metode average cost, dasar hitung unrealized"
                      title="Harga rata-rata beli broker (average cost) — dasar hitung unrealized."
                    >
                      ?
                    </span>
                    <button
                      type="button"
                      className={styles.sortBtn}
                      onClick={() => toggleSort("avgCost")}
                      aria-label="Urutkan berdasarkan avg cost"
                    >
                      {sortKey === "avgCost" ? (sortDir < 0 ? "▼" : "▲") : "↕"}
                    </button>
                  </th>
                  <th scope="col" className={styles.num}>Harga</th>
                  <th scope="col" className={styles.num}>
                    Unrealized
                    <span
                      className={styles.term}
                      tabIndex={0}
                      role="img"
                      aria-label="Selisih harga terkini dikali sisa barang, nilai mengambang yang belum diambil"
                      title="(Harga terkini − avg cost) × sisa barang — nilai mengambang, belum diambil."
                    >
                      ?
                    </span>
                    <button
                      type="button"
                      className={styles.sortBtn}
                      onClick={() => toggleSort("unrealized")}
                      aria-label="Urutkan berdasarkan unrealized"
                    >
                      {sortKey === "unrealized" ? (sortDir < 0 ? "▼" : "▲") : "↕"}
                    </button>
                  </th>
                  <th scope="col" className={styles.num}>
                    Realized
                    <span
                      className={styles.term}
                      tabIndex={0}
                      role="img"
                      aria-label="Selisih yang sudah terealisasi dari penjualan dalam rentang, estimasi"
                      title="Selisih yang sudah terealisasi dari penjualan dalam rentang (estimasi: harga jual vs avg cost)."
                    >
                      ?
                    </span>
                    <button
                      type="button"
                      className={styles.sortBtn}
                      onClick={() => toggleSort("realized")}
                      aria-label="Urutkan berdasarkan realized"
                    >
                      {sortKey === "realized" ? (sortDir < 0 ? "▼" : "▲") : "↕"}
                    </button>
                  </th>
                  <th scope="col" className={styles.num}>
                    Net fase 2
                    <span
                      className={styles.term}
                      tabIndex={0}
                      role="img"
                      aria-label="Net value rupiah selama fase tracking, positif berarti net beli"
                      title="Net value (rupiah) selama fase tracking — positif = net beli."
                    >
                      ?
                    </span>
                    <button
                      type="button"
                      className={styles.sortBtn}
                      onClick={() => toggleSort("netVal2")}
                      aria-label="Urutkan berdasarkan net fase 2"
                    >
                      {sortKey === "netVal2" ? (sortDir < 0 ? "▼" : "▲") : "↕"}
                    </button>
                  </th>
                  <th scope="col">Fase</th>
                  <th scope="col" style={{ minWidth: 120 }}>
                    Peak → sekarang
                    <span
                      className={styles.term}
                      tabIndex={0}
                      role="img"
                      aria-label="Posisi tertinggi dalam rentang dibanding posisi sekarang"
                      title="Posisi tertinggi dalam rentang vs posisi sekarang (bar)."
                    >
                      ?
                    </span>
                    <button
                      type="button"
                      className={styles.sortBtn}
                      onClick={() => toggleSort("peak")}
                      aria-label="Urutkan berdasarkan peak"
                    >
                      {sortKey === "peak" ? (sortDir < 0 ? "▼" : "▲") : "↕"}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tableResults.map((r) => {
                  const remainPct = r.peak > 0 ? Math.min(100, (r.shares / r.peak) * 100) : 0;
                  return (
                    <tr key={r.code}>
                      <td>
                        <b>{r.code}</b>
                        <div className={styles.sub}>{r.name}</div>
                        <div className={styles.sub}>
                          {formatNumber(r.totalDays)} hari aktif
                          {r.invested > 0 && ` · beli ${formatRp(r.invested)}`}
                          {r.roughDays > 0 && ` · ${r.roughDays} hari kasar`}
                        </div>
                        {r.warnings.map((w) => (
                          <div key={w} className={styles.warnCell}>⚠️ {w}</div>
                        ))}
                      </td>
                      <td className={styles.num}>
                        {formatShares(r.shares)}
                        <div className={styles.sub}>{formatLot(r.shares)}</div>
                        {results.length > 1 && totals.shares > 0 && (
                          <div className={styles.sub}>
                            {((r.shares / totals.shares) * 100).toFixed(1)}% dari total lembar
                          </div>
                        )}
                        {marketInfo?.listed_shares > 0 && (
                          <div className={styles.sub}>
                            {((r.shares / marketInfo.listed_shares) * 100).toFixed(3)}% beredar
                          </div>
                        )}
                      </td>
                      <td className={styles.num}>{r.shares > 0 ? formatPrice(r.avgCost) : "–"}</td>
                      <td className={styles.num}>
                        {formatPrice(r.lastPrice)}
                        {simPrice != null && (
                          <div className={styles.sub}>aktual {formatPrice(lastPrice)}</div>
                        )}
                      </td>
                      <td className={`${styles.num} ${r.unrealized >= 0 ? styles.up : styles.down}`}>
                        {r.shares > 0 ? formatRp(r.unrealized, true) : "–"}
                        <div className={styles.sub}>{r.unrealPct != null ? formatPct(r.unrealPct) : ""}</div>
                      </td>
                      <td className={`${styles.num} ${r.realized >= 0 ? styles.up : styles.down}`}>
                        {r.realized ? formatRp(r.realized, true) : "–"}
                      </td>
                      <td className={`${styles.num} ${r.phase.netVal2 >= 0 ? styles.up : styles.down}`}>
                        {formatRp(r.phase.netVal2, true)}
                        <div className={styles.sub}>{formatShares(r.phase.netVol2)}</div>
                      </td>
                      <td>
                        <span className={styles.faseBadge} style={{ color: r.fase.color, borderColor: r.fase.color }}>
                          {r.fase.emoji} {r.fase.label}
                        </span>
                        {r.soldTotal > 0 && (
                          <div className={styles.sub}>
                            jual {r.soldPctPeak != null ? `${r.soldPctPeak.toFixed(0)}% peak` : formatShares(r.soldTotal)}
                            {r.returnOnInvested != null &&
                              ` · profit realisasi ${formatPct(r.returnOnInvested)} dari modal beli`}
                          </div>
                        )}
                      </td>
                      <td>
                        <div
                          className={styles.barTrack}
                          title={`Sisa ${formatShares(r.shares)} dari peak ${formatShares(r.peak)} (${remainPct.toFixed(0)}%)`}
                        >
                          <div className={styles.barFill} style={{ width: `${remainPct}%` }} />
                        </div>
                        <div className={styles.sub}>
                          {remainPct.toFixed(0)}% dari peak {formatShares(r.peak)}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td>
                    <b>Total</b>
                    <div className={styles.sub}>
                      {results.length} broker · modal {formatRp(totals.invested)}
                    </div>
                  </td>
                  <td className={styles.num}>
                    {formatShares(totals.shares)}
                    <div className={styles.sub}>{formatLot(totals.shares)}</div>
                  </td>
                  <td className={styles.num}>
                    {totals.avgCost != null ? formatPrice(totals.avgCost) : "–"}
                    <div className={styles.sub}>tertimbang</div>
                  </td>
                  <td className={styles.num}>{formatPrice(activePrice)}</td>
                  <td className={`${styles.num} ${totals.unrealized >= 0 ? styles.up : styles.down}`}>
                    {formatRp(totals.unrealized, true)}
                  </td>
                  <td className={`${styles.num} ${totals.realized >= 0 ? styles.up : styles.down}`}>
                    {formatRp(totals.realized, true)}
                  </td>
                  <td className={`${styles.num} ${totals.netVal2 >= 0 ? styles.up : styles.down}`}>
                    {formatRp(totals.netVal2, true)}
                    <div className={styles.sub}>{formatShares(totals.netVol2)}</div>
                  </td>
                  <td>
                    <div className={styles.sub}>
                      P&amp;L total{" "}
                      <b className={totals.pnl >= 0 ? styles.up : styles.down}>
                        {formatRp(totals.pnl, true)}
                      </b>
                    </div>
                  </td>
                  <td>
                    <div className={styles.sub}>peak {formatShares(totals.peak)}</div>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}

      {/* ---- ORDER FLOW (on-demand) ---- */}
      {flowData && (
        <section className={styles.card}>
          <div className={styles.cardTitle}>
            📜 Order flow {flowData.date}
            {flowData.broker ? ` — hanya transaksi ${flowData.broker}` : " — 100 transaksi terakhir"}
            <small>
              {" · "}
              {flowData.broker
                ? "verifikasi ledger realisasi"
                : "broker terpilih disorot (hijau = beli, merah = jual)"}
              {flowData.total ? ` · total hari itu ${formatNumber(flowData.total)} transaksi` : ""}
            </small>
          </div>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Jam</th>
                  <th scope="col" className={styles.num}>Harga</th>
                  <th scope="col" className={styles.num}>Lot</th>
                  <th scope="col" className={styles.num}>Nilai</th>
                  <th scope="col">Buyer</th>
                  <th scope="col">Seller</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const rows = flowData.broker
                    ? flowData.rows.filter(
                        (r) => r.buyer === flowData.broker || r.seller === flowData.broker
                      )
                    : flowData.rows;
                  if (!rows.length) {
                    return (
                      <tr>
                        <td colSpan={6} className={styles.sub}>
                          Tidak ada transaksi {flowData.broker || ""} pada {formatNumber(flowData.rows.length)}{" "}
                          baris terakhir hari itu — coba klik hari lain di ledger.
                        </td>
                      </tr>
                    );
                  }
                  return rows.map((r, i) => {
                    const hiBuy = selected.includes(r.buyer);
                    const hiSell = selected.includes(r.seller);
                    return (
                      <tr key={`${r.time}-${i}`} className={hiBuy || hiSell ? styles.rowHi : undefined}>
                        <td>{r.time}</td>
                        <td className={styles.num}>{formatPrice(r.price_num)}</td>
                        <td className={styles.num}>
                          {r.qty_num > 0 ? formatNumber(Math.round(r.qty_num / 100)) : r.lot || "0"}
                        </td>
                        <td className={styles.num}>{formatRp(r.value_raw, true)}</td>
                        <td className={hiBuy ? styles.up : undefined}>
                          {r.buyer}
                          {r.buyer_type === "F" ? " (F)" : ""}
                        </td>
                        <td className={hiSell ? styles.down : undefined}>
                          {r.seller}
                          {r.seller_type === "F" ? " (F)" : ""}
                        </td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ---- ANALISA MESIN (on-demand, teks dari server) ---- */}
      {analysis && (
        <section className={styles.card}>
          <div className={styles.cardTitle}>
            🧠 Analisa mesin — teks dari server IDX Edge
            <small> · output model, bukan rekomendasi · ditampilkan apa adanya</small>
            <button
              type="button"
              className={styles.chipX}
              style={{ float: "right" }}
              onClick={() => setAnalysis(null)}
              aria-label="Tutup analisa mesin"
            >
              ✕
            </button>
          </div>
          <pre className={styles.analysis}>{analysis}</pre>
        </section>
      )}

      {/* ---- ZONA AKUMULASI (on-demand) ---- */}
      {levelsData && levelsData.levels.length > 0 && (
        <section className={styles.card}>
          <div className={styles.cardTitle}>
            🧩 Zona akumulasi — di harga berapa uang berpindah
            <small> · {levelsData.from} → {levelsData.to} · pasangan buyer/seller dominan per level · broker terpilih disorot</small>
          </div>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col" className={styles.num}>Harga (avg)</th>
                  <th scope="col">Buyer dominan</th>
                  <th scope="col" className={styles.num}>Nilai beli</th>
                  <th scope="col">Seller dominan</th>
                  <th scope="col" className={styles.num}>Nilai jual</th>
                </tr>
              </thead>
              <tbody>
                {[...levelsData.levels]
                  .sort(
                    (a, b) =>
                      Math.round(b.buy?.bavg ?? b.sell?.savg ?? 0) -
                      Math.round(a.buy?.bavg ?? a.sell?.savg ?? 0)
                  )
                  .map((lv, i) => {
                    const b = lv.buy || {};
                    const s = lv.sell || {};
                    const lvl = b.bavg ?? s.savg ?? null;
                    const hiB = b.broker_code && selected.includes(b.broker_code);
                    const hiS = s.broker_code && selected.includes(s.broker_code);
                    return (
                      <tr key={`${lvl}-${i}`}>
                        <td className={styles.num}>
                          <b>{formatPrice(lvl != null ? Math.round(lvl) : null)}</b>
                        </td>
                        <td className={hiB ? styles.up : undefined}>
                          {b.broker_code || "–"}
                          <div className={styles.sub}>{b.broker_name || ""}</div>
                        </td>
                        <td className={styles.num}>{b.bval != null ? formatRp(b.bval, true) : "–"}</td>
                        <td className={hiS ? styles.down : undefined}>
                          {s.broker_code || "–"}
                          <div className={styles.sub}>{s.broker_name || ""}</div>
                        </td>
                        <td className={styles.num}>{s.sval != null ? formatRp(s.sval, true) : "–"}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ---- CHART (garis harga + net kumulatif, overlay insider bila dimuat) ---- */}
      {data && (
        <Chart
          historyRows={historyRows}
          results={results}
          splitDate={splitDate}
          insiders={insiders}
        />
      )}

      {/* ---- CHART ALIRAN ASING (data sudah ada di history — 0 request) ---- */}
      {data && <ForeignChart historyRows={historyRows} splitDate={splitDate} />}

      {/* ---- CHART POSISI (lembar + avg cost) ---- */}
      {data && results.length > 0 && (
        <PositionChart historyRows={historyRows} results={results} splitDate={splitDate} />
      )}

      {/* ---- CHART REALISASI KUMULATIF (Rp) ---- */}
      {data && results.length > 0 && (
        <RealizedChart historyRows={historyRows} results={results} splitDate={splitDate} />
      )}

      {/* ---- DISCLAIMER ---- */}
      <footer className={styles.footer}>
        <b>Batasan:</b> data broker bersifat <i>net per hari</i> — gross harian hanya estimasi dari
        bavg/savg, jadi realized P&L adalah estimasi, bukan angka bandar sebenarnya. “Sisa barang”
        hanya terhitung sejak tanggal mulai rentang. Harga mengikuti kesegaran feed IDX Edge (bukan
        real-time saat pasar tutup). Bukan rekomendasi beli/jual — bandarmologi adalah inferensi,
        bukan fakta posisi broker. Sumber: IDX Edge PRO (stock.arjum.com).
      </footer>

      {/* ---- toast feedback aksi ---- */}
      {toast && (
        <div className={styles.toast} role="status" aria-live="polite">
          ✓ {toast}
        </div>
      )}
    </div>
  );
}

// ---------------- CHART (SVG murni, tanpa dependency) ----------------
const PAD = { l: 78, r: 78, t: 18, b: 30 };

function Chart({ historyRows, results, splitDate, insiders }) {
  const W = 960;
  const H = 340;
  const [hoverIdx, setHoverIdx] = useState(null); // indeks tanggal saat hover

  const model = useMemo(() => {
    if (!historyRows.length) return null;
    const dates = historyRows.map((r) => r.date);
    const closes = historyRows.map((r) => r.close ?? 0);
    // net asing harian (LEMBAR) — sudah ada di respons history yang sama, tanpa request tambahan
    const foreign = historyRows.map((r) => (r.n_foreign == null ? null : r.n_foreign));

    // cumulative net value per broker, di-carry-forward ke setiap tanggal harga
    const lines = results.map((r, i) => {
      const byDate = new Map();
      let cum = 0;
      for (const t of r.timeline) {
        cum += t.nval;
        byDate.set(t.date, cum);
      }
      let last = null;
      const vals = dates.map((d) => {
        if (byDate.has(d)) last = byDate.get(d);
        return last; // null sebelum broker pertama muncul
      });
      return { code: r.code, color: PALETTE[i % PALETTE.length], vals, last: last ?? 0 };
    });

    const cumVals = lines.flatMap((l) => l.vals.filter((v) => v != null));
    let cMin = Math.min(0, ...cumVals);
    let cMax = Math.max(0, ...cumVals);
    if (cMin === cMax) {
      cMin -= 1;
      cMax += 1;
    }
    let pMin = Math.min(...closes);
    let pMax = Math.max(...closes);
    if (pMin === pMax) {
      pMin -= 1;
      pMax += 1;
    }
    const pad = (pMax - pMin) * 0.06;
    pMin -= pad;
    pMax += pad;

    const x = (i) =>
      PAD.l + (dates.length <= 1 ? 0 : (i / (dates.length - 1)) * (W - PAD.l - PAD.r));
    const yC = (v) => PAD.t + (1 - (v - cMin) / (cMax - cMin)) * (H - PAD.t - PAD.b);
    const yP = (v) => PAD.t + (1 - (v - pMin) / (pMax - pMin)) * (H - PAD.t - PAD.b);

    // indeks batas fase
    let splitIdx = -1;
    if (splitDate) {
      splitIdx = dates.findIndex((d) => d >= splitDate);
      if (splitIdx === -1) splitIdx = dates.length; // semua sebelum split
    }

    const pathPrice = closes.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yP(v).toFixed(1)}`).join(" ");

    const paths = lines
      .map((l) => {
        let d = "";
        let started = false;
        l.vals.forEach((v, i) => {
          if (v == null) return;
          d += `${started ? "L" : "M"}${x(i).toFixed(1)},${yC(v).toFixed(1)}`;
          started = true;
        });
        return { ...l, d };
      })
      .filter((l) => l.d);

    // tick sumbu
    const priceTicks = [pMin, (pMin + pMax) / 2, pMax];
    const cumTicks = [cMin, (cMin + cMax) / 2, cMax];
    const dateTickIdx = [...new Set([0, Math.floor((dates.length - 1) / 3), Math.floor((2 * (dates.length - 1)) / 3), dates.length - 1])];

    // marker insider (hanya yang tanggalnya jatuh di hari bursa pada rentang)
    const dateIdx = new Map(dates.map((d, i) => [d, i]));
    const markers = (insiders || [])
      .map((ins) => {
        const i = dateIdx.get(ins.date);
        if (i == null) return null;
        return { date: ins.date, i, buy: ins.action_type !== "sell", name: ins.name };
      })
      .filter(Boolean);

    return { dates, closes, foreign, x, yP, yC, pathPrice, paths, priceTicks, cumTicks, dateTickIdx, splitIdx, markers, pMin, pMax, cMin, cMax };
  }, [historyRows, results, splitDate, insiders]);

  if (!model) return null;
  const { x, yP, pathPrice, paths, priceTicks, cumTicks, dateTickIdx, splitIdx, dates, markers } = model;
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
    transform:
      tipPct > 62 ? "translateX(-100%)" : tipPct < 10 ? "translateX(0)" : "translateX(-50%)",
  };
  const phaseLabel =
    h != null && splitDate
      ? dates[h] >= splitDate
        ? "Fase 2 · tracking"
        : "Fase 1 · bangun posisi"
      : null;

  return (
    <section className={styles.card}>
      <div className={styles.cardTitle}>
        📈 Harga close (abu) vs net value kumulatif broker per pilihan (warna) — fase tracking di
        area terang
        {markers.length > 0 && " · ▲ insider beli, ▼ insider jual"}
        <small> · arahkan kursor (atau sentuh) untuk detail per tanggal</small>
      </div>
      <div
        className={styles.chartWrap}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        onTouchStart={handleTouch}
        onTouchMove={handleTouch}
      >
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img" aria-label="Chart harga dan net value broker">
        {/* area fase 2 */}
        {splitIdx >= 0 && splitIdx < dates.length && (
          <rect
            x={x(splitIdx)}
            y={PAD.t}
            width={Math.max(0, x(dates.length - 1) + 12 - x(splitIdx))}
            height={H - PAD.t - PAD.b}
            fill="rgba(56,189,248,0.07)"
          />
        )}
        {splitIdx > 0 && splitIdx < dates.length && (
          <line x1={x(splitIdx)} y1={PAD.t} x2={x(splitIdx)} y2={H - PAD.b} stroke="#38bdf8" strokeDasharray="5 4" strokeWidth="1.2" />
        )}
        {splitIdx > 0 && splitIdx < dates.length && (
          <>
            <text x={(PAD.l + x(splitIdx)) / 2} y={PAD.t + 10} textAnchor="middle" className={styles.axis}>
              Fase 1
            </text>
            <text x={(x(splitIdx) + x(dates.length - 1)) / 2} y={PAD.t + 10} textAnchor="middle" className={styles.axis}>
              Fase 2
            </text>
          </>
        )}

        {/* grid + label sumbu kiri (cum value) */}
        {cumTicks.map((v, i) => (
          <g key={`c${i}`}>
            <line x1={PAD.l} y1={model.yC(v)} x2={W - PAD.r} y2={model.yC(v)} stroke="rgba(148,163,184,0.15)" strokeWidth="1" />
            <text x={PAD.l - 6} y={model.yC(v) + 4} textAnchor="end" className={styles.axis}>{formatRp(v)}</text>
          </g>
        ))}
        {/* label sumbu kanan (harga) */}
        {priceTicks.map((v, i) => (
          <text key={`p${i}`} x={W - PAD.r + 6} y={yP(v) + 4} textAnchor="start" className={styles.axis}>
            {formatPrice(Math.round(v))}
          </text>
        ))}
        {/* label tanggal */}
        {dateTickIdx.map((i) => (
          <text key={`d${i}`} x={x(i)} y={H - 8} textAnchor="middle" className={styles.axis}>
            {String(dates[i]).slice(5).split("-").reverse().join("/")}
          </text>
        ))}

        {/* harga */}
        <path d={pathPrice} fill="none" stroke="#94a3b8" strokeWidth="1.6" opacity="0.85" />

        {/* broker lines */}
        {paths.map((l) => (
          <path key={l.code} d={l.d} fill="none" stroke={l.color} strokeWidth="2" />
        ))}

        {/* marker insider: ▲ beli (hijau) / ▼ jual (merah) di puncak area plot */}
        {markers.map((m, i) => {
          const mx = x(m.i);
          const my = PAD.t + 8;
          const d = m.buy
            ? `M${mx - 5},${my + 6} L${mx},${my - 2} L${mx + 5},${my + 6} Z`
            : `M${mx - 5},${my - 6} L${mx},${my + 2} L${mx + 5},${my - 6} Z`;
          return (
            <path key={`${m.date}-${i}`} d={d} fill={m.buy ? "#22c55e" : "#ef4444"} opacity="0.9">
              <title>{`${m.date} — ${m.buy ? "beli" : "jual"} — ${m.name}`}</title>
            </path>
          );
        })}

        {/* legend */}
        <g>
          <rect x={PAD.l} y={2} width={10} height={10} fill="#94a3b8" />
          <text x={PAD.l + 14} y={11} className={styles.axis}>close</text>
          {paths.map((l, i) => (
            <g key={l.code} transform={`translate(${PAD.l + 70 + i * 96}, 0)`}>
              <rect x={0} y={2} width={10} height={10} fill={l.color} />
              <text x={14} y={11} className={styles.axis}>{l.code}</text>
            </g>
          ))}
        </g>

        {/* crosshair + titik data saat hover */}
        {h != null && (
          <g pointerEvents="none">
            <line
              x1={x(h)}
              y1={PAD.t}
              x2={x(h)}
              y2={H - PAD.b}
              stroke="#38bdf8"
              strokeDasharray="3 3"
              strokeWidth="1"
              opacity="0.85"
            />
            <circle
              cx={x(h)}
              cy={yP(model.closes[h])}
              r="3.5"
              fill="#94a3b8"
              style={{ stroke: "var(--surface)", strokeWidth: 1.5 }}
            />
            {paths.map((l) => {
              const v = l.vals[h];
              if (v == null) return null;
              return (
                <circle
                  key={l.code}
                  cx={x(h)}
                  cy={model.yC(v)}
                  r="3.5"
                  fill={l.color}
                  style={{ stroke: "var(--surface)", strokeWidth: 1.5 }}
                />
              );
            })}
          </g>
        )}
      </svg>

      {/* tooltip detail per tanggal */}
      {h != null && (
        <div className={styles.chartTip} style={tipStyle}>
          <div className={styles.tipHead}>
            <b>{fmtDate(dates[h])}</b>
            {phaseLabel && <span>{phaseLabel}</span>}
          </div>
          <div className={styles.tipRow}>
            close <b>{formatPrice(model.closes[h])}</b>
          </div>
          {model.foreign[h] != null && (
            <div className={styles.tipRow}>
              asing
              <b className={model.foreign[h] >= 0 ? styles.up : styles.down}>
                {formatShares(model.foreign[h])}
              </b>
            </div>
          )}
          {paths.map((l) => {
            const v = l.vals[h];
            if (v == null) return null;
            return (
              <div key={l.code} className={styles.tipRow}>
                <span className={styles.tipDot} style={{ background: l.color }} />
                {l.code}
                <b className={v >= 0 ? styles.up : styles.down}>{formatRp(v, true)}</b>
              </div>
            );
          })}
          {markers
            .filter((m) => m.i === h)
            .map((m, i) => (
              <div key={`ins-${i}`} className={styles.tipRow}>
                <span
                  className={styles.tipDot}
                  style={{ background: m.buy ? "#22c55e" : "#ef4444" }}
                />
                insider {m.buy ? "beli" : "jual"} <b>{m.name}</b>
              </div>
            ))}
        </div>
      )}
      </div>
    </section>
  );
}

// ------------- CHART POSISI: sisa barang (kiri) + avg cost (kanan, putus-putus) -------------
function PositionChart({ historyRows, results, splitDate }) {
  const W = 960;
  const H = 300;
  const [hoverIdx, setHoverIdx] = useState(null); // indeks tanggal saat hover

  const model = useMemo(() => {
    if (!historyRows.length || !results.length) return null;
    const dates = historyRows.map((r) => r.date);
    // harga aktual (Rp) — digambar di sumbu kanan yang sama dengan avg cost
    const closes = historyRows.map((r) => r.close ?? 0);

    // carry-forward posisi & avg cost per broker ke setiap hari bursa
    const lines = results.map((r, i) => {
      const byDate = new Map(r.timeline.map((t) => [t.date, t]));
      let shares = 0;
      let avg = null;
      const sharesVals = [];
      const avgVals = [];
      for (const d of dates) {
        const t = byDate.get(d);
        if (t) {
          shares = t.shares;
          if (t.avgCost > 0) avg = t.avgCost;
        }
        sharesVals.push(shares);
        avgVals.push(shares > 0 && avg != null ? avg : null);
      }
      return { code: r.code, color: PALETTE[i % PALETTE.length], sharesVals, avgVals };
    });

    const sVals = lines.flatMap((l) => l.sharesVals);
    if (!sVals.length) return null;
    let sMin = 0;
    let sMax = Math.max(...sVals);
    if (sMax <= 0) sMax = 1;
    const aVals = [...lines.flatMap((l) => l.avgVals.filter((v) => v != null)), ...closes];
    let aMin = aVals.length ? Math.min(...aVals) : 0;
    let aMax = aVals.length ? Math.max(...aVals) : 1;
    if (aMin === aMax) {
      aMin -= 1;
      aMax += 1;
    }

    const x = (i) =>
      PAD.l + (dates.length <= 1 ? 0 : (i / (dates.length - 1)) * (W - PAD.l - PAD.r));
    const yS = (v) => PAD.t + (1 - (v - sMin) / (sMax - sMin)) * (H - PAD.t - PAD.b);
    const yA = (v) => PAD.t + (1 - (v - aMin) / (aMax - aMin)) * (H - PAD.t - PAD.b);

    let splitIdx = -1;
    if (splitDate) {
      splitIdx = dates.findIndex((d) => d >= splitDate);
      if (splitIdx === -1) splitIdx = dates.length;
    }

    const mkPath = (vals, yfn) => {
      let d = "";
      let started = false;
      vals.forEach((v, i) => {
        if (v == null) {
          started = false;
          return;
        }
        d += `${started ? "L" : "M"}${x(i).toFixed(1)},${yfn(v).toFixed(1)}`;
        started = true;
      });
      return d;
    };

    const segs = lines
      .map((l) => ({
        ...l,
        sharesPath: mkPath(l.sharesVals, yS),
        avgPath: mkPath(l.avgVals, yA),
      }))
      .filter((s) => s.sharesPath);

    const dateTickIdx = [
      ...new Set([
        0,
        Math.floor((dates.length - 1) / 3),
        Math.floor((2 * (dates.length - 1)) / 3),
        dates.length - 1,
      ]),
    ];
    const sTicks = [sMin, (sMin + sMax) / 2, sMax];
    const aTicks = aVals.length ? [aMin, (aMin + aMax) / 2, aMax] : [];
    const pricePath = closes.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yA(v).toFixed(1)}`).join(" ");

    return { dates, closes, x, yS, yA, splitIdx, segs, dateTickIdx, sTicks, aTicks, pricePath };
  }, [historyRows, results, splitDate]);

  if (!model) return null;
  const { dates, closes, x, splitIdx, segs, dateTickIdx, sTicks, aTicks, pricePath } = model;
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
    transform:
      tipPct > 62 ? "translateX(-100%)" : tipPct < 10 ? "translateX(0)" : "translateX(-50%)",
  };
  const phaseLabel =
    h != null && splitDate
      ? dates[h] >= splitDate
        ? "Fase 2 · tracking"
        : "Fase 1 · bangun posisi"
      : null;

  return (
    <section className={styles.card}>
      <div className={styles.cardTitle}>
        📦 Sisa barang (lembar, sumbu kiri — tebal) vs <b>harga</b> &amp; avg cost (Rp, sumbu kanan —
        putus-putus)
        <small> · garis putih tebal = harga · arahkan kursor (atau sentuh) untuk detail per tanggal</small>
      </div>
      <div
        className={styles.chartWrap}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        onTouchStart={handleTouch}
        onTouchMove={handleTouch}
      >
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img" aria-label="Chart sisa barang dan average cost broker per pilihan">
        {/* area fase tracking */}
        {splitIdx >= 0 && splitIdx < dates.length && (
          <rect
            x={x(splitIdx)}
            y={PAD.t}
            width={Math.max(0, x(dates.length - 1) + 12 - x(splitIdx))}
            height={H - PAD.t - PAD.b}
            fill="rgba(56,189,248,0.07)"
          />
        )}
        {splitIdx > 0 && splitIdx < dates.length && (
          <line
            x1={x(splitIdx)}
            y1={PAD.t}
            x2={x(splitIdx)}
            y2={H - PAD.b}
            stroke="#38bdf8"
            strokeDasharray="5 4"
            strokeWidth="1.2"
          />
        )}

        {splitIdx > 0 && splitIdx < dates.length && (
          <>
            <text x={(PAD.l + x(splitIdx)) / 2} y={PAD.t + 10} textAnchor="middle" className={styles.axis}>
              Fase 1
            </text>
            <text x={(x(splitIdx) + x(dates.length - 1)) / 2} y={PAD.t + 10} textAnchor="middle" className={styles.axis}>
              Fase 2
            </text>
          </>
        )}

        {/* grid + label sumbu kiri (lembar) */}
        {sTicks.map((v, i) => (
          <g key={`s${i}`}>
            <line
              x1={PAD.l}
              y1={model.yS(v)}
              x2={W - PAD.r}
              y2={model.yS(v)}
              stroke="rgba(148,163,184,0.15)"
              strokeWidth="1"
            />
            <text x={PAD.l - 6} y={model.yS(v) + 4} textAnchor="end" className={styles.axis}>
              {formatShares(v)}
            </text>
          </g>
        ))}
        {/* label sumbu kanan (avg cost) */}
        {aTicks.map((v, i) => (
          <text key={`a${i}`} x={W - PAD.r + 6} y={model.yA(v) + 4} textAnchor="start" className={styles.axis}>
            {formatPrice(Math.round(v))}
          </text>
        ))}
        {/* label tanggal */}
        {dateTickIdx.map((i) => (
          <text key={`d${i}`} x={x(i)} y={H - 8} textAnchor="middle" className={styles.axis}>
            {String(dates[i]).slice(5).split("-").reverse().join("/")}
          </text>
        ))}

        {/* harga aktual — tebal & terang supaya jelas dibanding garis broker */}
        <path d={pricePath} fill="none" stroke="#f8fafc" strokeWidth="2.4" opacity="0.95" />

        {/* garis posisi (tebal) + avg cost (putus-putus, warna sama) */}
        {segs.map((s) => (
          <g key={s.code}>
            <path d={s.sharesPath} fill="none" stroke={s.color} strokeWidth="2.2" />
            {s.avgPath && (
              <path
                d={s.avgPath}
                fill="none"
                stroke={s.color}
                strokeWidth="1.4"
                strokeDasharray="4 4"
                opacity="0.7"
              />
            )}
          </g>
        ))}

        {/* legend */}
        <g>
          <rect x={PAD.l} y={2} width={14} height={3} fill="#f8fafc" />
          <text x={PAD.l + 18} y={8} className={styles.axis}>harga</text>
          <rect x={PAD.l + 66} y={2} width={14} height={3} fill="#e2e8f0" />
          <text x={PAD.l + 84} y={8} className={styles.axis}>lembar</text>
          <rect x={PAD.l + 138} y={2} width={14} height={3} fill="#e2e8f0" opacity="0.6" />
          <text x={PAD.l + 156} y={8} className={styles.axis}>avg cost</text>
          {segs.map((s, i) => (
            <g key={s.code} transform={`translate(${PAD.l + 222 + i * 96}, 0)`}>
              <rect x={0} y={2} width={10} height={10} fill={s.color} />
              <text x={14} y={11} className={styles.axis}>{s.code}</text>
            </g>
          ))}
        </g>

        {/* crosshair + titik posisi/avg saat hover */}
        {h != null && (
          <g pointerEvents="none">
            <line
              x1={x(h)}
              y1={PAD.t}
              x2={x(h)}
              y2={H - PAD.b}
              stroke="#38bdf8"
              strokeDasharray="3 3"
              strokeWidth="1"
              opacity="0.85"
            />
            <circle
              cx={x(h)}
              cy={model.yA(closes[h])}
              r="3.5"
              fill="#f8fafc"
              style={{ stroke: "var(--surface)", strokeWidth: 1.5 }}
            />
            {segs.map((s) => {
              const sh = s.sharesVals[h];
              const av = s.avgVals[h];
              return (
                <g key={s.code}>
                  {sh > 0 && (
                    <circle
                      cx={x(h)}
                      cy={model.yS(sh)}
                      r="3.5"
                      fill={s.color}
                      style={{ stroke: "var(--surface)", strokeWidth: 1.5 }}
                    />
                  )}
                  {av != null && (
                    <circle cx={x(h)} cy={model.yA(av)} r="3" fill="none" stroke={s.color} strokeWidth="2" />
                  )}
                </g>
              );
            })}
          </g>
        )}
      </svg>

      {/* tooltip detail per tanggal */}
      {h != null && (
        <div className={styles.chartTip} style={tipStyle}>
          <div className={styles.tipHead}>
            <b>{fmtDate(dates[h])}</b>
            {phaseLabel && <span>{phaseLabel}</span>}
          </div>
          <div className={styles.tipRow}>
            harga <b>{formatPrice(closes[h])}</b>
          </div>
          {segs.map((s) => {
            const sh = s.sharesVals[h];
            const av = s.avgVals[h];
            if (!sh && av == null) return null;
            return (
              <div key={s.code} className={styles.tipRow}>
                <span className={styles.tipDot} style={{ background: s.color }} />
                {s.code}
                <b>{formatShares(sh)}</b>
                {av != null && <span className={styles.tipSub}>@ {formatPrice(Math.round(av))}</span>}
              </div>
            );
          })}
        </div>
      )}
      </div>
    </section>
  );
}

// ------------- CHART ALIRAN ASING: net harian (batang) + kumulatif (LEMBAR, dari history) ----
function ForeignChart({ historyRows, splitDate }) {
  const W = 960;
  const H = 220;
  const [hoverIdx, setHoverIdx] = useState(null);

  const model = useMemo(() => {
    if (historyRows.length < 2) return null;
    const dates = historyRows.map((r) => r.date);
    const daily = historyRows.map((r) => (r.n_foreign == null ? null : r.n_foreign));
    const have = daily.filter((v) => v != null);
    if (have.length < 2) return null;

    let cum = 0;
    const cumul = daily.map((v) => (v == null ? null : (cum += v)));
    const maxAbs = Math.max(1, ...have.map(Math.abs));
    const meanClose = historyRows.reduce((s, r) => s + (r.close || 0), 0) / historyRows.length;

    let splitIdx = -1;
    if (splitDate) {
      splitIdx = dates.findIndex((d) => d >= splitDate);
      if (splitIdx === -1) splitIdx = dates.length;
    }

    const x = (i) =>
      PAD.l + (dates.length <= 1 ? 0 : (i / (dates.length - 1)) * (W - PAD.l - PAD.r));
    const y = (v) => PAD.t + (1 - (v + maxAbs) / (2 * maxAbs)) * (H - PAD.t - PAD.b);
    const barW = Math.max(1.5, ((W - PAD.l - PAD.r) / Math.max(dates.length - 1, 1)) * 0.6);

    return {
      dates,
      daily,
      cumul,
      x,
      y,
      barW,
      splitIdx,
      meanClose,
      total: cum,
      buyDays: have.filter((v) => v > 0).length,
      sellDays: have.filter((v) => v < 0).length,
      days: have.length,
    };
  }, [historyRows, splitDate]);

  if (!model) return null;
  const { dates, daily, cumul, x, y, barW, splitIdx, meanClose, total, buyDays, sellDays, days, maxAbs } =
    model;
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
    transform:
      tipPct > 62 ? "translateX(-100%)" : tipPct < 10 ? "translateX(0)" : "translateX(-50%)",
  };
  const phaseLabel =
    h != null && splitDate
      ? dates[h] >= splitDate
        ? "Fase 2 · tracking"
        : "Fase 1 · bangun posisi"
      : null;
  const tickIdx = [...new Set([0, Math.floor((dates.length - 1) / 3), Math.floor((2 * (dates.length - 1)) / 3), dates.length - 1])];

  return (
    <section className={styles.card}>
      <div className={styles.cardTitle}>
        🌍 Aliran asing — batang: net harian (LEMBAR) · total {formatShares(total)} (≈
        {formatRp(total * meanClose)})
        <small>
          {" · "}net beli {buyDays} hari · net jual {sellDays} hari dari {days} hari · arahkan
          kursor untuk detail
        </small>
      </div>
      <div
        className={styles.chartWrap}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        onTouchStart={handleTouch}
        onTouchMove={handleTouch}
      >
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img" aria-label="Chart aliran asing harian">
        {splitIdx >= 0 && splitIdx < dates.length && (
          <rect
            x={x(splitIdx)}
            y={PAD.t}
            width={Math.max(0, x(dates.length - 1) + 12 - x(splitIdx))}
            height={H - PAD.t - PAD.b}
            fill="rgba(56,189,248,0.07)"
          />
        )}
        {splitIdx > 0 && splitIdx < dates.length && (
          <line
            x1={x(splitIdx)}
            y1={PAD.t}
            x2={x(splitIdx)}
            y2={H - PAD.b}
            stroke="#38bdf8"
            strokeDasharray="5 4"
            strokeWidth="1.2"
          />
        )}

        {/* garis nol */}
        <line x1={PAD.l} y1={y(0)} x2={W - PAD.r} y2={y(0)} stroke="rgba(148,163,184,0.35)" strokeWidth="1" />
        <text x={PAD.l - 6} y={y(0) + 4} textAnchor="end" className={styles.axis}>0</text>
        <text x={PAD.l - 6} y={PAD.t + 10} textAnchor="end" className={styles.axis}>
          +{formatShares(maxAbs)}
        </text>
        <text x={PAD.l - 6} y={H - PAD.b - 2} textAnchor="end" className={styles.axis}>
          −{formatShares(maxAbs)}
        </text>

        {/* label tanggal */}
        {tickIdx.map((i) => (
          <text key={`d${i}`} x={x(i)} y={H - 8} textAnchor="middle" className={styles.axis}>
            {fmtDate(dates[i])}
          </text>
        ))}

        {/* batang net harian asing */}
        {daily.map((v, i) => {
          if (v == null) return null;
          const y0 = y(0);
          const y1 = y(v);
          return (
            <rect
              key={dates[i]}
              x={x(i) - barW / 2}
              y={Math.min(y0, y1)}
              width={barW}
              height={Math.max(1, Math.abs(y1 - y0))}
              fill={v >= 0 ? "#22c55e" : "#ef4444"}
              opacity="0.55"
            />
          );
        })}

        {/* crosshair */}
        {h != null && (
          <g pointerEvents="none">
            <line
              x1={x(h)}
              y1={PAD.t}
              x2={x(h)}
              y2={H - PAD.b}
              stroke="#38bdf8"
              strokeDasharray="3 3"
              strokeWidth="1"
              opacity="0.85"
            />
          </g>
        )}
      </svg>

      {h != null && (
        <div className={styles.chartTip} style={tipStyle}>
          <div className={styles.tipHead}>
            <b>{fmtDate(dates[h])}</b>
            {phaseLabel && <span>{phaseLabel}</span>}
          </div>
          <div className={styles.tipRow}>
            asing harian
            <b className={daily[h] == null ? undefined : daily[h] >= 0 ? styles.up : styles.down}>
              {daily[h] == null ? "–" : formatShares(daily[h])}
            </b>
          </div>
          <div className={styles.tipRow}>
            kumulatif <b>{cumul[h] == null ? "–" : formatShares(cumul[h])}</b>
          </div>
        </div>
      )}
      </div>
    </section>
  );
}

// ------------- CHART REALISASI KUMULATIF (Rp) per broker -------------
function RealizedChart({ historyRows, results, splitDate }) {
  const W = 960;
  const H = 240;
  const [hoverIdx, setHoverIdx] = useState(null);

  const model = useMemo(() => {
    if (!historyRows.length || !results.length) return null;
    const dates = historyRows.map((r) => r.date);
    const lines = results.map((r, i) => {
      const byDate = new Map(r.timeline.map((t) => [t.date, t.realized]));
      let last = 0;
      const vals = dates.map((d) => {
        if (byDate.has(d)) last = byDate.get(d);
        return last;
      });
      return { code: r.code, color: PALETTE[i % PALETTE.length], vals };
    });
    const all = lines.flatMap((l) => l.vals);
    let vMin = Math.min(0, ...all);
    let vMax = Math.max(0, ...all);
    if (vMin === vMax) {
      vMin -= 1;
      vMax += 1;
    }
    let splitIdx = -1;
    if (splitDate) {
      splitIdx = dates.findIndex((d) => d >= splitDate);
      if (splitIdx === -1) splitIdx = dates.length;
    }
    const x = (i) => PAD.l + (dates.length <= 1 ? 0 : (i / (dates.length - 1)) * (W - PAD.l - PAD.r));
    const y = (v) => PAD.t + (1 - (v - vMin) / (vMax - vMin)) * (H - PAD.t - PAD.b);
    const path = (vals) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    return { dates, lines, x, y, path, splitIdx, ticks: [vMin, (vMin + vMax) / 2, vMax] };
  }, [historyRows, results, splitDate]);

  if (!model) return null;
  const { dates, lines, x, y, path, splitIdx, ticks } = model;
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
  const phaseLabel =
    h != null && splitDate
      ? dates[h] >= splitDate
        ? "Fase 2 · tracking"
        : "Fase 1 · bangun posisi"
      : null;
  const total = lines.reduce((s, l) => s + l.vals[l.vals.length - 1], 0);

  return (
    <section className={styles.card}>
      <div className={styles.cardTitle}>
        💵 Realisasi kumulatif (Rp) — kapan profit-taking terjadi
        <small> · total saat ini {formatRp(total, true)} · arahkan kursor untuk detail</small>
      </div>
      <div
        className={styles.chartWrap}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        onTouchStart={handleTouch}
        onTouchMove={handleTouch}
      >
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img" aria-label="Chart realisasi kumulatif per broker">
        {splitIdx >= 0 && splitIdx < dates.length && (
          <rect
            x={x(splitIdx)}
            y={PAD.t}
            width={Math.max(0, x(dates.length - 1) + 12 - x(splitIdx))}
            height={H - PAD.t - PAD.b}
            fill="rgba(56,189,248,0.07)"
          />
        )}
        {splitIdx > 0 && splitIdx < dates.length && (
          <text x={(PAD.l + x(splitIdx)) / 2} y={PAD.t + 10} textAnchor="middle" className={styles.axis}>
            Fase 1
          </text>
        )}
        {ticks.map((v, i) => (
          <g key={`t${i}`}>
            <line x1={PAD.l} y1={y(v)} x2={W - PAD.r} y2={y(v)} stroke="rgba(148,163,184,0.15)" strokeWidth="1" />
            <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className={styles.axis}>{formatRp(v)}</text>
          </g>
        ))}
        {lines.map((l) => (
          <path key={l.code} d={path(l.vals)} fill="none" stroke={l.color} strokeWidth="2" />
        ))}
        {h != null && (
          <g pointerEvents="none">
            <line x1={x(h)} y1={PAD.t} x2={x(h)} y2={H - PAD.b} stroke="#38bdf8" strokeDasharray="3 3" strokeWidth="1" opacity="0.85" />
            {lines.map((l) => (
              <circle key={l.code} cx={x(h)} cy={y(l.vals[h])} r="3" fill={l.color} style={{ stroke: "var(--surface)", strokeWidth: 1.5 }} />
            ))}
          </g>
        )}
      </svg>

      {h != null && (
        <div className={styles.chartTip} style={tipStyle}>
          <div className={styles.tipHead}>
            <b>{fmtDate(dates[h])}</b>
            {phaseLabel && <span>{phaseLabel}</span>}
          </div>
          {lines.map((l) => (
            <div key={l.code} className={styles.tipRow}>
              <span className={styles.tipDot} style={{ background: l.color }} />
              {l.code}
              <b className={l.vals[h] >= 0 ? styles.up : styles.down}>{formatRp(l.vals[h], true)}</b>
            </div>
          ))}
        </div>
      )}
      </div>
    </section>
  );
}
