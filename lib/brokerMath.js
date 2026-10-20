// Perhitungan murni Broker Stalker — tanpa dependensi UI/network.
// Semua fungsi menerima data yang sudah di-fetch dan mengembalikan angka siap tampil.

/**
 * Derive gross buy/sell per hari dari net + harga rata-rata.
 * Rumus: nval = bvol*bavg − svol*savg  dan  nvol = bvol − svol
 *   → bvol = (nval − nvol*savg) / (bavg − savg)
 * Fallback net-only (rough=true) kalau angka tidak stabil / tidak masuk akal.
 */
export function deriveGross(point) {
  const { nval = 0, nvol = 0, bavg = null, savg = null } = point;

  // Tidak ada transaksi sama sekali hari itu.
  if (!nvol && !nval) return { bvol: 0, svol: 0, rough: false };

  // Hari murni beli / murni jual (salah satu avg null = sisi itu tidak ada).
  if (savg == null && bavg == null) {
    return nvol >= 0
      ? { bvol: nvol, svol: 0, rough: nvol !== 0 }
      : { bvol: 0, svol: -nvol, rough: true };
  }
  if (savg == null) {
    return nvol >= 0
      ? { bvol: nvol, svol: 0, rough: false }
      : { bvol: 0, svol: -nvol, rough: true }; // net jual tapi tak ada savg → data aneh
  }
  if (bavg == null) {
    return nvol <= 0
      ? { bvol: 0, svol: -nvol, rough: false }
      : { bvol: nvol, svol: 0, rough: true }; // net beli tapi tak ada bavg → data aneh
  }

  const diff = bavg - savg;
  const eps = Math.max(0.05, Math.abs(bavg) * 1e-5); // pembulatan bavg/savg
  if (Math.abs(diff) < eps) {
    // Harga beli ≈ harga jual → penyebut hampir nol, hasil tidak stabil.
    return nvol >= 0
      ? { bvol: nvol, svol: 0, rough: true }
      : { bvol: 0, svol: -nvol, rough: true };
  }

  const bvol = (nval - nvol * savg) / diff;
  const svol = bvol - nvol;
  // Guard: volume kotor tidak boleh negatif atau melebihi 100x net (noise pembulatan).
  if (bvol < -1 || svol < -1 || bvol + svol > Math.max(Math.abs(nvol), 1) * 100 + 1) {
    return nvol >= 0
      ? { bvol: nvol, svol: 0, rough: true }
      : { bvol: 0, svol: -nvol, rough: true };
  }
  return { bvol: Math.max(bvol, 0), svol: Math.max(svol, 0), rough: false };
}

/**
 * Average-cost matching untuk SATU broker sepanjang rentang (urut tanggal naik).
 * Mengembalikan posisi akhir, avg cost, realized, peak, timeline harian, dan warning.
 */
export function matchInventory(points) {
  const sorted = [...points].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let shares = 0;
  let avgCost = 0;
  let realized = 0;
  let peak = 0;
  let sellBeforePosition = false;
  let roughDays = 0;
  let invested = 0; // total nilai beli kumulatif (untuk info)

  const timeline = [];

  for (const p of sorted) {
    const { bvol, svol, rough } = deriveGross(p);
    if (rough) roughDays += 1;

    const sharesBefore = shares;
    let costAtSell = null; // avg cost saat menjual (setelah beli hari itu)
    let sellQty = 0;
    let sellPrice = null;
    let realizedDay = 0;
    let outsideQty = 0;

    if (bvol > 0 && p.bavg != null) {
      invested += bvol * p.bavg;
      avgCost = (shares * avgCost + bvol * p.bavg) / (shares + bvol);
      shares += bvol;
    }
    if (svol > 0) {
      sellPrice = p.savg ?? p.bavg ?? avgCost;
      sellQty = Math.min(svol, shares);
      outsideQty = Math.max(0, svol - shares);
      if (svol > shares + 1) sellBeforePosition = true;
      if (sellQty > 0) {
        costAtSell = avgCost;
        realizedDay = sellQty * (sellPrice - costAtSell);
        realized += realizedDay;
        shares -= sellQty;
      }
    }
    if (shares > peak) peak = shares;

    timeline.push({
      date: p.date,
      shares,
      avgCost,
      realized,
      nval: p.nval || 0,
      nvol: p.nvol || 0,
      // detail hari — dipakai ledger realisasi
      bvol,
      svol,
      bavg: p.bavg ?? null,
      savg: p.savg ?? null,
      rough,
      sharesBefore,
      sellQty,
      sellPrice,
      costAtSell,
      realizedDay,
      outsideQty,
    });
  }

  const warnings = [];
  if (sellBeforePosition) {
    warnings.push(
      "Ada penjualan melebihi posisi yang terpantau — posisi broker terbentuk SEBELUM tanggal mulai. Mundurkan tanggal mulai untuk hitungan lebih akurat."
    );
  }
  if (roughDays > 0) {
    warnings.push(
      `${roughDays} hari memakai estimasi gross kasar (bavg ≈ savg atau data tidak lengkap).`
    );
  }

  const netVal = timeline.reduce((s, t) => s + t.nval, 0);

  return {
    shares,
    avgCost,
    realized,
    peak,
    timeline,
    warnings,
    invested,
    roughDays,
    netVal,
    totalDays: sorted.length,
  };
}

