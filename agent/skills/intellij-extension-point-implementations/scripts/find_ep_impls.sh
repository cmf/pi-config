#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  find_ep_impls.sh <extension-point-fqn> [--max N] [--offset N] [--plugin NAME_OR_ID_OR_XMLID] [--fetch-github-raw] [--raw-max-bytes N]

Examples:
  find_ep_impls.sh com.intellij.lang.formatter.restriction
  find_ep_impls.sh com.intellij.lang.formatter.restriction --max 50 --offset 0
  find_ep_impls.sh com.intellij.lang.formatter.restriction --plugin Scala
  find_ep_impls.sh com.intellij.lang.formatter.restriction --fetch-github-raw
EOF
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" || $# -lt 1 ]]; then
  usage
  exit 0
fi

for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: '$cmd' is required" >&2
    exit 1
  fi
done

EP=""
MAX=20
OFFSET=0
PLUGIN_FILTER=""
FETCH_GITHUB_RAW=false
RAW_MAX_BYTES=12000

EP="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max)
      MAX="$2"
      shift 2
      ;;
    --offset)
      OFFSET="$2"
      shift 2
      ;;
    --plugin)
      PLUGIN_FILTER="$2"
      shift 2
      ;;
    --fetch-github-raw)
      FETCH_GITHUB_RAW=true
      shift
      ;;
    --raw-max-bytes)
      RAW_MAX_BYTES="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

