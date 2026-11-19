#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
OUT=bin/matter
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
mkdir -p "$OUT"

rm -f "$OUT/ahcc-matter"
"$BUN" build src/push/matter-helper.ts --compile --outfile "$OUT/ahcc-matter"

if [[ "$(uname)" == "Darwin" ]]; then
  IDENTITY="${CODESIGN_IDENTITY:--}"
  codesign --force --sign "$IDENTITY" --identifier com.antihunter.ahcc-matter \
    --options runtime --timestamp --entitlements tools/matter/entitlements.plist "$OUT/ahcc-matter"
  codesign --verify --strict --verbose=2 "$OUT/ahcc-matter"
  if [[ -n "${NOTARY_PROFILE:-}" ]]; then
    rm -f "$OUT/ahcc-matter.zip"
    ditto -c -k --keepParent "$OUT/ahcc-matter" "$OUT/ahcc-matter.zip"
    xcrun notarytool submit "$OUT/ahcc-matter.zip" --keychain-profile "$NOTARY_PROFILE" --wait
  fi
fi

echo "built $(pwd)/$OUT/ahcc-matter"
