#!/usr/bin/env bash
# Boots the production preview, runs smoke + uhdr + avif tests, tears down.
set -u
cd "$(dirname "$0")/.."
npx vite preview --port 4330 >/tmp/preview.log 2>&1 &
SRV=$!
sleep 4
export BASE_URL="http://localhost:4330/"
echo "===== smoke ====="; node test/smoke.mjs; S1=$?
echo "===== uhdr ====="; node test/uhdr.mjs; S2=$?
echo "===== avif ====="; node test/avif.mjs; S3=$?
kill "$SRV" 2>/dev/null
echo "smoke_rc=$S1 uhdr_rc=$S2 avif_rc=$S3"
exit $(( S1 | S2 | S3 ))
