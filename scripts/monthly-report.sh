#!/usr/bin/env bash
set -euo pipefail

# Monthly: first of current month to today
TODAY="$(date +%Y-%m-%d)"
MONTH_START="$(date +%Y-%m-01)"

echo "Monthly range: ${MONTH_START} .. ${TODAY}"

exec "$(dirname "$0")/range-report.sh" "${MONTH_START}" "${TODAY}"