parse_github_repo() {
  local url="$1"
  if [[ "$url" =~ ^https?://github\.com/([^/]+)/([^/?#]+) ]]; then
    local owner="${BASH_REMATCH[1]}"
    local repo="${BASH_REMATCH[2]}"
    repo="${repo%.git}"
    echo "$owner $repo"
    return 0
  fi
  return 1
}

github_default_branch() {
  local owner="$1"
  local repo="$2"
  local branch

  branch=$(curl -sS \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: pi-skill-intellij-extension-point-implementations' \
    "https://api.github.com/repos/${owner}/${repo}" | jq -r '.default_branch // empty')

  if [[ -z "$branch" ]]; then
    branch=$(curl -sS "https://github.com/${owner}/${repo}" \
      | grep -oE '"defaultBranch":"[^"]+"' \
      | head -n 1 \
      | sed -E 's/.*"defaultBranch":"([^"]+)".*/\1/')
  fi

  echo "$branch"
}

github_repo_tree() {
  local owner="$1"
  local repo="$2"
  local branch="$3"

  curl -sS \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: pi-skill-intellij-extension-point-implementations' \
    "https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1"
}

github_list_dir_files() {
  local owner="$1"
  local repo="$2"
  local branch="$3"
  local dir="$4"

  curl -sS \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: pi-skill-intellij-extension-point-implementations' \
    "https://api.github.com/repos/${owner}/${repo}/contents/${dir}?ref=${branch}" \
    | jq -r 'if type=="array" then .[] | select(.type=="file") | .path else empty end'
}

github_search_api_paths() {
  local owner="$1"
  local repo="$2"
  local encoded_q="$3"

  local encoded_repo response
  encoded_repo=$(jq -rn --arg q "repo:${owner}/${repo}" '$q|@uri')

  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    response=$(curl -sS \
      -H 'Accept: application/vnd.github+json' \
      -H 'User-Agent: pi-skill-intellij-extension-point-implementations' \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      "https://api.github.com/search/code?q=${encoded_q}%20${encoded_repo}&per_page=20")
  else
    response=$(curl -sS \
      -H 'Accept: application/vnd.github+json' \
      -H 'User-Agent: pi-skill-intellij-extension-point-implementations' \
      "https://api.github.com/search/code?q=${encoded_q}%20${encoded_repo}&per_page=20")
  fi

  jq -r '.items[]?.path' <<<"$response"
}

probe_target_paths() {
  local owner="$1"
  local repo="$2"
  local branch="$3"
  local target="$4"

  local class_name package package_path
  class_name="${target##*.}"
  package="${target%.*}"
  package_path=""
  if [[ "$package" != "$target" ]]; then
    package_path="${package//./\/}/"
  fi

  local roots=(
    ""
    "src/main/java/"
    "src/main/kotlin/"
    "src/main/scala/"
    "src/main/groovy/"
    "src/main/clojure/"
    "src/"
    "scala/scala-impl/src/"
    "scala/scala-impl/test/"
    "scala/"
  )

  for root in "${roots[@]}"; do
    for ext in kt java scala groovy kts clj; do
      local path raw_url
      path="${root}${package_path}${class_name}.${ext}"
      raw_url="https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}"
      if curl -fsSL -o /dev/null "$raw_url" 2>/dev/null; then
        echo "$path"
        return 0
      fi
    done
  done

  return 1
}

probe_related_search_paths() {
  local owner="$1"
  local repo="$2"
  local branch="$3"
  local target="$4"
  local direct_path="$5"

  local class_name module_root
  class_name="${target##*.}"
  module_root=""

  local candidates_tmp
  candidates_tmp=$(mktemp)

  if [[ -n "$direct_path" ]]; then
    local ext dir test_name p
    ext="${direct_path##*.}"
    dir="${direct_path%/*}"
    test_name="${class_name}Test.${ext}"

    echo "${dir}/${test_name}" >> "$candidates_tmp"
    echo "${direct_path%/*}/${class_name}Tests.${ext}" >> "$candidates_tmp"

    p="${direct_path/\/src\//\/test\/}"
    if [[ "$p" != "$direct_path" ]]; then
      p="${p%/*}/${test_name}"
      echo "$p" >> "$candidates_tmp"
    fi

    p="${direct_path/\/src\/main\//\/src\/test\/}"
    if [[ "$p" != "$direct_path" ]]; then
      p="${p%/*}/${test_name}"
      echo "$p" >> "$candidates_tmp"
    fi

    if [[ "$direct_path" == *"/src/"* ]]; then
      module_root="${direct_path%%/src/*}"
    elif [[ "$direct_path" == *"/test/"* ]]; then
      module_root="${direct_path%%/test/*}"
    fi

    if [[ -n "$module_root" ]]; then
      echo "${module_root}/resources/META-INF/plugin.xml" >> "$candidates_tmp"
      echo "${module_root}/src/main/resources/META-INF/plugin.xml" >> "$candidates_tmp"
      echo "${module_root}/META-INF/plugin.xml" >> "$candidates_tmp"

      while IFS= read -r path; do
        [[ -z "$path" ]] && continue
        if [[ "$path" == *.xml ]]; then
          echo "$path" >> "$candidates_tmp"
        fi
      done < <(github_list_dir_files "$owner" "$repo" "$branch" "${module_root}/resources/META-INF")

      while IFS= read -r path; do
        [[ -z "$path" ]] && continue
        if [[ "$path" == *.xml ]]; then
          echo "$path" >> "$candidates_tmp"
        fi
      done < <(github_list_dir_files "$owner" "$repo" "$branch" "${module_root}/src/main/resources/META-INF")
    fi
  fi

  echo "resources/META-INF/plugin.xml" >> "$candidates_tmp"
  echo "src/main/resources/META-INF/plugin.xml" >> "$candidates_tmp"
  echo "META-INF/plugin.xml" >> "$candidates_tmp"

  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    if [[ "$path" == *.xml ]]; then
      echo "$path" >> "$candidates_tmp"
    fi
  done < <(github_list_dir_files "$owner" "$repo" "$branch" "resources/META-INF")

  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    if [[ "$path" == *.xml ]]; then
      echo "$path" >> "$candidates_tmp"
    fi
  done < <(github_list_dir_files "$owner" "$repo" "$branch" "src/main/resources/META-INF")

  sort -u "$candidates_tmp" | while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    local raw_url
    raw_url="https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}"

    if [[ "$path" == *.xml ]]; then
      local body
      body=$(curl -fsSL "$raw_url" 2>/dev/null || true)
      if [[ -n "$body" ]]; then
        if grep -Fq "$class_name" <<<"$body" || grep -Fq "$target" <<<"$body"; then
          echo "$path"
        fi
      fi
    else
      if curl -fsSL -o /dev/null "$raw_url" 2>/dev/null; then
        echo "$path"
      fi
    fi
  done

  rm -f "$candidates_tmp"
}

collect_github_search_results() {
  local repo_url="$1"
  local search_urls_json="$2"

  local owner_repo owner repo branch
  if ! owner_repo=$(parse_github_repo "$repo_url"); then
    echo '[]'
    return 0
  fi

  owner="${owner_repo%% *}"
  repo="${owner_repo##* }"
  branch=$(github_default_branch "$owner" "$repo")

  if [[ -z "$branch" ]]; then
    echo '[]'
    return 0
  fi

  local tree_json=""
  local tree_has_items="unknown"

  local out_tmp
  out_tmp=$(mktemp)

  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue

    local target search_url encoded_q
    target=$(jq -r '.key' <<<"$entry")
    search_url=$(jq -r '.value' <<<"$entry")

    [[ -z "$search_url" || "$search_url" == "null" ]] && continue

    encoded_q="${search_url#*?q=}"
    encoded_q="${encoded_q%%&*}"
    [[ -z "$encoded_q" ]] && continue

    local count direct_path
    count=0
    direct_path=""

    while IFS= read -r path; do
      [[ -z "$path" ]] && continue
      jq -nc --arg path "$path" --arg rawUrl "https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}" '{path: $path, rawUrl: $rawUrl}' >> "$out_tmp"
      count=$((count + 1))
      if [[ "$count" -ge 8 ]]; then
        break
      fi
    done < <(github_search_api_paths "$owner" "$repo" "$encoded_q")

    if direct_path=$(probe_target_paths "$owner" "$repo" "$branch" "$target"); then
      if [[ "$count" -lt 8 ]]; then
        jq -nc --arg path "$direct_path" --arg rawUrl "https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${direct_path}" '{path: $path, rawUrl: $rawUrl}' >> "$out_tmp"
        count=$((count + 1))
      fi
    else
      direct_path=""
    fi

    while IFS= read -r path; do
      [[ -z "$path" ]] && continue
      if [[ "$count" -ge 8 ]]; then
        break
      fi
      jq -nc --arg path "$path" --arg rawUrl "https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}" '{path: $path, rawUrl: $rawUrl}' >> "$out_tmp"
      count=$((count + 1))
    done < <(probe_related_search_paths "$owner" "$repo" "$branch" "$target" "$direct_path")

    if [[ "$count" -eq 0 ]]; then
      if [[ "$tree_has_items" == "unknown" ]]; then
        tree_json=$(github_repo_tree "$owner" "$repo" "$branch")
        tree_has_items=$(jq -r '(.tree | type == "array") and ((.tree | length) > 0)' <<<"$tree_json")
      fi

      if [[ "$tree_has_items" == "true" ]]; then
        local term
        term="${encoded_q//+/ }"
        term="${term//%20/ }"
        term="${term%% *}"
        term="${term##*.}"
        term=$(tr '[:upper:]' '[:lower:]' <<<"$term")

        if [[ -n "$term" ]]; then
          while IFS= read -r path; do
            [[ -z "$path" ]] && continue
            jq -nc --arg path "$path" --arg rawUrl "https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}" '{path: $path, rawUrl: $rawUrl}' >> "$out_tmp"
            count=$((count + 1))
            if [[ "$count" -ge 8 ]]; then
              break
            fi
          done < <(
            jq -r \
              --arg term "$term" \
              '(
                 [ .tree[]? | select(.type == "blob") | .path
                   | select(test("\\.(kt|java|scala|groovy|kts|clj|xml)$"))
                   | select((ascii_downcase) | contains($term))
                 ]
                 | .[:20]
                 | .[]
               )' <<<"$tree_json"
          )
        fi
      fi
    fi
  done < <(jq -rc 'to_entries[]?' <<<"$search_urls_json")

  local out
  out=$(jq -s 'unique_by(.path)' "$out_tmp")
  rm -f "$out_tmp"

  echo "$out"
}

fetch_raw_object() {
  local path="$1"
  local raw_url="$2"
  local max_bytes="$3"

  local tmp size trunc content_json
  tmp=$(mktemp)
  if ! curl -fsSL "$raw_url" -o "$tmp"; then
    rm -f "$tmp"
    return 1
  fi

  size=$(wc -c < "$tmp" | tr -d ' ')
  trunc=false
  if (( size > max_bytes )); then
    trunc=true
  fi

  content_json=$(head -c "$max_bytes" "$tmp" | jq -Rs .)
  rm -f "$tmp"

  jq -nc \
    --arg path "$path" \
    --arg rawUrl "$raw_url" \
    --argjson size "$size" \
    --argjson truncated "$trunc" \
    --argjson content "$content_json" \
    '{path: $path, rawUrl: $rawUrl, size: $size, truncated: $truncated, content: $content}'
}

collect_github_raw_files() {
  local repo_url="$1"
  local targets_json="$2"

  local owner_repo owner repo branch
  if ! owner_repo=$(parse_github_repo "$repo_url"); then
    echo '{}'
    return 0
  fi

  owner="${owner_repo%% *}"
  repo="${owner_repo##* }"
  branch=$(github_default_branch "$owner" "$repo")

  if [[ -z "$branch" ]]; then
    echo '{}'
    return 0
  fi

  local tree_json=""
  local tree_has_items="unknown"

  local map_tmp
  map_tmp=$(mktemp)

  while IFS= read -r target; do
    [[ -z "$target" ]] && continue

    local class_name package package_path direct_found
    class_name="${target##*.}"
    package="${target%.*}"
    package_path=""
    if [[ "$package" != "$target" ]]; then
      package_path="${package//./\/}/"
    fi

    local files_tmp
    files_tmp=$(mktemp)
    direct_found=false

    local direct_path
    if direct_path=$(probe_target_paths "$owner" "$repo" "$branch" "$target"); then
      local raw_url obj
      raw_url="https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${direct_path}"
      if obj=$(fetch_raw_object "$direct_path" "$raw_url" "$RAW_MAX_BYTES" 2>/dev/null); then
        echo "$obj" >> "$files_tmp"
        direct_found=true
      fi
    fi

    if [[ "$direct_found" == false ]]; then
      if [[ "$tree_has_items" == "unknown" ]]; then
        tree_json=$(github_repo_tree "$owner" "$repo" "$branch")
        tree_has_items=$(jq -r '(.tree | type == "array") and ((.tree | length) > 0)' <<<"$tree_json")
      fi

      if [[ "$tree_has_items" == "true" ]]; then
        local count
        count=0
        while IFS= read -r path; do
          [[ -z "$path" ]] && continue
          local raw_url obj
          raw_url="https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}"
          if obj=$(fetch_raw_object "$path" "$raw_url" "$RAW_MAX_BYTES" 2>/dev/null); then
            echo "$obj" >> "$files_tmp"
            count=$((count + 1))
            if [[ "$count" -ge 2 ]]; then
              break
            fi
          fi
        done < <(
          jq -r \
            --arg class "$class_name" \
            --arg pkg "$package_path" \
            '(
                [ .tree[]? | select(.type == "blob") | .path
                  | select(test("(^|/)" + $class + "\\.(kt|java|scala|groovy|kts|clj)$"))
                  | {path: ., rank: (if $pkg != "" and contains($pkg) then 0 else 1 end)}
                ]
                | sort_by(.rank, .path)
                | .[:8]
                | .[].path
              )' <<<"$tree_json"
        )
      fi
    fi

    local files_json
    files_json=$(jq -s '.' "$files_tmp")
    rm -f "$files_tmp"

    jq -nc --arg key "$target" --argjson value "$files_json" '{key: $key, value: $value}' >> "$map_tmp"
  done < <(jq -r '.[]' <<<"$targets_json")

  local out
  out=$(jq -s 'from_entries' "$map_tmp")
  rm -f "$map_tmp"

  echo "$out"
}

read -r -d '' GRAPHQL_QUERY <<EOF || true
{ plugins(search: {
    max: ${MAX},
    offset: ${OFFSET},
    filters: [
      { field: "fields.extensionPoints", value: "${EP}" },
      { field: "hasSource", value: "true" },
      { field: "family", value: "intellij" }
    ],
    sortBy: UPDATE_DATE
  }) {
    total,
    plugins {
      id,
      name,
      xmlId,
      sourceCodeUrl,
      link,
      lastUpdateDate
    }
  }
}
EOF

SEARCH_PAYLOAD=$(jq -nc --arg query "$GRAPHQL_QUERY" '{query: $query}')
SEARCH_RESPONSE=$(curl -sS 'https://plugins.jetbrains.com/api/search/graphql' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  --data "$SEARCH_PAYLOAD")

TOTAL=$(jq -r '.data.plugins.total // 0' <<<"$SEARCH_RESPONSE")
PLUGINS=$(jq -c '.data.plugins.plugins // [] | .[]' <<<"$SEARCH_RESPONSE")

if [[ -n "$PLUGIN_FILTER" ]]; then
  PLUGINS=$(jq -c \
    --arg f "$PLUGIN_FILTER" \
    '.data.plugins.plugins // []
     | map(select(
         ((.id|tostring) == $f)
         or ((.xmlId // "" | ascii_downcase) == ($f | ascii_downcase))
         or ((.name // "" | ascii_downcase) | contains($f | ascii_downcase))
       ))
     | .[]' <<<"$SEARCH_RESPONSE")
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

while IFS= read -r plugin; do
  [[ -z "$plugin" ]] && continue

  id=$(jq -r '.id' <<<"$plugin")
  source_url=$(jq -r '.sourceCodeUrl // empty' <<<"$plugin")

  ep_response=$(curl -sS "https://plugins.jetbrains.com/api/plugins/${id}/extension-points")
  matches=$(jq -c --arg ep "$EP" '[.[] | select(.interfaceName == $ep)]' <<<"$ep_response")
  match_count=$(jq -r 'length' <<<"$matches")

  if [[ "$match_count" -eq 0 ]]; then
    continue
  fi

  targets=$(jq -c '[ .[] | [ .implementationName, (.attributes[]? | .[]?) ][] | select(type == "string" and test("\\.")) ] | unique' <<<"$matches")

  search_urls='{}'
  if [[ -n "$source_url" && "$targets" != "[]" ]]; then
    source_payload=$(jq -nc --arg repositoryUrl "$source_url" --argjson targets "$targets" '{repositoryUrl: $repositoryUrl, targets: $targets}')
    source_response=$(curl -sS 'https://plugins.jetbrains.com/api/source-code-search' \
      -H 'Content-Type: application/json' \
      --data "$source_payload")
    search_urls=$(jq -c '.sourceCodeSearchUrls // {}' <<<"$source_response")
  fi

  search_raw_files='[]'
  if [[ -n "$source_url" && "$search_urls" != "{}" ]]; then
    search_raw_files=$(collect_github_search_results "$source_url" "$search_urls")
  fi

  github_raw_files='{}'
  if [[ "$FETCH_GITHUB_RAW" == true && -n "$source_url" && "$targets" != "[]" ]]; then
    github_raw_files=$(collect_github_raw_files "$source_url" "$targets")
  fi

  jq -nc \
    --argjson plugin "$plugin" \
    --argjson matches "$matches" \
    --argjson searchRawFiles "$search_raw_files" \
    --argjson githubRawFiles "$github_raw_files" \
    '{plugin: $plugin, implementations: $matches, searchRawFiles: $searchRawFiles, githubRawFiles: $githubRawFiles}' >> "$TMP"
done <<<"$PLUGINS"

jq -s --arg ep "$EP" --argjson total "$TOTAL" --arg pluginFilter "$PLUGIN_FILTER" '{
  extensionPoint: $ep,
  marketplaceMatches: $total,
  pluginFilter: (if $pluginFilter == "" then null else $pluginFilter end),
  results: .
}' "$TMP"
