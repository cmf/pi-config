#!/usr/bin/env bash
set -euo pipefail

HOME_DIR="${HOME:-$(cd ~ && pwd)}"
JDI_CLJ_REPO="${HOME_DIR}/dev/jdi-clj"

if [[ ! -d "${JDI_CLJ_REPO}" ]]; then
  echo "Expected jdi-clj repo at: ${JDI_CLJ_REPO}" >&2
  exit 1
fi

SDEPS="{:deps {jdi-clj/jdi-clj {:local/root \"${JDI_CLJ_REPO}\"} nrepl/nrepl {:mvn/version \"1.5.2\"}}}"

exec clojure -Sdeps "${SDEPS}" -M -m nrepl.cmdline "$@"
