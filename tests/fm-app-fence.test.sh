#!/usr/bin/env bash
# Every legacy shell entrypoint refuses an app-owned home before state changes.
set -eu
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fixture_root=$(fm_test_tmproot fm-app-fence)
mkdir -p "$fixture_root/home/app" "$fixture_root/home/state"
printf 'app\n' > "$fixture_root/home/app/control-mode"
printf 'preserve\n' > "$fixture_root/home/state/sentinel"
for script in "$ROOT"/bin/*.sh "$ROOT"/bin/backends/*.sh; do
  [ "$(basename "$script")" = fm-app-fence-lib.sh ] && continue
  status=0
  FM_HOME="$fixture_root/home" bash "$script" --help > "$fixture_root/output" 2>&1 || status=$?
  [ "$status" -eq 3 ] || fail "$(basename "$script") bypassed app ownership fence ($status)"
  grep -q 'controlled by the Firstmate app' "$fixture_root/output" || fail "missing fence explanation"
done
[ "$(cat "$fixture_root/home/state/sentinel")" = preserve ] || fail 'legacy state changed'
pass 'all legacy shell entrypoints fail closed for app-owned homes'
