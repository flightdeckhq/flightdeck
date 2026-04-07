#!/usr/bin/env bash
set -euo pipefail

# Flightdeck release script
# Usage: ./scripts/release.sh v0.1.0
#   or:  make release VERSION=v0.1.0

VERSION="${1:-}"

# --- Validate ---

if [[ -z "$VERSION" ]]; then
  read -rp "Enter version tag (e.g. v0.1.0): " VERSION
fi

if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+.*$ ]]; then
  echo "Error: version must match v*.*.* (e.g. v0.1.0, v0.1.0a1)"
  exit 1
fi

# Strip leading 'v' for pyproject.toml (PEP 440)
PEP_VERSION="${VERSION#v}"

# Check clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  git status --short
  exit 1
fi

# Confirm current branch is main
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on main branch (currently on '$BRANCH')"
  exit 1
fi

echo "Releasing $VERSION (pyproject: $PEP_VERSION)"
echo ""

# --- Update version ---

sed -i "s/^version = \".*\"/version = \"$PEP_VERSION\"/" sensor/pyproject.toml
echo "Updated sensor/pyproject.toml version to $PEP_VERSION"

# --- Run tests ---

echo ""
echo "Running tests..."
make test
echo "All tests passed."

# --- Commit, tag, push ---

git add sensor/pyproject.toml
git commit -m "chore: release $VERSION"
git tag -a "$VERSION" -m "Release $VERSION"

echo ""
echo "Pushing to origin..."
git push origin main --tags

echo ""
echo "Release $VERSION pushed successfully."
echo ""
echo "The GitHub Actions release workflow will now:"
echo "  1. Publish flightdeck-sensor to PyPI"
echo "  2. Build and push Docker images to Docker Hub"
echo "  3. Create a GitHub Release"
echo ""
echo "Monitor: https://github.com/flightdeckhq/flightdeck/actions"