/**
 * Statistik per fase: fase1 = tanggal < splitDate, fase2 = tanggal >= splitDate.
 * netVol2 = perubahan posisi selama fase 2 (positif = nambah barang).
 */
export function phaseStats(timeline, splitDate) {
  const f1 = timeline.filter((t) => t.date < splitDate);
  const f2 = timeline.filter((t) => t.date >= splitDate);

  const sharesEndF1 = f1.length ? f1[f1.length - 1].shares : 0;
  const sharesEnd = timeline.length ? timeline[timeline.length - 1].shares : 0;
  const peakF1 = f1.reduce((m, t) => Math.max(m, t.shares), 0);
  const peakAll = timeline.reduce((m, t) => Math.max(m, t.shares), 0);
  const netVol2 = sharesEnd - sharesEndF1;
  const netVal2 = f2.reduce((s, t) => s + t.nval, 0);
  // realisasi dipecah per fase + lembar yang terjual per fase
  const realizedEndF1 = f1.length ? f1[f1.length - 1].realized : 0;
  const realizedTotal = timeline.length ? timeline[timeline.length - 1].realized : 0;

  return {
    f1Days: f1.length,
    f2Days: f2.length,
    sharesEndF1,
    sharesEnd,
    peakF1,
    peakAll,
    netVol2,
    netVal2,
    realizedF1: realizedEndF1,
    realizedF2: realizedTotal - realizedEndF1,
    soldF1: f1.reduce((s, t) => s + t.sellQty, 0),
    soldF2: f2.reduce((s, t) => s + t.sellQty, 0),
    active2: f2.some((t) => t.nvol !== 0 || t.nval !== 0),
  };
}

/**
 * Klasifikasi fase 2 per broker (lihat plan.md §5d):
 *   ACCUMULATE  : net beli fase 2, posisi naik
 *   TRIMMING    : net jual, sisa ≥ 50% peak fase 1
 *   DISTRIBUSI  : net jual besar, sisa < 50% peak (atau keluar total)
 *   FLAT        : tak ada aktivitas berarti di fase 2
 */
export function classify(phase) {
  const { active2, netVol2, peakF1, peakAll, sharesEnd } = phase;
  const peak = Math.max(peakF1, 0);
  const flatThreshold = Math.max(peak, 1) * 0.01; // ≤1% peak = dianggap diam

  if (!active2 || Math.abs(netVol2) <= flatThreshold) {
    return { key: "flat", label: "FLAT", emoji: "⚪", color: "#94a3b8" };
  }
  if (netVol2 > 0) {
    return { key: "accumulate", label: "LAGI KUMPUL", emoji: "🟢", color: "#22c55e" };
  }
  // net jual
  const remainRatio = peakAll > 0 ? sharesEnd / peakAll : 0;
  if (sharesEnd <= 0 || remainRatio < 0.5) {
    return { key: "distribusi", label: "DISTRIBUSI", emoji: "🔴", color: "#ef4444" };
  }
  return { key: "trimming", label: "TRIMMING", emoji: "🟡", color: "#eab308" };
}

