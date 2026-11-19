#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
plat="${GOOS:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
arch="${GOARCH:-$(uname -m)}"
case "$arch" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; esac
out="../../apps/backend/bin/tailscale/ahcc-tailscale-${plat}-${arch}"
mkdir -p "$(dirname "$out")"
go build -trimpath -ldflags="-s -w" -o "$out" .
echo "built $out"
