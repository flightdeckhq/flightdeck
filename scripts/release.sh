#!/usr/bin/env bash
set -euo pipefail

# Flightdeck release, in two steps. main is protected, so the version
# bump goes through a pull request; only the tag is pushed directly.
#
#   ./scripts/release.sh prep v0.6.0   (or: make release-prep VERSION=v0.6.0)
#       From an up-to-date main: create release/v0.6.0, write the version
#       into every file that carries it (scripts/version.py), date the
#       CHANGELOG's Unreleased section, run make test + make lint, commit,
#       push the branch and open the release PR.
#
#   ./scripts/release.sh tag v0.6.0    (or: make release-tag VERSION=v0.6.0)
#       After the release PR is merged: on an up-to-date main, check that
#       every version location matches the tag, then create and push the
#       annotated tag. The tag starts .github/workflows/release.yml.

MODE="${1:-}"
VERSION="${2:-}"

usage() {
  echo "Usage: $0 prep|tag vX.Y.Z" >&2
  exit 1
}

[[ "$MODE" == "prep" || "$MODE" == "tag" ]] || usage
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([a-z]+[0-9]+)?$ ]] || {
  echo "Error: version must look like v0.6.0 (or v0.6.0rc1)" >&2
  exit 1
}
PLAIN="${VERSION#v}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first." >&2
  git status --short >&2
  exit 1
fi

# Both steps start from main exactly as it is on origin.
git fetch origin main --tags
git checkout main
git merge --ff-only origin/main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "Error: local main has commits origin/main does not; main must match origin." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null; then
  echo "Error: tag $VERSION already exists." >&2
  exit 1
fi

if [[ "$MODE" == "prep" ]]; then
  BRANCH="release/$VERSION"
  git checkout -b "$BRANCH"
  python3 scripts/version.py set "$PLAIN"
  python3 scripts/version.py changelog "$PLAIN"

  echo ""
  echo "Running tests and linters..."
  make test
  make lint
  echo "All tests and linters passed."

  git add VERSION
  git add -u
  git commit -m "chore: release $VERSION"
  git push -u origin "$BRANCH"
  gh pr create --base main --head "$BRANCH" --title "chore: release $VERSION" --body "$(cat <<EOF
Release $VERSION.

- \`VERSION\` and every file that carries the version (\`python3 scripts/version.py check\`) are at $PLAIN.
- \`CHANGELOG.md\`: the Unreleased entries are dated as $VERSION. Edit the section's opening summary on this branch before merging if it no longer describes the release.

After this merges, tag it: \`make release-tag VERSION=$VERSION\`.
EOF
)"
  echo ""
  echo "Release PR opened. After it merges: make release-tag VERSION=$VERSION"
  exit 0
fi

# MODE == tag
python3 scripts/version.py check --tag "$VERSION"
git tag -a "$VERSION" -m "Release $VERSION"
git push origin "$VERSION"

echo ""
echo "Tag $VERSION pushed. The GitHub Actions release workflow will now:"
echo "  1. Check the tag matches VERSION, then scan the Docker images"
echo "     (stops on a fixable HIGH/CRITICAL finding or an EOL base image)"
echo "  2. Publish flightdeck-sensor to PyPI"
echo "  3. Build and push the Docker images to Docker Hub"
echo "  4. Create the GitHub Release"
echo ""
echo "Monitor: https://github.com/flightdeckhq/flightdeck/actions"