/** Ubah points mentah API jadi hasil analisa lengkap 1 broker. */
export function analyzeBroker(series, splitDate, lastPrice) {
  const points = series.points || [];
  const inv = matchInventory(points);
  const phase = phaseStats(inv.timeline, splitDate);
  const fase = classify(phase);

  const unrealized =
    inv.shares > 0 && lastPrice != null ? inv.shares * (lastPrice - inv.avgCost) : 0;
  const marketValue = inv.shares > 0 && lastPrice != null ? inv.shares * lastPrice : 0;
  const unrealPct =
    inv.shares > 0 && inv.avgCost > 0 && lastPrice != null
      ? ((lastPrice - inv.avgCost) / inv.avgCost) * 100
      : null;

  // Ledger realisasi: tiap hari ada penjualan yang tercatat.
  const ledger = inv.timeline
    .filter((t) => t.sellQty > 0)
    .map((t) => ({
      date: t.date,
      qty: t.sellQty,
      price: t.sellPrice,
      cost: t.costAtSell,
      realizedDay: t.realizedDay,
      realizedCum: t.realized,
      rough: t.rough,
      outsideQty: t.outsideQty,
      sharesAfter: t.shares,
    }));
  const soldTotal = ledger.reduce((s, l) => s + l.qty, 0);
  const sellValue = ledger.reduce((s, l) => s + l.qty * (l.price || 0), 0);

  return {
    code: series.broker_code,
    name: series.broker_name || series.broker_code,
    shares: inv.shares,
    avgCost: inv.avgCost,
    realized: inv.realized,
    peak: inv.peak,
    invested: inv.invested,
    netVal: inv.netVal,
    totalDays: inv.totalDays,
    roughDays: inv.roughDays,
    // detail realisasi
    ledger,
    sellDays: ledger.length,
    soldTotal,
    avgSellPrice: soldTotal > 0 ? sellValue / soldTotal : null,
    // pembacaan fase: sudah dijual berapa % dari peak & untung realisasi vs modal beli
    soldPctPeak: inv.peak > 0 ? (soldTotal / inv.peak) * 100 : null,
    returnOnInvested: inv.invested > 0 ? (inv.realized / inv.invested) * 100 : null,
    realizedF1: phase.realizedF1,
    realizedF2: phase.realizedF2,
    soldF1: phase.soldF1,
    soldF2: phase.soldF2,
    outsideTotal: inv.timeline.reduce((s, t) => s + t.outsideQty, 0),
    // keyakinan: makin sedikit hari gross kasar, makin tinggi
    confidence:
      inv.totalDays > 0 ? Math.max(0, Math.round((1 - inv.roughDays / inv.totalDays) * 100)) : 0,
    marketValue,
    unrealized,
    unrealPct,
    timeline: inv.timeline,
    warnings: inv.warnings,
    phase,
    fase,
    lastPrice,
  };
}

/** % perubahan harga antara dua tanggal (dari rows history urut tanggal naik). */
export function priceChangeBetween(historyRows, fromDate, toDate) {
  const rows = historyRows.filter((r) => r.date >= fromDate && r.date <= toDate);
  if (rows.length < 2) return null;
  const first = rows[0].close;
  const last = rows[rows.length - 1].close;
  if (!first) return null;
  return { pct: ((last - first) / first) * 100, from: rows[0].date, to: rows[rows.length - 1].date };
}

// ---------- format ----------

