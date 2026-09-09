#!/usr/bin/env bash
# Shared ownership fence. An inherited descriptor retains a shared kernel lock
# for the legacy shell lifetime. The app takes the same lock exclusively.
# Environment state only avoids reopening the descriptor; Python validates its
# inode and acquires the lock again before every successful guard return.
FM_APP_FENCE_SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd -P)" || exit 3

fm_app_require_legacy() {
  local fm_app_fence_root fm_app_fence_home fm_app_fence_marker fm_app_fence_lock fm_app_fence_python
  fm_app_fence_root="$FM_APP_FENCE_SOURCE_ROOT"
  fm_app_fence_home="${FM_HOME:-${FM_ROOT_OVERRIDE:-$fm_app_fence_root}}"
  fm_app_fence_marker="$fm_app_fence_home/app/control-mode"
  if [ -e "$fm_app_fence_marker" ] || [ -L "$fm_app_fence_marker" ]; then
    echo "error: this home is controlled by the Firstmate app; use its runtime API or CLI" >&2
    exit 3
  fi
  mkdir -p "$fm_app_fence_home/app" || return 1
  fm_app_fence_lock="$fm_app_fence_home/app/owner.lock"
  fm_app_fence_python=/usr/bin/python3
  if [ ! -x "$fm_app_fence_python" ]; then
    fm_app_fence_python=$(command -v python3) || return 1
  fi
  # The hint only selects a descriptor; the kernel lock and inode check below
  # remain authoritative before any legacy command can proceed.
  if [ "${FM_APP_FENCE_LOCK_FILE:-}" != "$fm_app_fence_lock" ] || [ ! -e "/dev/fd/${FM_APP_FENCE_FD:-8}" ];
  then
    if [ -n "${ZSH_VERSION:-}" ]; then
      exec {FM_APP_FENCE_FD}>>"$fm_app_fence_lock" || return 1
    else
      # Bash 3 does not reliably replace inherited descriptors above 9.
      exec 8>>"$fm_app_fence_lock" || return 1
      FM_APP_FENCE_FD=8
    fi
    export FM_APP_FENCE_FD
  fi
  if ! "$fm_app_fence_python" - "$fm_app_fence_lock" "$fm_app_fence_marker" "${FM_APP_FENCE_FD:-8}" <<'PY'
import fcntl, os, sys
try:
    expected = os.stat(sys.argv[1])
    descriptor = int(sys.argv[3])
    actual = os.fstat(descriptor)
    if (expected.st_dev, expected.st_ino) != (actual.st_dev, actual.st_ino):
        raise ValueError('Ownership descriptor does not match this home')
    fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
    if os.path.lexists(sys.argv[2]):
        raise ValueError('This home is controlled by the Firstmate app')
except (OSError, ValueError) as error:
    print('error: Firstmate ownership fence: ' + str(error), file=sys.stderr)
    sys.exit(3)
PY
  then
    exit 3
  fi
  FM_APP_FENCE_LOCK_FILE="$fm_app_fence_lock"
  export FM_APP_FENCE_LOCK_FILE
}
