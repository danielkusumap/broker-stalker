"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import styles from "./SideMenu.module.css";

// Menu global — tampil di semua halaman (dipasang di app/layout.js).
// Menambah page baru? Tambahkan satu entri di array NAV saja.
const NAV = [
  { href: "/", label: "Beranda", icon: "🏠" },
  { href: "/broker-stalker", label: "Broker Stalker", icon: "🔍" },
  { href: "/broker-stalker-v2", label: "Broker Stalker v2", icon: "🎯" },
  { href: "/broker-flow", label: "Broker Flow", icon: "🔄" },
  { href: "/screener", label: "Screener", icon: "📊" },
  { href: "/inventory", label: "Inventory", icon: "📦" },
  { href: "/movers", label: "Movers", icon: "📈" },
];

export default function SideMenu() {
  const pathname = usePathname();
  const [theme, setTheme] = useState("dark");

  // Sinkron dengan tema yang dipasang script anti-flash di <head> (sistem eksternal).
  useEffect(() => {
    const t = document.documentElement.getAttribute("data-theme");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (t === "light" || t === "dark") setTheme(t);
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("brokerstalker.theme", next);
    } catch {
      /* storage penuh / private mode */
    }
    setTheme(next);
  }

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <span className={styles.brandMark}>📈</span>
        <span className={styles.brandText}>Broker Stalker</span>
      </div>
      <nav className={styles.nav}>
        {NAV.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.link} ${active ? styles.linkActive : ""}`}
              aria-current={active ? "page" : undefined}
            >
              <span className={styles.icon}>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <button
        type="button"
        className={styles.themeBtn}
        onClick={toggleTheme}
        aria-label={
          theme === "dark" ? "Ganti ke tema terang" : "Ganti ke tema gelap"
        }
      >
        {theme === "dark" ? "🌙 Gelap" : "☀️ Terang"}
      </button>
      <div className={styles.foot}>Data: IDX Edge PRO</div>
    </aside>
  );
}
