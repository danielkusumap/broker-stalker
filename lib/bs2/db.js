// Penyimpanan lokal Broker Stalker v2 — SQLite bawaan Node (tanpa dependency).
// Tujuan: data historis broker cukup diambil sekali dari API, lalu dipakai ulang.
//
// Database di sini hanya CACHE. Kalau gagal dibuka (folder read-only, mount
// milik root, disk penuh, dsb) aplikasi harus tetap jalan dengan mengambil
// data langsung dari API — bukan menggagalkan request.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIGURED_PATH =
  process.env.BS2_DB_PATH || path.join(process.cwd(), "data", "market.db");

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS broker_summary (
    stock TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    broker TEXT NOT NULL,
    name TEXT,
    bval REAL, bvol REAL, sval REAL, svol REAL, nval REAL, nvol REAL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (stock, start_date, end_date, broker)
  );
  CREATE TABLE IF NOT EXISTS broker_daily (
    stock TEXT NOT NULL,
    date TEXT NOT NULL,
    broker TEXT NOT NULL,
    name TEXT,
    nval REAL, nvol REAL, bavg REAL, savg REAL, cum_nval REAL,
    PRIMARY KEY (stock, date, broker)
  );
  CREATE TABLE IF NOT EXISTS price_daily (
    stock TEXT NOT NULL,
    date TEXT NOT NULL,
    close REAL, change REAL, change_pct REAL,
    value REAL, volume REAL, freq INTEGER,
    open REAL, high REAL, low REAL, avg REAL,
    PRIMARY KEY (stock, date)
  );
  CREATE INDEX IF NOT EXISTS idx_summary_range ON broker_summary (stock, start_date, end_date);
  CREATE INDEX IF NOT EXISTS idx_daily_range ON broker_daily (stock, date);
  CREATE INDEX IF NOT EXISTS idx_price_range ON price_daily (stock, date);
`;

let resolvedPath = null;
let exhausted = false;
let connection = null;

let lastError = null;

// Folder harus benar-benar bisa ditulis, bukan cuma ada.
function ensureWritableDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.probe-${process.pid}`);
  fs.writeFileSync(probe, "");
  fs.unlinkSync(probe);
}

function candidates() {
  return [
    CONFIGURED_PATH,
    // Cadangan: filesystem sementara container. Data tidak persisten,
    // tapi aplikasi tetap bisa jalan.
    path.join(os.tmpdir(), "broker-stalker", "market.db"),
  ];
}

function resolvePath() {
  if (resolvedPath) return resolvedPath;
  if (exhausted) return null;

  for (const candidate of candidates()) {
    try {
      ensureWritableDir(path.dirname(candidate));
      resolvedPath = candidate;
      if (candidate !== CONFIGURED_PATH) {
        console.warn(
          `[bs2/db] ${CONFIGURED_PATH} tidak bisa ditulis, pakai ${candidate} (cache sementara).`
        );
      }
      return resolvedPath;
    } catch (err) {
      lastError = err;
    }
  }

  exhausted = true;
  console.error(
    `[bs2/db] tidak ada folder yang bisa ditulis untuk database. ` +
      `Cache dimatikan; semua data diambil langsung dari API. ` +
      `Penyebab terakhir: ${lastError?.message || "tidak diketahui"}`
  );
  return null;
}

function open() {
  if (connection) return connection;
  const dbFile = resolvePath();
  if (!dbFile) return null;

  try {
    const db = new DatabaseSync(dbFile);
    db.exec(SCHEMA);
    connection = db;
    return connection;
  } catch (err) {
    // Jangan biarkan satu kegagalan SQLite menjatuhkan seluruh request.
    exhausted = true;
    lastError = err;
    console.error(`[bs2/db] gagal membuka ${dbFile}: ${err?.message || err}`);
    return null;
  }
}

export function getSummary(stock, start, end) {
  const db = open();
  if (!db) return null;
  try {
    const rows = db
      .prepare(
        `SELECT broker AS broker_code, name AS broker_name, bval, bvol, sval, svol, nval, nvol
         FROM broker_summary WHERE stock = ? AND start_date = ? AND end_date = ?`
      )
      .all(stock, start, end);
    return rows.length ? rows : null;
  } catch (err) {
    console.error(`[bs2/db] getSummary gagal: ${err?.message || err}`);
    return null;
  }
}

