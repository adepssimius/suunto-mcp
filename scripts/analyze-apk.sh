#!/usr/bin/env bash
# Static analysis of the Suunto APK, hunting for the private guides API.
#
# Two stages, cheap first:
#
#   Stage 1 — string scan of the raw dex. Seconds. Answers the question that
#             decides the whole reverse-engineering effort: does the app talk to
#             the *documented* cloudapi.suunto.com/v2/guides/* with an embedded
#             subscription key? If so there is almost nothing left to reverse.
#
#   Stage 2 — full jadx decompile. Minutes. Only worth paying for if stage 1
#             leaves the endpoint shape or the DTO fields unresolved.
#
# Everything it writes lands in capture/, which is git-ignored.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK_DIR="$ROOT/apk"
OUT="$ROOT/capture"
STAGE="${1:-1}"

mkdir -p "$OUT"

BASE="$(find "$APK_DIR" -maxdepth 1 -name 'base.apk' -o -maxdepth 1 -name '*.apk' 2>/dev/null | head -1)"
if [[ -z "$BASE" ]]; then
  echo "No APK in $APK_DIR. Run scripts/pull-apk.sh first." >&2
  exit 1
fi
echo "Analysing $(basename "$BASE") ($(du -h "$BASE" | cut -f1))"
echo

# ---------------------------------------------------------------------------
# Stage 1 — raw string scan
# ---------------------------------------------------------------------------
STRINGS="$OUT/strings.txt"
if [[ ! -s "$STRINGS" ]]; then
  echo "Extracting strings from dex (this takes a few seconds)..."
  unzip -p "$BASE" 'classes*.dex' 2>/dev/null | strings -n 6 | sort -u > "$STRINGS"
fi
echo "  $(wc -l < "$STRINGS" | tr -d ' ') unique strings"
echo

banner() { echo; echo "=== $1 ==="; }

banner "HYPOTHESIS: app uses the documented Cloud API"
grep -iE 'cloudapi\.suunto\.com|Ocp-Apim-Subscription-Key|apizone' "$STRINGS" | head -20 \
  || echo "  (no hits — app likely does NOT use the documented Cloud API)"

banner "Guide-related endpoint paths"
grep -iE '^(/|v[0-9]+/|https?://).*guide' "$STRINGS" | head -40 \
  || echo "  (none)"

banner "Any string containing 'guide'"
grep -i 'guide' "$STRINGS" | grep -vE '^(android|androidx|com\.google|kotlin|io\.reactivex)' | head -60 \
  || echo "  (none)"

banner "SuuntoPlus / plugin hosts"
grep -iE 'suuntoplus|suuntoplusplugins|blob\.core\.windows\.net' "$STRINGS" | head -20 \
  || echo "  (none)"

banner "Guide schema field names (confirms the DTO is present)"
for field in shortDescription externalId localDate stepDurationCountdown targetHeartRate targetPace createManualLap manualLap sequence; do
  n=$(grep -cx "$field" "$STRINGS" 2>/dev/null || true)
  printf '  %-24s %s\n' "$field" "${n:-0}"
done

banner "API hosts referenced"
grep -oE 'https?://[a-zA-Z0-9.-]+\.[a-z]{2,}' "$STRINGS" | sort -u | grep -iE 'suunto|sports-tracker|stt' | head -20 \
  || echo "  (none)"

banner "Candidate REST paths mentioning workout/plan/training"
grep -iE '^/?v[0-9]+/[a-z/{}]*(workout|plan|training|schedul)' "$STRINGS" | sort -u | head -40 \
  || echo "  (none)"

if [[ "$STAGE" != "2" ]]; then
  echo
  echo "---"
  echo "Stage 1 done. Findings above; full string dump at $STRINGS"
  echo "If the endpoint shape or DTO fields are still unclear, run:"
  echo "    scripts/analyze-apk.sh 2"
  exit 0
fi

# ---------------------------------------------------------------------------
# Stage 2 — full decompile
# ---------------------------------------------------------------------------
SRC="$OUT/decompiled"
if [[ ! -d "$SRC" ]]; then
  echo
  echo "Decompiling with jadx (several minutes, needs ~4GB RAM)..."
  jadx --no-debug-info --no-res -j 4 -d "$SRC" "$BASE" 2>&1 | tail -5 || true
fi

banner "Retrofit interfaces mentioning guide"
grep -rlE '@(GET|POST|PUT|DELETE|PATCH)\(' "$SRC" 2>/dev/null \
  | xargs grep -lit 'guide' 2>/dev/null | head -20 || echo "  (none)"

banner "Retrofit annotations adjacent to guide"
grep -rEB2 -A2 '@(GET|POST|PUT|DELETE|PATCH)\("[^"]*[Gg]uide' "$SRC" 2>/dev/null | head -80 \
  || echo "  (none)"

banner "Serialized guide DTO fields"
grep -rE '@(SerializedName|SerialName|Json)\("(name|steps|trigger|fields|times|usage|externalId|localDate|shortDescription)"\)' "$SRC" 2>/dev/null \
  | head -40 || echo "  (none)"

echo
echo "---"
echo "Stage 2 done. Decompiled source at $SRC"
echo "Write findings up in docs/private-guides-api.md"
