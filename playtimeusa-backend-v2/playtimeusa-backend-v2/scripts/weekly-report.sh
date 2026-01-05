#!/usr/bin/env bash
set -euo pipefail

# Weekly: last 7 days including today
TODAY="$(date +%Y-%m-%d)"
START_DAY="$(date -d "6 days ago" +%Y-%m-%d)"

echo "Weekly range: ${START_DAY} .. ${TODAY}"

exec "$(dirname "$0")/range-report.sh" "${START_DAY}" "${TODAY}"
