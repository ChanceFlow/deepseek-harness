#!/usr/bin/env bash
# One command. On an unresolved instance this exits 1 with a ValidationError
# listing every problem at once — that error is the trigger.
#
#   ./run.sh                    # run in place
#   <scaffold>/tvd.py run <dir> # run another instance
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$HERE/tvd.py" run "$HERE"
