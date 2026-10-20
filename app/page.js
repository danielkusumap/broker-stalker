import Link from "next/link";
import styles from "./page.module.css";

const TOOLS = [
  {
    href: "/broker-stalker",
    icon: "🔍",
    title: "Broker Stalker",
    desc: "Lacak sisa barang broker per emiten — posisi vs harga terkini, realized/unrealized, dan fase: lagi kumpul / trimming / distribusi.",
    badge: "Aktif",
    active: true,
  },
  {
    href: "/broker-stalker-v2",
    icon: "🎯",
    title: "Broker Stalker v2",
    desc: "Tracking posisi broker per tahap (ATH / bullish / bearish / distribusi): AKUM, DIST, AVG FIFO, badge, dan floating P&L per broker.",
    badge: "Baru",
    active: true,
  },
  {
    href: "/broker-flow",
    icon: "🔄",
    title: "Broker Flow",
    desc: "Mode balik: satu kode broker diperiksa lintas banyak emitens — net value, arah 5 hari, dan sinyal masih beli / masih jual.",
    badge: "Aktif",
    active: true,
  },
  {
    href: "/screener",
    icon: "📊",
    title: "Screener Cepat",
    desc: "Hasil screener + akumulasi broker siap pakai, satu klik langsung dikirim ke Broker Stalker.",
    badge: "Aktif",
    active: true,
  },
  {
    href: "/movers",
    icon: "📈",
    title: "Movers",
    desc: "Peringkat harian: top gainer/loser, teratas per nilai, lot, dan frekuensi — klik kode untuk analisa.",
    badge: "Aktif",
    active: true,
  },
  {
    href: "/inventory",
    icon: "📦",
    title: "Inventory Chart",
    desc: "Peta inventory broker vs harga dalam satu chart: tumpukan posisi (lembar) + kurva harga, lengkap dengan tombol lanjut ke Broker Stalker.",
    badge: "Aktif",
    active: true,
  },
  {
    icon: "🚨",
    title: "Watchlist & Alert",
    desc: "Pantau banyak ticker sekaligus dan dapatkan notifikasi saat fase broker berubah.",
    badge: "Segera",
  },
];

export default function Home() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Broker Stalker</h1>
        <p className={styles.sub}>
          Tools analisa saham IDX berbasis data bandarmologi &amp; teknikal.
          Sumber data: IDX Edge PRO.
        </p>
      </header>

      <section className={styles.grid} aria-label="Daftar tools">
        {TOOLS.map((t) => {
          const inner = (
            <>
              <div className={styles.cardTop}>
                <span className={styles.icon}>{t.icon}</span>
                <span className={`${styles.badge} ${t.active ? styles.badgeOn : ""}`}>
                  {t.badge}
                </span>
              </div>
              <h2 className={styles.cardTitle}>{t.title}</h2>
              <p className={styles.cardDesc}>{t.desc}</p>
              {t.active && <span className={styles.cardCta}>Buka →</span>}
            </>
          );
          return t.href ? (
            <Link key={t.title} href={t.href} className={`${styles.card} ${styles.cardLink}`}>
              {inner}
            </Link>
          ) : (
            <div key={t.title} className={`${styles.card} ${styles.cardSoon}`}>
              {inner}
            </div>
          );
        })}
      </section>

      <footer className={styles.footer}>
        Bukan rekomendasi beli/jual. Bandarmologi adalah inferensi dari data transaksi,
        bukan fakta posisi broker.
      </footer>
    </div>
  );
}
