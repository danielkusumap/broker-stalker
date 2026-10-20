// Broker Stalker v2 — perhitungan murni (tanpa UI/network).
// Metode yang dipakai (hasil RnD broker summary):
//   - tiap TAHAP memakai net volume + harga beli rata-rata (bval/bvol) dari broker-summary
//   - posisi dihitung FIFO per tahap: beli menambah lot, jual mengurangi lot tertua
//   - AVG = harga rata-rata lot yang tersisa; CLOSING = close di akhir tahap terakhir
//   - badge ditentukan arah tahap terakhir + posisi floating vs AVG

export const STAGE_TYPES = [
  {
    key: "Init",
    label: "Inisialisasi",
    emoji: "🧭",
    color: "#38bdf8",
    description:
      "Tahap dasar saat mulai tracking. Dipakai untuk menetapkan posisi awal broker; tidak dibaca sebagai sinyal bullish/bearish.",
  },
  {
    key: "ATH",
    label: "ATH",
    emoji: "🏔️",
    color: "#a78bfa",
    description:
      "Harga di area tertinggi. Untuk melihat siapa yang menampung barang di puncak dan siapa yang mulai melepas.",
  },
  {
    key: "Bullish",
    label: "Bullish",
    emoji: "🚀",
    color: "var(--up)",
    description:
      "Fase harga naik. Untuk melihat broker yang menambah posisi / akumulasi saat harga menguat.",
  },
  {
    key: "Bearish",
    label: "Bearish",
    emoji: "🐻",
    color: "var(--down)",
    description:
      "Fase harga turun. Untuk melihat siapa yang bertahan, average down, atau justru memotong loss.",
  },
  {
    key: "Distribusi",
    label: "Distribusi",
    emoji: "📉",
    color: "#fbbf24",
    description:
      "Fase ada pihak besar melepas barang. Bisa terjadi saat harga naik, flat, atau turun; fokusnya siapa sumber jualnya.",
  },
];

// Tahap pertama memakai Inisialisasi; tahap tambahan tidak perlu label itu lagi.
export const ADD_STAGE_TYPES = STAGE_TYPES.filter((s) => s.key !== "Init");

export const BADGES = {
  avg_down: {
    key: "avg_down",
    label: "AVG DOWN",
    tone: "warn",
    description:
      "Broker masih menambah posisi (net beli), tetapi AVG-nya di atas harga sekarang. Sedang average down / menahan loss.",
  },
  trim_cutloss: {
    key: "trim_cutloss",
    label: "TRIM CUTLOSS",
    tone: "bad",
    description:
      "Broker mengurangi posisi (net jual) sementara AVG di atas harga sekarang. Menjual untuk memotong kerugian.",
  },
  fresh_accum: {
    key: "fresh_accum",
    label: "FRESH ACCUM",
    tone: "good",
    description:
      "Broker menambah posisi (net beli) dan AVG-nya di bawah harga sekarang. Akumulasi baru yang sudah floating profit.",
  },
  take_profit: {
    key: "take_profit",
    label: "TAKE PROFIT",
    tone: "good",
    description:
      "Broker mengurangi posisi (net jual) sementara AVG di bawah harga sekarang. Merealisasikan profit.",
  },
  hold: {
    key: "hold",
    label: "HOLD",
    tone: "muted",
    description:
      "Tidak ada perubahan arah berarti di tahap terakhir; posisi lama diteruskan.",
  },
  exit: {
    key: "exit",
    label: "EXIT",
    tone: "muted",
    description: "Posisi sudah habis / tidak ada sisa barang yang terpantau.",
  },
  short_profit: {
    key: "short_profit",
    label: "SHORT PROFIT",
    tone: "good",
    description:
      "Posisi short (jual lebih dulu) dan harga sekarang di bawah harga jual. Floating profit.",
  },
  short_loss: {
    key: "short_loss",
    label: "SHORT LOSS",
    tone: "bad",
    description:
      "Posisi short dan harga sekarang di atas harga jual. Floating loss.",
  },
};

export function stageMeta(type) {
  return STAGE_TYPES.find((s) => s.key === type) || STAGE_TYPES[0];
}

function newState(t) {
  return {
    code: t.code,
    name: t.name || t.code,
    entry: t.entry,
    lots: [],
    shorts: [],
    shares: 0,
    lastDir: 0,
    traded: false,
  };
}

