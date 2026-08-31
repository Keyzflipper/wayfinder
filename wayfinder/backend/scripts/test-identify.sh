#!/usr/bin/env bash
# scripts/test-identify.sh — POST /api/identify against a running `wrangler
# dev` local Worker, without opening the frontend.
#
# Usage:
#   ./scripts/test-identify.sh [photo] [lat] [lon] [tripName]
#
# All args are optional. Defaults to test/fixtures/sample-photo.jpg with no
# coords/trip. Set WAYFINDER_HOST to point at a non-default dev port.
#
# Examples:
#   ./scripts/test-identify.sh
#   ./scripts/test-identify.sh test/fixtures/sample-photo.jpg 40.6892 -74.0445 nyc-trip
#   WAYFINDER_HOST=http://127.0.0.1:8788 ./scripts/test-identify.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${WAYFINDER_HOST:-http://127.0.0.1:8787}"
PHOTO="${1:-$SCRIPT_DIR/../test/fixtures/sample-photo.jpg}"
LAT="${2:-}"
LON="${3:-}"
TRIP_NAME="${4:-}"

if [ ! -f "$PHOTO" ]; then
  echo "Photo file not found: $PHOTO" >&2
  exit 1
fi

args=(-s -w '\nHTTP %{http_code}\n' -X POST "$HOST/api/identify" -F "photo=@${PHOTO};type=image/jpeg")
[ -n "$LAT" ] && args+=(-F "lat=$LAT")
[ -n "$LON" ] && args+=(-F "lon=$LON")
[ -n "$TRIP_NAME" ] && args+=(-F "tripName=$TRIP_NAME")

echo "POST $HOST/api/identify  photo=$PHOTO lat=${LAT:-<none>} lon=${LON:-<none>} tripName=${TRIP_NAME:-<none>}" >&2
curl "${args[@]}"
echo
