import { NextResponse } from "next/server";

// Basic auth di level aplikasi.
// Dipakai supaya login tetap muncul walau request tidak lewat nginx
// (mis. domain diarahkan langsung ke port 3000).
//
// Kredensial dibaca dari env yang sama dengan nginx:
//   BASIC_AUTH_USER, BASIC_AUTH_PASSWORD
//
// Auth aktif kalau BASIC_AUTH_ENABLED=true, atau otomatis di production.
// `next dev` (NODE_ENV=development) tidak akan minta password.

const REALM = 'Basic realm="Broker Stalker", charset="UTF-8"';

function authEnabled() {
  const flag = (process.env.BASIC_AUTH_ENABLED || "").toLowerCase();
  if (flag === "false") return false;
  if (flag === "true") return true;
  return process.env.NODE_ENV === "production";
}

// Perbandingan waktu-konstan sederhana supaya tidak bisa ditebak lewat timing.
function safeEqual(a, b) {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function parseBasic(header) {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const raw = atob(header.slice(6).trim());
    const sep = raw.indexOf(":");
    if (sep < 0) return null;
    return { user: raw.slice(0, sep), pass: raw.slice(sep + 1) };
  } catch {
    return null;
  }
}

function unauthorized() {
  return new NextResponse("Login diperlukan.", {
    status: 401,
    headers: {
      "WWW-Authenticate": REALM,
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export function proxy(request) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASSWORD;

  // Kredensial belum diisi → jangan kunci aplikasi.
  if (!user || !pass || !authEnabled()) return NextResponse.next();

  const creds = parseBasic(request.headers.get("authorization"));
  if (creds && safeEqual(creds.user, user) && safeEqual(creds.pass, pass)) {
    return NextResponse.next();
  }
  return unauthorized();
}

export const config = {
  // Kunci semua halaman + API, kecuali aset statis (biar tidak berat).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
