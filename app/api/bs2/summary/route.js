import { getSummary, saveSummary, getHistory, saveHistory, getClose, dbPath } from "../../../../lib/bs2/db";
import { fetchSummary, fetchHistory } from "../../../../lib/bs2/upstream";

const isCode = (v) => /^[A-Z0-9]{4}$/.test(v || "");
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "");

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const code = (searchParams.get("code") || "").toUpperCase();
  const start = searchParams.get("start") || "";
  const end = searchParams.get("end") || "";

  if (!isCode(code)) {
    return Response.json({ error: "Kode saham harus 4 huruf/angka." }, { status: 400 });
  }
  if (!isDate(start) || !isDate(end) || start > end) {
    return Response.json({ error: "Rentang tanggal tidak valid." }, { status: 400 });
  }

  try {
    let source = "db";
    let brokers = getSummary(code, start, end);
    if (!brokers) {
      brokers = await fetchSummary(code, start, end);
      if (!brokers.length) {
        return Response.json(
          { error: `Tidak ada data broker untuk ${code} pada rentang itu.` },
          { status: 404 }
        );
      }
      saveSummary(code, start, end, brokers);
      source = "api";
    }

    // Close di akhir tahap — dari riwayat harga yang tersimpan.
    let history = getHistory(code, start, end);
    if (!history) {
      const rows = await fetchHistory(code, start, end);
      if (rows.length) saveHistory(code, rows);
      // Kalau cache mati, tetap pakai hasil API apa adanya.
      history = rows.length ? rows : getHistory(code, start, end);
    }

    // Ambil close dari cache; kalau cache tidak tersedia, hitung dari riwayat.
    let last = getClose(code, start, end);
    if (!last && history?.length) {
      const sorted = [...history].sort((a, b) => (a.date < b.date ? -1 : 1));
      const tail = sorted[sorted.length - 1];
      last = { date: tail.date, close: tail.close ?? null };
    }

    return Response.json({
      code,
      start_date: start,
      end_date: end,
      close: last?.close ?? null,
      close_date: last?.date ?? null,
      brokers,
      source,
      db: dbPath() || "nonaktif",
    });
  } catch (err) {
    console.error(`[bs2/summary] ${code} ${start}..${end}: ${err?.message || err}`);
    return Response.json(
      {
        error: err.message || "Gagal memuat data broker.",
        code,
        start_date: start,
        end_date: end,
      },
      { status: 502 }
    );
  }
}