export function saveSummary(stock, start, end, rows) {
  const db = open();
  if (!db || !rows?.length) return false;
  try {
    const stmt = db.prepare(
      `INSERT INTO broker_summary
         (stock, start_date, end_date, broker, name, bval, bvol, sval, svol, nval, nvol, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.exec("BEGIN");
    try {
      db.prepare(
        "DELETE FROM broker_summary WHERE stock = ? AND start_date = ? AND end_date = ?"
      ).run(stock, start, end);
      const now = Date.now();
      for (const r of rows) {
        stmt.run(
          stock,
          start,
          end,
          r.broker_code,
          r.broker_name || null,
          r.bval || 0,
          r.bvol || 0,
          r.sval || 0,
          r.svol || 0,
          r.nval || 0,
          r.nvol || 0,
          now
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return true;
  } catch (err) {
    console.error(`[bs2/db] saveSummary gagal: ${err?.message || err}`);
    return false;
  }
}

export function getDaily(stock, start, end) {
  const db = open();
  if (!db) return null;
  try {
    const rows = db
      .prepare(
        `SELECT date, broker AS broker_code, name AS broker_name, nval, nvol, bavg, savg, cum_nval
         FROM broker_daily WHERE stock = ? AND date >= ? AND date <= ? ORDER BY date ASC, broker ASC`
      )
      .all(stock, start, end);
    return rows.length ? rows : null;
  } catch (err) {
    console.error(`[bs2/db] getDaily gagal: ${err?.message || err}`);
    return null;
  }
}

export function saveDaily(stock, series) {
  const db = open();
  if (!db || !series?.length) return false;
  try {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO broker_daily
         (stock, date, broker, name, nval, nvol, bavg, savg, cum_nval)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.exec("BEGIN");
    try {
      for (const s of series) {
        for (const p of s.points || []) {
          stmt.run(
            stock,
            p.date,
            s.broker_code,
            s.broker_name || null,
            p.nval ?? 0,
            p.nvol ?? 0,
            p.bavg ?? null,
            p.savg ?? null,
            p.cum_nval ?? null
          );
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return true;
  } catch (err) {
    console.error(`[bs2/db] saveDaily gagal: ${err?.message || err}`);
    return false;
  }
}

export function getHistory(stock, start, end) {
  const db = open();
  if (!db) return null;
  try {
    const rows = db
      .prepare(
        `SELECT date, close, change, change_pct, value, volume, freq, open, high, low, avg
         FROM price_daily WHERE stock = ? AND date >= ? AND date <= ? ORDER BY date ASC`
      )
      .all(stock, start, end);
    return rows.length ? rows : null;
  } catch (err) {
    console.error(`[bs2/db] getHistory gagal: ${err?.message || err}`);
    return null;
  }
}

export function saveHistory(stock, rows) {
  const db = open();
  if (!db || !rows?.length) return false;
  try {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO price_daily
         (stock, date, close, change, change_pct, value, volume, freq, open, high, low, avg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.exec("BEGIN");
    try {
      for (const r of rows) {
        stmt.run(
          stock,
          r.date,
          r.close ?? null,
          r.change ?? null,
          r.change_pct ?? null,
          r.value ?? null,
          r.volume ?? null,
          r.freq ?? null,
          r.open ?? null,
          r.high ?? null,
          r.low ?? null,
          r.avg ?? null
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return true;
  } catch (err) {
    console.error(`[bs2/db] saveHistory gagal: ${err?.message || err}`);
    return false;
  }
}

export function getClose(stock, start, end) {
  const db = open();
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT date, close FROM price_daily
         WHERE stock = ? AND date >= ? AND date <= ?
         ORDER BY date DESC LIMIT 1`
      )
      .get(stock, start, end);
    return row || null;
  } catch (err) {
    console.error(`[bs2/db] getClose gagal: ${err?.message || err}`);
    return null;
  }
}

// null = cache sedang tidak tersedia (bukan berarti error fatal).
export function dbPath() {
  return connection ? resolvedPath : null;
}
