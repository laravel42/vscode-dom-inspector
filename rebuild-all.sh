#!/usr/bin/env bash
# Bump the version, build, package the VSIX and install it into your editor.
#
#   ./rebuild-all.sh            # patch bump
#   ./rebuild-all.sh minor      # minor bump
#   EDITOR_CLI=cursor ./rebuild-all.sh
set -euo pipefail

cd "$(dirname "$0")"

export BUMP="${1:-patch}"           # read by the "bump" script inside "package"
EDITOR_CLI="${EDITOR_CLI:-kiro}"    # editor CLI used to install the VSIX: kiro, code, cursor…

[ -d node_modules ] || pnpm install --frozen-lockfile

# Answer vsce's prompts with "y". Fed through process substitution, not a pipe:
# `yes | …` gets SIGPIPE when vsce exits, and with pipefail that aborted the
# script before the install step.
pnpm run package < <(yes)
version="$(node -p "require('./package.json').version")"
vsix="dom-inspector-${version}.vsix"
[ -f "$vsix" ] || { echo "✗ $vsix was not produced" >&2; exit 1; }

echo "→ installing $vsix with $EDITOR_CLI"
"$EDITOR_CLI" --install-extension "$vsix" --force
echo "✓ installed $vsix ($BUMP bump) with $EDITOR_CLI"