function applyFlow(state, row) {
  const net = Number(row.nvol) || 0;
  if (!net) return;

  const buyPrice = row.bvol > 0 ? row.bval / row.bvol : null;
  const sellPrice = row.svol > 0 ? row.sval / row.svol : null;

  if (net > 0) {
    let qty = net;
    // tutup short lama dulu (FIFO)
    while (qty > 0 && state.shorts.length) {
      const s = state.shorts[0];
      const take = Math.min(qty, s.qty);
      s.qty -= take;
      qty -= take;
      if (s.qty <= 1e-9) state.shorts.shift();
    }
    if (qty > 0) state.lots.push({ qty, price: buyPrice ?? sellPrice ?? 0 });
    state.shares += net;
  } else {
    let qty = -net;
    while (qty > 0 && state.lots.length) {
      const l = state.lots[0];
      const take = Math.min(qty, l.qty);
      l.qty -= take;
      qty -= take;
      if (l.qty <= 1e-9) state.lots.shift();
    }
    if (qty > 0) state.shorts.push({ qty, price: sellPrice ?? buyPrice ?? 0 });
    state.shares += net;
  }

  state.lastDir = net > 0 ? 1 : -1;
  state.traded = true;
}

function badgeFor(side, lastDir, floatingPoint) {
  if (side === "short") {
    return floatingPoint >= 0 ? BADGES.short_profit : BADGES.short_loss;
  }
  if (side === "flat") return BADGES.exit;
  if (lastDir > 0) return floatingPoint >= 0 ? BADGES.fresh_accum : BADGES.avg_down;
  if (lastDir < 0) return floatingPoint >= 0 ? BADGES.take_profit : BADGES.trim_cutloss;
  return BADGES.hold;
}

function view(state, close) {
  const longQty = state.lots.reduce((a, l) => a + l.qty, 0);
  const longCost = state.lots.reduce((a, l) => a + l.qty * l.price, 0);
  const shortQty = state.shorts.reduce((a, s) => a + s.qty, 0);
  const shortProceeds = state.shorts.reduce((a, s) => a + s.qty * s.price, 0);

  const shares = state.shares;
  let side = "flat";
  let avg = null;
  if (shares > 0.5) {
    side = "long";
    avg = longQty > 0.5 ? longCost / longQty : null;
  } else if (shares < -0.5) {
    side = "short";
    avg = shortQty > 0.5 ? shortProceeds / shortQty : null;
  }

  const floatingPoint =
    avg == null || close == null || side === "flat"
      ? null
      : side === "long"
        ? close - avg
        : avg - close;
  const floatingPct = avg ? (floatingPoint / avg) * 100 : null;
  const floatingIdr =
    floatingPoint == null ? null : Math.abs(shares) * floatingPoint;

  return {
    code: state.code,
    name: state.name,
    entry: state.entry,
    shares,
    lots: longQty,
    avg,
    side,
    floatingPoint,
    floatingPct,
    floatingIdr,
    badge: badgeFor(side, state.lastDir, floatingPoint),
    lastDir: state.lastDir,
  };
}

/**
 * Hitung snapshot posisi untuk SETIAP tahap.
 * @param stages  array metadata tahap ({type,start,end,close})
 * @param tracked array {code,name,entry} — entry = index tahap saat mulai tracking
 * @param summaries array of Map(brokerCode → row summary) selaras dengan stages
 */
export function computeSnapshots({ stages, tracked, summaries }) {
  const states = new Map(tracked.map((t) => [t.code, newState(t)]));
  const snapshots = [];

  for (let i = 0; i < stages.length; i++) {
    const close = stages[i]?.close ?? null;
    for (const t of tracked) {
      if (t.entry > i) continue;
      const state = states.get(t.code);
      const row = summaries[i]?.get(t.code);
      if (!row) continue;
      if (row.broker_name) state.name = row.broker_name;
      applyFlow(state, row);
    }
    snapshots.push(
      tracked.filter((t) => t.entry <= i).map((t) => view(states.get(t.code), close))
    );
  }

  return snapshots;
}

/** Perubahan posisi tahap ke-i dibanding tahap sebelumnya (untuk "Lihat update"). */
export function stageChanges(snapshots, index) {
  const current = snapshots[index] || [];
  const prev = index > 0 ? new Map((snapshots[index - 1] || []).map((p) => [p.code, p])) : new Map();
  return current.map((cur) => {
    const before = prev.get(cur.code);
    return {
      ...cur,
      beforeShares: before?.shares ?? 0,
      beforeAvg: before?.avg ?? null,
      deltaShares: cur.shares - (before?.shares ?? 0),
      deltaAvg: cur.avg != null && before?.avg != null ? cur.avg - before.avg : null,
    };
  });
}

export function summarizeBadges(rows) {
  const out = { avg_down: 0, trim_cutloss: 0, fresh_accum: 0, take_profit: 0 };
  for (const r of rows) {
    if (out[r.badge.key] != null) out[r.badge.key] += 1;
  }
  return out;
}

// ---------- format ----------
export function signed(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return "–";
  const v = Math.abs(n).toLocaleString("id-ID", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${v}`;
}

export function signedRp(n) {
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
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}Rp ${body}`;
}

export function lotsOf(shares) {
  return Math.round((shares || 0) / 100);
}
