"use client";

import Link from "next/link";

// Error boundary khusus route Broker Stalker.
export default function BrokerStalkerError({ error, reset }) {
  return (
    <div
      style={{
        minHeight: "60vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 32,
        color: "var(--text)",
        textAlign: "center",
      }}
    >
      <h2 style={{ fontSize: 20, fontWeight: 800 }}>Broker Stalker gagal dimuat</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 14, maxWidth: 520 }}>
        {error?.message ||
          "Terjadi kesalahan. Biasanya koneksi ke server data saham yang terputus — coba lagi."}
      </p>
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <button
          type="button"
          onClick={() => reset()}
          style={{
            background: "var(--primary-solid)",
            color: "var(--on-primary)",
            border: "none",
            borderRadius: 8,
            padding: "10px 18px",
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Coba lagi
        </button>
        <Link
          href="/"
          style={{
            border: "1px solid var(--border-strong)",
            borderRadius: 8,
            padding: "10px 18px",
            fontSize: 14,
            fontWeight: 700,
            color: "var(--text)",
          }}
        >
          Ke Beranda
        </Link>
      </div>
    </div>
  );
}
