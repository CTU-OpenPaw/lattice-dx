#!/bin/sh
# @file LatticeDX — Open Digital Enterprise Platform
# @author CTU-OpenPaw
# @copyright (C) 2026 CTU-OpenPaw
# @license Apache-2.0
# @see https://github.com/CTU-OpenPaw/lattice-dx
# SPDX-License-Identifier: Apache-2.0
set -eu

if [ "$#" -lt 2 ] || [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
  echo "Usage: pitr-archive.sh <wal-path> <wal-filename>" >&2
  exit 1
fi

wal_path="$1"
wal_name="$2"

case "$wal_name" in
  */*|*\\*|*..*|-*)
    echo "Invalid WAL filename: $wal_name" >&2
    exit 1
    ;;
esac

if [ ! -f "$wal_path" ]; then
  echo "WAL source not found: $wal_path" >&2
  exit 1
fi

if [ -n "${WALG_S3_PREFIX:-}" ] && command -v wal-g >/dev/null 2>&1; then
  exec wal-g wal-push "$wal_path"
fi

wal_dir="${PITR_WAL_DIR:-/var/lib/postgresql/wal-archive}"
mkdir -p "$wal_dir"
chmod 700 "$wal_dir" 2>/dev/null || true

dest="${wal_dir}/$2.gz"
if [ -e "$dest" ]; then
  echo "WAL archive already exists: $dest" >&2
  exit 1
fi

tmp_dest="${dest}.tmp.$$"
trap 'rm -f "$tmp_dest"' EXIT INT TERM
umask 077
gzip -c -- "$wal_path" > "$tmp_dest"
mv "$tmp_dest" "$dest"
trap - EXIT INT TERM