export function formatNumber(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return "–";
  return n.toLocaleString("id-ID", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function formatShares(shares) {
  if (shares == null || Number.isNaN(shares)) return "–";
  const rounded = Math.round(shares);
  if (Math.abs(rounded) < 1000) return `${rounded} lbr`;
  return `${formatNumber(rounded)} lbr`;
}

export function formatLot(shares) {
  const lots = Math.round(shares / 100);
  if (Math.abs(lots) < 1) return "–";
  return `${formatNumber(lots)} lot`;
}

/** Rupiah ringkas: 1,2 rb / 3,4 jt / 5,6 M / 7,8 T */
export function formatRp(n, withSign = false) {
  if (n == null || Number.isNaN(n)) return "–";
  const sign = n < 0 ? "−" : withSign ? "+" : "";
  const abs = Math.abs(n);
  const fmt = (v, d) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
  if (abs >= 1e12) return `${sign}Rp ${fmt(abs / 1e12, 2)} T`;
  if (abs >= 1e9) return `${sign}Rp ${fmt(abs / 1e9, 2)} M`;
  if (abs >= 1e6) return `${sign}Rp ${fmt(abs / 1e6, 1)} jt`;
  if (abs >= 1e3) return `${sign}Rp ${fmt(abs / 1e3, 1)} rb`;
  return `${sign}Rp ${fmt(abs, 0)}`;
}

export function formatPct(n, digits = 1, withSign = true) {
  if (n == null || Number.isNaN(n)) return "–";
  const sign = withSign && n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

export function formatPrice(n) {
  if (n == null || Number.isNaN(n)) return "–";
  return n.toLocaleString("id-ID", { maximumFractionDigits: 2 });
}

// ---- Usul batas fase otomatis (change-point detection, tanpa fetch) ----
// netByDate: { "YYYY-MM-DD": netValue gabungan broker terpilih }.
// Ide: rolling 5-hari → cari perubahan tanda TERAKHIR; di situ arah uang berubah,
// tanggal itu diusulkan sebagai awal Fase 2 (tracking).
export function suggestSplitDate(dates, netByDate) {
  if (!dates || dates.length < 12) return null;
  const W = 5;
  const roll = dates.map((_, i) => {
    let s = 0;
    for (let j = Math.max(0, i - W + 1); j <= i; j++) s += netByDate[dates[j]] || 0;
    return s;
  });
  const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  let lastFlip = null;
  for (let i = 1; i < roll.length; i++) {
    const a = sgn(roll[i - 1]);
    const b = sgn(roll[i]);
    if (a !== 0 && b !== 0 && a !== b) lastFlip = i;
  }
  return lastFlip == null ? null : dates[lastFlip];
}

// Intensitas: berapa % nilai transaksi harian emiten itu yang di-net oleh broker.
// totalValue = jumlah nilai transaksi (rupiah) pada rentang yang sama (dari history).
export function intensityPct(netVal, totalValue) {
  if (!totalValue || totalValue <= 0 || netVal == null) return null;
  return (netVal / totalValue) * 100;
}

// ---- Export CSV ledger realisasi (baris per hari jual) ----
export function ledgerToCsv(results, meta = {}) {
  const head = [
    "broker", "nama", "tanggal", "terjual_lbr", "harga_jual", "avg_cost",
    "realized_hari_itu", "realized_kumulatif", "estimasi_kasar", "di_luar_rentang_lbr",
  ];
  const lines = [head.join(";")];
  for (const r of results) {
    for (const l of r.ledger || []) {
      lines.push([
        r.code,
        String(r.name || "").replace(/;/g, ","),
        l.date,
        Math.round(l.qty),
        l.price ?? "",
        l.cost ?? "",
        Math.round(l.realizedDay),
        Math.round(l.realizedCum),
        l.rough ? "ya" : "",
        Math.round(l.outsideQty || 0),
      ].join(";"));
    }
  }
  if (meta.code) {
    lines.push("");
    lines.push(`Ticker;${meta.code}`);
    lines.push(`Rentang;${meta.start || ""} s/d ${meta.end || ""}`);
  }
  return lines.join("\n");
}

// ---- Export CSV (pemisah titik-koma; Excel lokal ID aman) ----
export function resultsToCsv(results, meta = {}) {
  const head = [
    "broker", "nama", "sisa_barang_lbr", "avg_cost", "harga",
    "unrealized_rp", "realized_rp", "net_fase2_lbr", "net_fase2_rp",
    "fase", "peak_lbr", "confidence_pct",
  ];
  const lines = [head.join(";")];
  for (const r of results) {
    lines.push([
      r.code,
      String(r.name || "").replace(/;/g, ","),
      Math.round(r.shares),
      r.shares > 0 ? r.avgCost : "",
      r.lastPrice ?? "",
      r.shares > 0 ? Math.round(r.unrealized) : "",
      Math.round(r.realized || 0),
      Math.round(r.phase.netVol2),
      Math.round(r.phase.netVal2),
      r.fase.label,
      Math.round(r.peak),
      r.confidence,
    ].join(";"));
  }
  if (meta.code) {
    lines.push("");
    lines.push(`Ticker;${meta.code}`);
    lines.push(`Rentang;${meta.start || ""} s/d ${meta.end || ""}`);
    lines.push(`Batas fase;${meta.split || "-"}`);
    lines.push(`Harga dipakai;${meta.price ?? ""}`);
  }
  return lines.join("\n");
}
