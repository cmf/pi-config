#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/tk-to-gh-issues.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [[ "$expected" != "$actual" ]]; then
    fail "$message (expected=$expected actual=$actual)"
  fi
}

assert_contains() {
  local needle="$1"
  local haystack="$2"
  local message="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    fail "$message (missing '$needle')"
  fi
}

make_mock_bin() {
  local dir="$1"
  mkdir -p "$dir/bin"

  cat >"$dir/bin/tk" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

cmd="${1:-}"
shift || true

case "$cmd" in
  query)
    expr="${1:-}"
    if [[ -z "$expr" ]]; then
      cat <<'JSON'
{"id":"tp-1","title":"One","status":"open"}
{"id":"tp-2","title":"Two","status":"open"}
JSON
    elif [[ "$expr" == "select(.status==\"open\")" ]]; then
      cat <<'JSON'
{"id":"tp-1","title":"One","status":"open"}
{"id":"tp-2","title":"Two","status":"open"}
JSON
    elif [[ "$expr" == "select(.id == \"tp-1\")" ]]; then
      cat <<'JSON'
{"id":"tp-1","title":"One","status":"open"}
JSON
    elif [[ "$expr" == "select(.id == \"tp-2\")" ]]; then
      cat <<'JSON'
{"id":"tp-2","title":"Two","status":"open"}
JSON
    else
      echo "unexpected query expr: $expr" >&2
      exit 1
    fi
    ;;
  ready)
    cat <<'TXT'
tp-1 [open] - One
tp-2 [open] - Two
TXT
    ;;
  show)
    id="${1:-}"
    if [[ "$id" == "tp-1" ]]; then
      cat <<'MD'
---
id: tp-1
title: One
status: open
---

# One

Body one.
MD
    elif [[ "$id" == "tp-2" ]]; then
      cat <<'MD'
---
id: tp-2
title: Two
status: open
---

# Two

Body two.
MD
    else
      echo "unexpected show id: $id" >&2
      exit 1
    fi
    ;;
  *)
    echo "unexpected tk command: $cmd" >&2
    exit 1
    ;;
esac
EOF

  cat >"$dir/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

log_file="${MOCK_GH_LOG:?MOCK_GH_LOG must be set}"
printf '%s\n' "$*" >> "$log_file"

if [[ "$1" == "issue" && "$2" == "create" ]]; then
  printf 'https://github.com/example/repo/issues/%s\n' "${RANDOM}"
  exit 0
fi

echo "unexpected gh command: $*" >&2
exit 1
EOF

  chmod +x "$dir/bin/tk" "$dir/bin/gh"
}

run_query_mode_test() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  make_mock_bin "$tmp"

  local log_file="$tmp/gh.log"
  : >"$log_file"

  PATH="$tmp/bin:$PATH" MOCK_GH_LOG="$log_file" "$SCRIPT_PATH" target/repo --query 'select(.status=="open")' >/dev/null

  local lines
  lines="$(wc -l <"$log_file" | tr -d ' ')"
  assert_eq "2" "$lines" "query mode should create two issues"

  local log
  log="$(cat "$log_file")"
  assert_contains '--repo target/repo' "$log" 'gh calls should target provided repo'
  assert_contains '--title One' "$log" 'first issue title missing'
  assert_contains '--title Two' "$log" 'second issue title missing'
}

run_ready_mode_test() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  make_mock_bin "$tmp"

  local log_file="$tmp/gh.log"
  : >"$log_file"

  PATH="$tmp/bin:$PATH" MOCK_GH_LOG="$log_file" "$SCRIPT_PATH" target/repo --source ready >/dev/null

  local lines
  lines="$(wc -l <"$log_file" | tr -d ' ')"
  assert_eq "2" "$lines" "ready mode should create two issues"
}

run_query_mode_test
run_ready_mode_test

echo "PASS: tk-to-gh-issues"
