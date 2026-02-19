#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  tk-to-gh-issues.sh OWNER/REPO [--source ready|query] [--query '<tk-query-expr>'] [--dry-run]

Examples:
  tk-to-gh-issues.sh my-org/my-repo --source ready
  tk-to-gh-issues.sh my-org/my-repo --query 'select(.status=="open")'

Notes:
  - --query implies --source query.
  - In ready mode, issue IDs are read from `tk ready`, then details are loaded via `tk query` and `tk show`.
USAGE
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

validate_repo() {
  local repo="$1"
  if [[ ! "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "Invalid target repo '$repo' (expected OWNER/REPO)" >&2
    exit 1
  fi
}

trim_leading_blank_lines() {
  awk 'BEGIN{seen=0} { if (!seen && $0 ~ /^[[:space:]]*$/) next; seen=1; print }'
}

strip_frontmatter() {
  awk '
    BEGIN { in_fm = 0; first = 1 }
    first {
      first = 0
      if ($0 ~ /^---[[:space:]]*$/) {
        in_fm = 1
        next
      }
    }
    in_fm {
      if ($0 ~ /^---[[:space:]]*$/) {
        in_fm = 0
      }
      next
    }
    { print }
  '
}

tk_query_as_array() {
  local expr="${1:-}"
  local raw

  if [[ -n "$expr" ]]; then
    raw="$(tk query "$expr")"
  else
    raw="$(tk query)"
  fi

  if [[ -z "${raw//[[:space:]]/}" ]]; then
    printf '[]\n'
    return
  fi

  # Supports these tk query output forms:
  # - one JSON array
  # - one JSON object
  # - JSON objects, one per line
  printf '%s\n' "$raw" | jq -cs '
    if length == 1 and (.[0] | type) == "array" then
      .[0]
    elif length == 1 and (.[0] | type) == "object" then
      [.[0]]
    else
      .
    end
  '
}

create_issue_from_ticket() {
  local target_repo="$1"
  local ticket_json="$2"
  local dry_run="$3"

  local id
  id="$(jq -r '.id // empty' <<<"$ticket_json")"
  local title
  title="$(jq -r '.title // empty' <<<"$ticket_json")"

  if [[ -z "$id" ]]; then
    echo "Skipping ticket with missing id: $ticket_json" >&2
    return 0
  fi

  local show_markdown
  show_markdown="$(tk show "$id")"

  if [[ -z "$title" ]]; then
    title="$(printf '%s\n' "$show_markdown" | awk '
      BEGIN { in_fm = 0; first = 1 }
      first {
        first = 0
        if ($0 ~ /^---[[:space:]]*$/) {
          in_fm = 1
          next
        }
      }
      in_fm {
        if ($0 ~ /^---[[:space:]]*$/) {
          in_fm = 0
          next
        }
        if ($0 ~ /^title:[[:space:]]*/) {
          sub(/^title:[[:space:]]*/, "", $0)
          gsub(/^"|"$/, "", $0)
          print
          exit
        }
        next
      }
      {
        if ($0 ~ /^#[[:space:]]+/) {
          sub(/^#[[:space:]]+/, "", $0)
          print
          exit
        }
      }
    ')"
  fi

  if [[ -z "$title" ]]; then
    echo "Skipping ticket $id: could not determine title from tk query/tk show" >&2
    return 0
  fi

  local body
  body="$(printf '%s\n' "$show_markdown" | strip_frontmatter | trim_leading_blank_lines)"

  if [[ -z "${body//[[:space:]]/}" ]]; then
    body="Migrated from tk ticket $id"
  else
    body+="\n\n---\nMigrated from tk ticket $id"
  fi

  if [[ "$dry_run" == "1" ]]; then
    echo "[dry-run] gh issue create --repo $target_repo --title $title --body-file -"
    return 0
  fi

  printf '%b' "$body" | gh issue create --repo "$target_repo" --title "$title" --body-file -
}

query_mode() {
  local target_repo="$1"
  local query_expr="$2"
  local dry_run="$3"

  local tickets_json
  tickets_json="$(tk_query_as_array "$query_expr")"

  local count
  count="$(jq 'length' <<<"$tickets_json")"
  if [[ "$count" == "0" ]]; then
    echo "No tickets found."
    return 0
  fi

  jq -c '.[]' <<<"$tickets_json" | while IFS= read -r ticket; do
    create_issue_from_ticket "$target_repo" "$ticket" "$dry_run"
  done
}

ready_mode() {
  local target_repo="$1"
  local dry_run="$2"

  local ready_out
  ready_out="$(tk ready)"

  if [[ -z "${ready_out//[[:space:]]/}" ]]; then
    echo "No tickets from tk ready."
    return 0
  fi

  local ids
  ids="$(printf '%s\n' "$ready_out" | sed -n 's/^\([A-Za-z0-9][A-Za-z0-9-]*\).*/\1/p')"

  if [[ -z "${ids//[[:space:]]/}" ]]; then
    echo "Unable to parse ticket IDs from tk ready output." >&2
    exit 1
  fi

  while IFS= read -r id; do
    [[ -z "$id" ]] && continue

    local ticket_json
    ticket_json="$(tk_query_as_array "select(.id == \"$id\")" | jq -c '.[0] // empty')"

    if [[ -z "$ticket_json" ]]; then
      echo "Skipping $id: not found via tk query." >&2
      continue
    fi

    create_issue_from_ticket "$target_repo" "$ticket_json" "$dry_run"
  done <<<"$ids"
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -eq 0 ]]; then
    usage
    exit 0
  fi

  local target_repo="$1"
  shift

  local source="ready"
  local query_expr=""
  local dry_run="0"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --source)
        source="${2:-}"
        shift 2
        ;;
      --query)
        query_expr="${2:-}"
        source="query"
        shift 2
        ;;
      --dry-run)
        dry_run="1"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done

  if [[ "$source" != "ready" && "$source" != "query" ]]; then
    echo "Invalid --source '$source' (expected ready|query)" >&2
    exit 1
  fi

  validate_repo "$target_repo"
  require_cmd tk
  require_cmd gh
  require_cmd jq

  if [[ "$source" == "query" ]]; then
    query_mode "$target_repo" "$query_expr" "$dry_run"
  else
    ready_mode "$target_repo" "$dry_run"
  fi
}

main "$@"
