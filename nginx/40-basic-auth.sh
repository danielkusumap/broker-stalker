#!/bin/sh
# Bikin /etc/nginx/.htpasswd dari env BASIC_AUTH_USER / BASIC_AUTH_PASSWORD.
# Password disimpan hanya di .env (tidak di-commit) dan file ini di container.
set -eu

if [ -z "${BASIC_AUTH_USER:-}" ] || [ -z "${BASIC_AUTH_PASSWORD:-}" ]; then
  echo "[basic-auth] BASIC_AUTH_USER dan BASIC_AUTH_PASSWORD wajib diset." >&2
  exit 1
fi

htpasswd -bc /etc/nginx/.htpasswd "$BASIC_AUTH_USER" "$BASIC_AUTH_PASSWORD"
echo "[basic-auth] user '${BASIC_AUTH_USER}' siap."
