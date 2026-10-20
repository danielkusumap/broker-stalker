import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import SideMenu from "../components/SideMenu";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "SRJUM Stock — Tools Analisa Saham IDX",
  description:
    "Tools analisa saham IDX: Broker Stalker (lacak jejak broker) dan lainnya. Data: IDX Edge PRO.",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="id"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Terapkan tema tersimpan sebelum paint — cegah kedip terang→gelap. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{var t=localStorage.getItem("srjum.theme");if(t)document.documentElement.setAttribute("data-theme",t);else document.documentElement.setAttribute("data-theme","dark")}catch(e){document.documentElement.setAttribute("data-theme","dark")}',
          }}
        />
      </head>
      <body>
        <SideMenu />
        <main className="appMain">{children}</main>
      </body>
    </html>
  );
}
