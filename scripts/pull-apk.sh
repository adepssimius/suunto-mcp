#!/usr/bin/env bash
# Pull the installed Suunto app off a connected Android device.
#
# This is the preferred way to obtain the APK: it needs no third-party mirror,
# and it gets the exact build the device is actually running — which matters,
# because signing key material and endpoint paths move between app versions.
#
# Requires: USB debugging enabled, device authorised for this host.
set -euo pipefail

PKG="${1:-com.stt.android.suunto}"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/apk"

mkdir -p "$OUT"

state="$(adb get-state 2>/dev/null || echo 'none')"
if [[ "$state" != "device" ]]; then
  echo "No authorised device (adb state: $state)." >&2
  echo >&2
  echo "  1. Settings > About phone > tap 'Build number' 7 times" >&2
  echo "  2. Settings > System > Developer options > USB debugging" >&2
  echo "  3. Plug in over USB and accept the 'Allow USB debugging?' prompt" >&2
  echo "  4. Re-run this script" >&2
  exit 1
fi

echo "Device: $(adb shell getprop ro.product.model | tr -d '\r') "\
"(Android $(adb shell getprop ro.build.version.release | tr -d '\r'))"

# Portable read into an array: macOS ships bash 3.2, which has no `mapfile`.
paths=()
while IFS= read -r line; do
  [[ -n "$line" ]] && paths+=("$line")
done < <(adb shell pm path "$PKG" 2>/dev/null | sed 's/^package://' | tr -d '\r')

if [[ ${#paths[@]} -eq 0 ]]; then
  echo "$PKG is not installed on this device." >&2
  exit 1
fi

version="$(adb shell dumpsys package "$PKG" | grep -m1 versionName | tr -d '\r' | sed 's/.*versionName=//')"
echo "Found $PKG version ${version:-unknown} — ${#paths[@]} split(s)"

for path in "${paths[@]}"; do
  name="$(basename "$path")"
  echo "  pulling $name"
  adb pull "$path" "$OUT/$name" >/dev/null
done

echo
echo "Pulled to $OUT:"
ls -la "$OUT"
echo
echo "Record this — key material and endpoints are version-specific:"
echo "  package: $PKG"
echo "  version: ${version:-unknown}"
echo
echo "Next: scripts/analyze-apk.sh"
