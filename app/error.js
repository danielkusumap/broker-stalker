"use client";

// Error boundary global — crash satu route tidak memutih seluruh app.
export default function GlobalError({ error, reset }) {
  return (
    <div
      style={{
        minHeight: "50vh",
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
      <h2 style={{ fontSize: 20, fontWeight: 800 }}>Terjadi kesalahan</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 14, maxWidth: 480 }}>
        {error?.message || "Kesalahan tak terduga saat memuat halaman."}
      </p>
      <button
        type="button"
        onClick={() => reset()}
        style={{
          marginTop: 8,
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
    </div>
  );
}
