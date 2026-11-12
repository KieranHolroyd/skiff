#!/usr/bin/env bash
#
# Install the three harness dependencies. Safe to re-run.
#
#   ./setup.sh          # all
#   ./setup.sh js php   # a subset
set -euo pipefail
cd "$(dirname "$0")"

langs=("$@")
if [ "${#langs[@]}" -eq 0 ]; then langs=(js php go); fi

for lang in "${langs[@]}"; do
	case "$lang" in
		js)
			command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
			echo "==> js: npm install"
			(cd js && npm install --no-audit --no-fund)
			;;
		php)
			command -v php >/dev/null || { echo "php is required" >&2; exit 1; }
			command -v composer >/dev/null || { echo "composer is required" >&2; exit 1; }
			echo "==> php: composer install"
			(cd php && composer install --no-interaction --prefer-dist)
			;;
		go)
			command -v go >/dev/null || { echo "go is required" >&2; exit 1; }
			echo "==> go: go mod tidy"
			(cd go && go mod tidy)
			;;
		*)
			echo "unknown language: $lang" >&2
			exit 2
			;;
	esac
done
