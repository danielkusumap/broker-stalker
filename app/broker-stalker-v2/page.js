"use client";

import { useEffect, useMemo, useState } from "react";
import {
  STAGE_TYPES,
  ADD_STAGE_TYPES,
  stageMeta,
  computeSnapshots,
  stageChanges,
  summarizeBadges,
  signed,
  signedRp,
  lotsOf,
} from "../../lib/bs2/calc";
import { formatNumber, formatPrice, formatPct } from "../../lib/brokerMath";
import styles from "./broker-stalker-v2.module.css";

const STORAGE = "brokerstalker.bs2.session.v1";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtDate(iso) {
  if (!iso) return "–";
  return String(iso).slice(5).split("-").reverse().join("/");
}
function valClass(n) {
  return n > 0 ? styles.pos : n < 0 ? styles.neg : styles.muted;
}

async function getJson(url) {
  const res = await fetch(url);
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* bukan JSON */
  }
  if (!res.ok) throw new Error(json?.error || `Request gagal (HTTP ${res.status})`);
  return json;
}

export default function BrokerStalkerV2Page() {
  const [ready, setReady] = useState(false);
  const [ticker, setTicker] = useState("");
  const [initType, setInitType] = useState("Init");
  const [initStart, setInitStart] = useState("");
  const [initEnd, setInitEnd] = useState("");

  const [session, setSession] = useState(null);
  const [summaries, setSummaries] = useState([]);
  const [picker, setPicker] = useState(null);
  const [tab, setTab] = useState("buy");
  const [checked, setChecked] = useState([]);
  const [activeUpdate, setActiveUpdate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [addType, setAddType] = useState("Bullish");
  const [addStart, setAddStart] = useState("");
  const [addEnd, setAddEnd] = useState("");
  const [sortBy, setSortBy] = useState("shares");

  // ---- restore sesi + tanggal default (client-only, aman untuk prerender) ----
  async function loadSessionSummaries(s) {
    setLoading(true);
    setError("");
    try {
      const arr = await Promise.all(
        s.stages.map((st) =>
          getJson(
            `/api/bs2/summary?code=${s.code}&start=${st.start}&end=${st.end}`
          ).then((j) => j.brokers)
        )
      );
      setSummaries(arr);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(true);
    setInitStart(isoDaysAgo(30));
    setInitEnd(todayIso());
    setAddStart(todayIso());
    setAddEnd(todayIso());
    try {
      const raw = localStorage.getItem(STORAGE);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!s?.code || !s?.stages?.length || !s?.tracked?.length) return;
      setSession(s);
      setTicker(s.code);
      const last = s.stages[s.stages.length - 1];
      setAddStart(addDays(last.end, 1));
      setAddEnd(addDays(last.end, 1));
      loadSessionSummaries(s);
    } catch {
      /* localStorage rusak → mulai bersih */
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    try {
      localStorage.setItem(STORAGE, JSON.stringify(session));
    } catch {
      /* private mode */
    }
  }, [session]);

  // ---- muat data broker untuk tahap awal / tahap baru ----
  async function openPicker(mode) {
    const code = ticker.trim().toUpperCase();
    const stage =
      mode === "initial"
        ? { type: initType, start: initStart, end: initEnd }
        : { type: addType, start: addStart, end: addEnd };
    if (!/^[A-Z0-9]{4}$/.test(code)) {
      setError("Kode saham harus 4 huruf/angka (contoh: BBCA).");
      return;
    }
    if (!stage.start || !stage.end || stage.start > stage.end) {
      setError("Rentang tanggal tidak valid.");
      return;
    }
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const json = await getJson(
        `/api/bs2/summary?code=${code}&start=${stage.start}&end=${stage.end}`
      );
      setPicker({
        mode,
        stage: { ...stage, close: json.close, closeDate: json.close_date },
        rows: json.brokers,
        source: json.source,
      });
      setTab("buy");
      const pre =
        mode === "initial"
          ? json.brokers
              .filter((r) => r.nvol > 0)
              .sort((a, b) => b.nval - a.nval)
              .slice(0, 5)
              .map((r) => r.broker_code)
          : session.tracked
              .map((t) => t.code)
              .filter((c) => json.brokers.some((r) => r.broker_code === c));
      setChecked(pre);
      setNotice(
        `Data ${code} ${stage.start}–${stage.end} dimuat dari ${json.source === "db" ? "database lokal" : "API"} · ${json.brokers.length} broker.`
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function toggleBroker(code) {
    setChecked((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  }

  function startInitial() {
    if (!picker || !checked.length) return;
    const code = ticker.trim().toUpperCase();
    const tracked = picker.rows
      .filter((r) => checked.includes(r.broker_code))
      .map((r) => ({ code: r.broker_code, name: r.broker_name, entry: 0 }));
    const stage = { ...picker.stage, type: initType, id: `${Date.now()}-0` };
    setSession({ code, stages: [stage], tracked });
    setSummaries([picker.rows]);
    setPicker(null);
    setActiveUpdate(null);
    const next = addDays(stage.end, 1);
    setAddStart(next);
    setAddEnd(next);
    setNotice(`Tracking ${tracked.length} broker dimulai.`);
    setError("");
  }

  function commitStage() {
    if (!picker || !session) return;
    const idx = session.stages.length;
    const existing = new Set(session.tracked.map((t) => t.code));
    const newTracked = picker.rows
      .filter((r) => checked.includes(r.broker_code) && !existing.has(r.broker_code))
      .map((r) => ({ code: r.broker_code, name: r.broker_name, entry: idx }));
    const stage = { ...picker.stage, type: addType, id: `${Date.now()}-${idx}` };
    setSession({
      ...session,
      stages: [...session.stages, stage],
      tracked: [...session.tracked, ...newTracked],
    });
    setSummaries([...summaries, picker.rows]);
    setPicker(null);
    setActiveUpdate(idx);
    const next = addDays(stage.end, 1);
    setAddStart(next);
    setAddEnd(next);
    setNotice(
      newTracked.length
        ? `Tahap ${addType} ditambahkan · ${newTracked.length} broker baru ikut tracking.`
        : `Tahap ${addType} ditambahkan · posisi semua broker diperbarui.`
    );
    setError("");
  }

  function deleteLastStage(index) {
    if (
      !session ||
      index !== session.stages.length - 1 ||
      session.stages.length <= 1 ||
      summaries.length !== session.stages.length
    ) {
      return;
    }
    const stage = session.stages[index];
    const meta = stageMeta(stage.type);
    const ok = window.confirm(
      `Hapus tahap ${index + 1} (${meta.label} ${fmtDate(stage.start)}–${fmtDate(stage.end)})?\n\nPerhitungan akan kembali ke tahap ${index}.`
    );
    if (!ok) return;

    const stages = session.stages.slice(0, -1);
    // broker yang baru masuk di tahap yang dihapus ikut dilepas
    const tracked = session.tracked.filter((t) => t.entry < index);
    setSession({ ...session, stages, tracked });
    setSummaries(summaries.slice(0, -1));
    setActiveUpdate(stages.length - 1);
    const last = stages[stages.length - 1];
    setAddStart(addDays(last.end, 1));
    setAddEnd(addDays(last.end, 1));
    setNotice(`Tahap ${index + 1} dihapus · posisi kembali ke tahap ${index}.`);
    setError("");
  }

  function resetSession() {
    setSession(null);
    setSummaries([]);
    setPicker(null);
    setActiveUpdate(null);
    setChecked([]);
    setNotice("");
    setError("");
    try {
      localStorage.removeItem(STORAGE);
    } catch {
      /* private mode */
    }
  }

  // ---- perhitungan ----
  const summaryMaps = useMemo(
    () => summaries.map((rows) => new Map((rows || []).map((r) => [r.broker_code, r]))),
    [summaries]
  );

  const sessionReady =
    !!session &&
    summaries.length === session.stages.length &&
    summaries.every((s) => Array.isArray(s));

  const snapshots = useMemo(() => {
    if (!session || !sessionReady) return [];
    return computeSnapshots({
      stages: session.stages,
      tracked: session.tracked,
      summaries: summaryMaps,
    });
  }, [session, sessionReady, summaryMaps]);

  const latest = useMemo(
    () => snapshots[snapshots.length - 1] || [],
    [snapshots]
  );
  const latestStage = session?.stages[session.stages.length - 1] || null;
  const closing = latestStage?.close ?? null;

  const sortedLatest = useMemo(() => {
    const arr = [...latest];
    if (sortBy === "floating") arr.sort((a, b) => (b.floatingIdr || 0) - (a.floatingIdr || 0));
    else if (sortBy === "avg") arr.sort((a, b) => (b.avg || 0) - (a.avg || 0));
    else if (sortBy === "code") arr.sort((a, b) => a.code.localeCompare(b.code));
    else arr.sort((a, b) => Math.abs(b.shares) - Math.abs(a.shares));
    return arr;
  }, [latest, sortBy]);

  const totalFloating = latest.reduce((a, r) => a + (r.floatingIdr || 0), 0);

  const trackedCodes = useMemo(
    () => new Set((session?.tracked || []).map((t) => t.code)),
    [session]
  );

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div>
          <div className={styles.kicker}>BROKER STALKER · V2</div>
          <h1 className={styles.title}>Lacak posisi broker per tahap</h1>
          <p className={styles.subtitle}>
            Tentukan tahap (inisialisasi, ATH, bullish, bearish, distribusi), pilih broker
            yang mau diikuti, lalu lihat siapa yang masih mengumpulkan, average down, atau
            cut loss.
          </p>
        </div>
        {session && (
          <div className={styles.headerBadges}>
            <span className={styles.tickerBadge}>{session.code}</span>
            <span className={styles.softBadge}>{session.stages.length} tahap</span>
            <span className={styles.softBadge}>{session.tracked.length} broker</span>
            <button type="button" className={styles.btnDanger} onClick={resetSession}>
              Reset
            </button>
          </div>
        )}
      </header>

      {error && <div className={styles.error}>{error}</div>}
      {notice && !error && <div className={styles.notice}>{notice}</div>}

      {!session && (
        <>
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <div>
                <h2 className={styles.cardTitle}>1. Tentukan tahap awal</h2>
                <p className={styles.cardSub}>
                  Pilih rentang yang dijadikan dasar tracking. Untuk tahap pertama gunakan
                  <b> Inisialisasi</b>; label ATH/Bullish/Bearish/Distribusi dipakai untuk
                  tahap-tahap berikutnya.
                </p>
              </div>
            </div>

            <div className={styles.form}>
              <label className={styles.field}>
                <span>Kode saham</span>
                <input
                  className={styles.inputCode}
                  value={ticker}
                  maxLength={4}
                  onChange={(e) => setTicker(e.target.value.toUpperCase())}
                  placeholder="BBCA"
                />
              </label>
              <label className={styles.field}>
                <span className={styles.labelRow}>
                  Tahap
                  <InfoDot text="Inisialisasi = baseline awal. ATH = area puncak. Bullish = harga naik. Bearish = harga turun. Distribusi = ada pihak besar melepas barang." />
                </span>
                <select
                  className={styles.select}
                  value={initType}
                  title={stageMeta(initType).description}
                  onChange={(e) => setInitType(e.target.value)}
                >
                  {STAGE_TYPES.map((t) => (
                    <option key={t.key} value={t.key} title={t.description}>
                      {t.emoji} {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span>Mulai</span>
                <input
                  type="date"
                  className={styles.inputDate}
                  value={initStart}
                  onChange={(e) => setInitStart(e.target.value)}
                />
              </label>
              <label className={styles.field}>
                <span>Sampai</span>
                <input
                  type="date"
                  className={styles.inputDate}
                  value={initEnd}
                  onChange={(e) => setInitEnd(e.target.value)}
                />
              </label>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={() => openPicker("initial")}
                disabled={loading || !ready}
              >
                {loading ? "Memuat…" : "Muat data broker"}
              </button>
            </div>
            <p className={styles.typeHint}>
              {stageMeta(initType).emoji} <b>{stageMeta(initType).label}</b> —{" "}
              {stageMeta(initType).description}
            </p>
          </section>

          {picker?.mode === "initial" && (
            <BrokerPicker
              picker={picker}
              tab={tab}
              setTab={setTab}
              checked={checked}
              toggleBroker={toggleBroker}
              trackedCodes={trackedCodes}
              onClear={() => setChecked([])}
              onAll={() =>
                setChecked(
                  picker.rows
                    .filter((r) => (tab === "buy" ? r.nvol > 0 : r.nvol < 0))
                    .map((r) => r.broker_code)
                )
              }
              onTop={() => {
                const top = picker.rows
                  .filter((r) => r.nvol > 0)
                  .sort((a, b) => b.nval - a.nval)
                  .slice(0, 5)
                  .map((r) => r.broker_code);
                setChecked(top);
              }}
              commitLabel={`Tracking (${checked.length} broker)`}
              onCommit={startInitial}
            />
          )}

          <section className={styles.guide}>
            <div className={styles.guideItem}>
              <span className={styles.guideNum}>1</span>
              <b>Muat ringkasan broker</b>
              <p>Lihat siapa yang net buy / net sell pada rentang tahap awal.</p>
            </div>
            <div className={styles.guideItem}>
              <span className={styles.guideNum}>2</span>
              <b>Centang & tracking</b>
              <p>Broker yang dicentang jadi posisi awal yang akan diikuti.</p>
            </div>
            <div className={styles.guideItem}>
              <span className={styles.guideNum}>3</span>
              <b>Tambah tahap</b>
              <p>Setiap tahap baru memperbarui posisi, AVG, dan floating P&amp;L.</p>
            </div>
          </section>
        </>
      )}

      {session && (
        <>
          <StageTimeline
            stages={session.stages}
            active={activeUpdate}
            onUpdate={setActiveUpdate}
            onDelete={deleteLastStage}
          />

          <section className={styles.card}>
            <div className={styles.cardHead}>
              <div>
                <h2 className={styles.cardTitle}>Tambah tahap</h2>
                <p className={styles.cardSub}>
                  Pilih jenis tahap dan rentangnya. Broker yang sudah tracking otomatis
                  dihitung; centang broker baru kalau ingin ikut di tahap ini.
                </p>
              </div>
              <span className={styles.softBadge}>Tahap {session.stages.length + 1}</span>
            </div>

            <div className={styles.form}>
              <div className={styles.field}>
                <span className={styles.labelRow}>
                  Jenis tahap
                  <InfoDot text="Bearish = fokus harga turun. Distribusi = fokus ada pihak besar melepas barang (bisa saat harga naik, flat, atau turun). Bullish = fokus akumulasi saat harga naik." />
                </span>
                <div className={styles.segmented}>
                  {ADD_STAGE_TYPES.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      title={t.description}
                      className={`${styles.segBtn} ${addType === t.key ? styles.segBtnActive : ""}`}
                      style={
                        addType === t.key
                          ? { borderColor: t.color, color: t.color, background: `${t.color}18` }
                          : undefined
                      }
                      onClick={() => setAddType(t.key)}
                    >
                      <span>{t.emoji}</span> {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <label className={styles.field}>
                <span>Mulai</span>
                <input
                  type="date"
                  className={styles.inputDate}
                  value={addStart}
                  onChange={(e) => setAddStart(e.target.value)}
                />
              </label>
              <label className={styles.field}>
                <span>Sampai</span>
                <input
                  type="date"
                  className={styles.inputDate}
                  value={addEnd}
                  onChange={(e) => setAddEnd(e.target.value)}
                />
              </label>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={() => openPicker("add")}
                disabled={loading}
              >
                {loading ? "Memuat…" : "Lihat data broker"}
              </button>
            </div>
            <p className={styles.typeHint}>
              {stageMeta(addType).emoji} <b>{stageMeta(addType).label}</b> —{" "}
              {stageMeta(addType).description}
            </p>
          </section>

          {picker?.mode === "add" && (
            <BrokerPicker
              picker={picker}
              tab={tab}
              setTab={setTab}
              checked={checked}
              toggleBroker={toggleBroker}
              trackedCodes={trackedCodes}
              onClear={() =>
                setChecked(session.tracked.map((t) => t.code))
              }
              onAll={() =>
                setChecked([
                  ...new Set([
                    ...session.tracked.map((t) => t.code),
                    ...picker.rows
                      .filter((r) => (tab === "buy" ? r.nvol > 0 : r.nvol < 0))
                      .map((r) => r.broker_code),
                  ]),
                ])
              }
              onTop={() => {
                const top = picker.rows
                  .filter((r) => r.nvol > 0)
                  .sort((a, b) => b.nval - a.nval)
                  .slice(0, 5)
                  .map((r) => r.broker_code);
                setChecked([...new Set([...session.tracked.map((t) => t.code), ...top])]);
              }}
              commitLabel={`Mulai tracking (${checked.filter((c) => !trackedCodes.has(c)).length} broker baru)`}
              onCommit={commitStage}
            />
          )}

          {sessionReady && activeUpdate != null && snapshots[activeUpdate] && (
            <UpdatePanel
              stage={session.stages[activeUpdate]}
              index={activeUpdate}
              changes={stageChanges(snapshots, activeUpdate)}
              summary={summaryMaps[activeUpdate]}
              onClose={() => setActiveUpdate(null)}
            />
          )}

          {!sessionReady && loading && (
            <div className={styles.loading}>Memuat ulang data tahap…</div>
          )}

          {sessionReady && (
            <PositionTable
              rows={sortedLatest}
              closing={closing}
              closingDate={latestStage?.closeDate}
              total={totalFloating}
              sortBy={sortBy}
              setSortBy={setSortBy}
            />
          )}
        </>
      )}
    </div>
  );
}

// ================= Picker =================
function BrokerPicker({
  picker,
  tab,
  setTab,
  checked,
  toggleBroker,
  trackedCodes,
  onClear,
  onAll,
  onTop,
  commitLabel,
  onCommit,
}) {
  const [search, setSearch] = useState("");
  const buyCount = picker.rows.filter((r) => r.nvol > 0).length;
  const sellCount = picker.rows.filter((r) => r.nvol < 0).length;
  const buyValue = picker.rows.filter((r) => r.nval > 0).reduce((a, r) => a + r.nval, 0);
  const sellValue = picker.rows.filter((r) => r.nval < 0).reduce((a, r) => a + r.nval, 0);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return picker.rows
      .filter((r) => (tab === "buy" ? r.nvol > 0 : r.nvol < 0))
      .filter(
        (r) =>
          !q ||
          r.broker_code.toLowerCase().includes(q) ||
          (r.broker_name || "").toLowerCase().includes(q)
      )
      .sort((a, b) => (tab === "buy" ? b.nval - a.nval : a.nval - b.nval));
  }, [picker.rows, tab, search]);

  const meta = stageMeta(picker.stage.type);

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.pickerTitleRow}>
            <span
              className={styles.stageDot}
              style={{ background: meta.color }}
            />
            <h2 className={styles.cardTitle}>
              {meta.emoji} {meta.label} · {fmtDate(picker.stage.start)}–{fmtDate(picker.stage.end)}
            </h2>
          </div>
          <p className={styles.cardSub}>
            Closing {formatPrice(picker.stage.close)} ·{" "}
            {picker.rows.length} broker · sumber {picker.source === "db" ? "database lokal" : "API"}
          </p>
        </div>
        <div className={styles.summaryPills}>
          <span className={styles.pillGood}>Net buy {formatRpShort(buyValue)}</span>
          <span className={styles.pillBad}>Net sell {formatRpShort(sellValue)}</span>
        </div>
      </div>

      <div className={styles.pickerToolbar}>
        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${tab === "buy" ? styles.tabActive : ""}`}
            onClick={() => setTab("buy")}
          >
            Net Buy <span className={styles.tabCount}>{buyCount}</span>
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === "sell" ? styles.tabActive : ""}`}
            onClick={() => setTab("sell")}
          >
            Net Sell <span className={styles.tabCount}>{sellCount}</span>
          </button>
        </div>
        <div className={styles.toolbarRight}>
          <input
            className={styles.search}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari kode / nama broker…"
          />
          <button type="button" className={styles.btnGhostSm} onClick={onTop}>
            Top 5
          </button>
          <button type="button" className={styles.btnGhostSm} onClick={onAll}>
            Pilih semua
          </button>
          <button type="button" className={styles.btnGhostSm} onClick={onClear}>
            Kosongkan
          </button>
        </div>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.checkCol} aria-label="Pilih" />
              <th>Broker</th>
              <th className={styles.num}>Net Value</th>
              <th className={styles.num}>Net Lot</th>
              <th className={styles.num}>Avg Beli</th>
              <th className={styles.num}>Avg Jual</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isTracked = trackedCodes.has(r.broker_code);
              const isChecked = checked.includes(r.broker_code);
              const locked = picker.mode === "add" && isTracked;
              return (
                <tr
                  key={r.broker_code}
                  className={isTracked ? styles.rowTracked : isChecked ? styles.rowChecked : ""}
                  onClick={() => {
                    if (!locked) toggleBroker(r.broker_code);
                  }}
                >
                  <td className={styles.checkCol}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      readOnly
                      disabled={locked}
                      aria-label={`Pilih ${r.broker_code}`}
                    />
                  </td>
                  <td>
                    <span className={styles.brokerCode}>{r.broker_code}</span>
                    <span className={styles.brokerName}>{r.broker_name}</span>
                  </td>
                  <td className={`${styles.num} ${valClass(r.nval)}`}>
                    {formatRpShort(r.nval)}
                  </td>
                  <td className={`${styles.num} ${valClass(r.nvol)}`}>
                    {formatNumber(Math.round(r.nvol / 100))}
                  </td>
                  <td className={`${styles.num} ${styles.mono}`}>
                    {r.bvol ? formatPrice(r.bval / r.bvol) : "–"}
                  </td>
                  <td className={`${styles.num} ${styles.mono}`}>
                    {r.svol ? formatPrice(r.sval / r.svol) : "–"}
                  </td>
                  <td>
                    {isTracked ? (
                      <span className={styles.chipTracked}>sudah tracking</span>
                    ) : isChecked ? (
                      <span className={styles.chipNew}>dipilih</span>
                    ) : (
                      <span className={styles.muted}>–</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={7} className={styles.emptyCell}>
                  Tidak ada broker di tab ini.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className={styles.selectionBar}>
        <div>
          <b>{checked.length}</b> broker dipilih
          <span className={styles.selectionHint}>
            {picker.mode === "add"
              ? ` · ${checked.filter((c) => !trackedCodes.has(c)).length} broker baru`
              : " · akan menjadi posisi awal"}
          </span>
        </div>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={onCommit}
          disabled={!checked.length}
        >
          {commitLabel}
        </button>
      </div>
    </section>
  );
}

// ================= Timeline =================
function StageTimeline({ stages, active, onUpdate, onDelete }) {
  return (
    <section className={styles.timelineCard}>
      <div className={styles.timelineHead}>
        <h2 className={styles.cardTitle}>Alur tahap</h2>
        <span className={styles.cardSub}>
          Klik “Lihat update” untuk melihat perubahan posisi. Hapus selalu dari tahap
          terakhir; perhitungan otomatis kembali ke tahap sebelumnya.
        </span>
      </div>
      <div className={styles.timeline}>
        {stages.map((s, i) => {
          const meta = stageMeta(s.type);
          const isLast = i === stages.length - 1;
          const canDelete = isLast && stages.length > 1;
          const deleteTitle = canDelete
            ? "Hapus tahap ini dan kembali ke tahap sebelumnya"
            : isLast
              ? "Tahap awal tidak bisa dihapus"
              : "Hapus tahap terakhir dulu";
          return (
            <div
              key={s.id || `${s.start}-${i}`}
              className={`${styles.stageCard} ${active === i ? styles.stageActive : ""}`}
              style={{ "--stage-color": meta.color }}
            >
              <div className={styles.stageTop}>
                <span className={styles.stageIndex}>Tahap {i + 1}</span>
                <span className={styles.stageType} style={{ color: meta.color }} title={meta.description}>
                  {meta.emoji} {meta.label}
                </span>
              </div>
              <div className={styles.stageDate}>
                {fmtDate(s.start)} – {fmtDate(s.end)}
              </div>
              <div className={styles.stageClose}>
                Close <b>{formatPrice(s.close)}</b>
              </div>
              <div className={styles.stageActions}>
                <button type="button" className={styles.btnGhostSm} onClick={() => onUpdate(i)}>
                  Lihat update
                </button>
                <button
                  type="button"
                  className={styles.btnTrash}
                  onClick={() => onDelete(i)}
                  disabled={!canDelete}
                  title={deleteTitle}
                  aria-label={deleteTitle}
                >
                  🗑
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ================= Update =================
function UpdatePanel({ stage, index, changes, summary, onClose }) {
  const meta = stageMeta(stage.type);
  const counts = summarizeBadges(changes);
  const rows = useMemo(
    () => [...changes].sort((a, b) => Math.abs(b.deltaShares) - Math.abs(a.deltaShares)),
    [changes]
  );

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.pickerTitleRow}>
            <span className={styles.stageDot} style={{ background: meta.color }} />
            <h2 className={styles.cardTitle}>
              Update tahap {index + 1} · {meta.label}
            </h2>
          </div>
          <p className={styles.cardSub}>
            {fmtDate(stage.start)}–{fmtDate(stage.end)} · close{" "}
            {formatPrice(stage.close)} · perubahan vs tahap sebelumnya
          </p>
        </div>
        <button type="button" className={styles.btnGhostSm} onClick={onClose}>
          Tutup
        </button>
      </div>

      <div className={styles.updateChips}>
        <span className={styles.chipWarn}>AVG DOWN {counts.avg_down}</span>
        <span className={styles.chipBad}>TRIM CUTLOSS {counts.trim_cutloss}</span>
        <span className={styles.chipGood}>FRESH ACCUM {counts.fresh_accum}</span>
        <span className={styles.chipGood}>TAKE PROFIT {counts.take_profit}</span>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Broker</th>
              <th className={styles.num}>Aliran tahap</th>
              <th className={styles.num}>Posisi</th>
              <th className={styles.num}>AVG</th>
              <th className={styles.num}>Floating</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const row = summary?.get(r.code);
              const isNew = r.entry === index && index > 0;
              return (
                <tr key={r.code}>
                  <td>
                    <span className={styles.brokerCode}>{r.code}</span>
                    <span className={styles.brokerName}>{r.name}</span>
                    {isNew && <span className={styles.chipNew}>baru</span>}
                  </td>
                  <td className={`${styles.num} ${valClass(r.deltaShares)}`}>
                    <b>{signed(r.deltaShares / 100, 0)} lot</b>
                    <div className={styles.sub}>{row ? formatRpShort(row.nval) : "–"}</div>
                  </td>
                  <td className={`${styles.num} ${styles.mono}`}>
                    {formatNumber(lotsOf(r.beforeShares))} →{" "}
                    <b>{formatNumber(lotsOf(r.shares))}</b>
                  </td>
                  <td className={`${styles.num} ${styles.mono}`}>
                    {r.avg == null ? "–" : formatPrice(r.avg)}
                    {r.deltaAvg != null && Math.abs(r.deltaAvg) >= 0.05 && (
                      <div className={`${styles.sub} ${valClass(r.deltaAvg)}`}>
                        {signed(r.deltaAvg, 1)}
                      </div>
                    )}
                  </td>
                  <td className={`${styles.num} ${valClass(r.floatingIdr)}`}>
                    <b>{signedRp(r.floatingIdr)}</b>
                    <div className={styles.sub}>{formatPct(r.floatingPct, 2)}</div>
                  </td>
                  <td>
                    <Badge badge={r.badge} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ================= Position table =================
function PositionTable({ rows, closing, closingDate, total, sortBy, setSortBy }) {
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>Posisi broker</h2>
          <p className={styles.cardSub}>
            Closing {formatPrice(closing)} ({fmtDate(closingDate)}) · AVG = FIFO lot beli
            yang tersisa.
          </p>
        </div>
        <label className={styles.sortField}>
          <span>Urut</span>
          <select
            className={styles.selectSm}
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="shares">Posisi</option>
            <option value="floating">Floating</option>
            <option value="avg">AVG</option>
            <option value="code">Kode</option>
          </select>
        </label>
      </div>

      <div className={styles.tableWrap}>
        <table className={`${styles.table} ${styles.positionTable}`}>
          <thead>
            <tr>
              <th>Kode</th>
              <th>Badge</th>
              <th className={styles.num}>Akum</th>
              <th className={styles.num}>Dist</th>
              <th className={styles.num}>AVG</th>
              <th className={styles.num}>Closing</th>
              <th className={styles.num}>Floating Point</th>
              <th className={styles.num}>Floating %</th>
              <th className={styles.num}>Floating IDR</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const lots = Math.abs(lotsOf(r.shares));
              const isDist = r.lastDir < 0 || r.side === "short";
              return (
                <tr key={r.code}>
                  <td>
                    <span className={styles.brokerCode}>{r.code}</span>
                    <span className={styles.brokerName}>{r.name}</span>
                  </td>
                  <td>
                    <Badge badge={r.badge} />
                  </td>
                  <td className={`${styles.num} ${styles.mono}`}>
                    {!isDist && lots ? formatNumber(lots) : "–"}
                  </td>
                  <td className={`${styles.num} ${styles.mono}`}>
                    {isDist && lots ? formatNumber(lots) : "–"}
                  </td>
                  <td className={`${styles.num} ${styles.mono}`}>
                    {r.avg == null ? "–" : formatPrice(r.avg)}
                  </td>
                  <td className={`${styles.num} ${styles.mono}`}>
                    {formatPrice(closing)}
                  </td>
                  <td className={`${styles.num} ${valClass(r.floatingPoint)}`}>
                    <b>{signed(r.floatingPoint, 1)}</b>
                  </td>
                  <td className={`${styles.num} ${valClass(r.floatingPct)}`}>
                    {formatPct(r.floatingPct, 2)}
                  </td>
                  <td className={`${styles.num} ${valClass(r.floatingIdr)}`}>
                    <b>{signedRp(r.floatingIdr)}</b>
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={9} className={styles.emptyCell}>
                  Belum ada broker yang di-tracking.
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={8} className={styles.footLabel}>
                  Total floating {rows.length} broker
                </td>
                <td className={`${styles.num} ${valClass(total)}`}>
                  <b>{signedRp(total)}</b>
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p className={styles.note}>
        AKUM/DIST mengikuti arah tahap terakhir. Nilai minus = floating loss; hijau =
        profit. Ini inferensi dari data net broker, bukan rekomendasi beli/jual.
      </p>
    </section>
  );
}

function Badge({ badge }) {
  return (
    <span
      className={`${styles.badge} ${styles[`badge_${badge.tone}`]}`}
      title={badge.description || badge.label}
      aria-label={`${badge.label}: ${badge.description || ""}`}
    >
      {badge.label}
    </span>
  );
}

function InfoDot({ text }) {
  return (
    <span className={styles.infoDot} title={text} aria-label={text} role="img">
      ⓘ
    </span>
  );
}

function formatRpShort(n) {
  if (n == null || Number.isNaN(n)) return "–";
  const abs = Math.abs(n);
  const fmt = (v, d) =>
    v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
  let body;
  if (abs >= 1e12) body = `${fmt(abs / 1e12, 2)} T`;
  else if (abs >= 1e9) body = `${fmt(abs / 1e9, 2)} M`;
  else if (abs >= 1e6) body = `${fmt(abs / 1e6, 1)} jt`;
  else if (abs >= 1e3) body = `${fmt(abs / 1e3, 1)} rb`;
  else body = fmt(abs, 0);
  return `${n < 0 ? "−" : ""}Rp ${body}`;
}
