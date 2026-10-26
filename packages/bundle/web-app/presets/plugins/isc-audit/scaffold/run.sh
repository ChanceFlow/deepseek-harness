#!/usr/bin/env bash
# Run the ISC audit. On an unresolved findings file this exits 1 with a
# ValidationError listing every problem at once — that error is the trigger.
#
#   ./run.sh                       # audit ./findings.json
#   ./run.sh path/to/findings.json # audit another document
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-$HERE/findings.json}"

exec python3 "$HERE/audit_task.py" "$TARGET"
