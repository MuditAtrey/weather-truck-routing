#!/usr/bin/env bash
# Fails if tracked source or config files contain signs of hidden code: very long lines,
# obfuscator-style identifiers, code hidden after long runs of spaces, or dynamic
# evaluation in config files. Fake "job interview" malware in 2026 hid payloads exactly
# this way in vite/tailwind/eslint configs and in an `init` script run by `npm run dev`.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

files=$(git ls-files -- '*.js' '*.cjs' '*.mjs' '*.ts' '*.tsx' '*.py' '*.json' '*.sh' 'package.json' \
  | grep -v -E '(^|/)(package-lock\.json|uv\.lock|openapi\.json)$|/fixtures/|schema\.d\.ts$' || true)
status=0

for f in $files; do
  if awk 'length > 1000 { found = 1 } END { exit !found }' "$f"; then
    echo "::error file=$f::line longer than 1000 characters"; status=1
  fi
  if grep -nE '_0x[0-9a-f]{4,}|global\[.!.\]|global\[._V.\]' "$f"; then
    echo "::error file=$f::obfuscator-style identifier"; status=1
  fi
  if grep -nE '[^[:space:]] {120,}[^[:space:]]' "$f"; then
    echo "::error file=$f::code hidden after a long run of spaces"; status=1
  fi
done

for f in $(git ls-files -- '*config.*' 'frontend/package.json'); do
  if grep -nE '\beval\(|new Function\(' "$f"; then
    echo "::error file=$f::dynamic code evaluation in a config file"; status=1
  fi
done

if git ls-files | grep -E '(^|/)\.vscode/|(^|/)init$|temp_auto_push'; then
  echo "::error::editor task files or init scripts must not be committed"; status=1
fi

[ "$status" -eq 0 ] && echo "No signs of hidden code."
exit "$status"
