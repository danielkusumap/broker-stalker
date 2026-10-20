// Penyimpanan lokal Broker Stalker v2 — SQLite bawaan Node (tanpa dependency).
// Tujuan: data historis broker cukup diambil sekali dari API, lalu dipakai ulang.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.BS2_DB_PATH || path.join(process.cwd(), "data", "market.db");

function open() {
  if (globalThis.__bs2db) return globalThis.__bs2db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
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
  `);
  globalThis.__bs2db = db;
  return db;
}

export function getSummary(stock, start, end) {
  const rows = open()
    .prepare(
      `SELECT broker AS broker_code, name AS broker_name, bval, bvol, sval, svol, nval, nvol
       FROM broker_summary WHERE stock = ? AND start_date = ? AND end_date = ?`
    )
    .all(stock, start, end);
  return rows.length ? rows : null;
}

export function saveSummary(stock, start, end, rows) {
  const db = open();
  const stmt = db.prepare(
    `INSERT INTO broker_summary
       (stock, start_date, end_date, broker, name, bval, bvol, sval, svol, nval, nvol, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM broker_summary WHERE stock = ? AND start_date = ? AND end_date = ?").run(
      stock,
      start,
      end
    );
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
}

export function getDaily(stock, start, end) {
  const rows = open()
    .prepare(
      `SELECT date, broker AS broker_code, name AS broker_name, nval, nvol, bavg, savg, cum_nval
       FROM broker_daily WHERE stock = ? AND date >= ? AND date <= ? ORDER BY date ASC, broker ASC`
    )
    .all(stock, start, end);
  return rows.length ? rows : null;
}

export function saveDaily(stock, series) {
  const db = open();
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
}

export function getHistory(stock, start, end) {
  const rows = open()
    .prepare(
      `SELECT date, close, change, change_pct, value, volume, freq, open, high, low, avg
       FROM price_daily WHERE stock = ? AND date >= ? AND date <= ? ORDER BY date ASC`
    )
    .all(stock, start, end);
  return rows.length ? rows : null;
}

export function saveHistory(stock, rows) {
  const db = open();
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
}

export function getClose(stock, start, end) {
  const row = open()
    .prepare(
      `SELECT date, close FROM price_daily
       WHERE stock = ? AND date >= ? AND date <= ?
       ORDER BY date DESC LIMIT 1`
    )
    .get(stock, start, end);
  return row || null;
}

export function dbPath() {
  return DB_PATH;
}
