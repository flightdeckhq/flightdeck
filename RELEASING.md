# Releasing Flightdeck

## Versioning

Flightdeck follows [Semantic Versioning](https://semver.org/):

- **Major** (v1.0.0): Breaking API changes
- **Minor** (v0.2.0): New features, backward-compatible
- **Patch** (v0.1.1): Bug fixes
- **Pre-release** (v0.1.0a1): Alpha/beta releases

## Release Process

The version lives in one place, the root `VERSION` file.
`scripts/version.py` writes it into every other file that carries it: the
sensor (`sensor/pyproject.toml`), the plugin (`plugin/package.json`,
`plugin/.claude-plugin/plugin.json`), the marketplace entry (`version` and
`source.ref` in `.claude-plugin/marketplace.json`), the Helm chart
(`version`, `appVersion` and the default `image.tag`), the README's Helm
section and the two services' Swagger version. CI fails if any of them
differs from `VERSION` (`make version-check`).

`main` is protected, so a release is two steps: the version bump goes
through a pull request, and only the tag is pushed directly.

### 1. Open the release PR

```bash
make release-prep VERSION=vX.Y.Z
# or
./scripts/release.sh prep vX.Y.Z
```

From a clean, up-to-date `main`, the script:
1. Creates the branch `release/vX.Y.Z`
2. Writes `X.Y.Z` into `VERSION` and every version location
3. Dates the CHANGELOG: the `## Unreleased` entries move under
   `## vX.Y.Z — <date>`, and an empty `## Unreleased` stays above them
4. Runs `make test` (sensor, Go services, plugin and dashboard unit tests)
   and `make lint` (mypy, ruff, golangci-lint, the dashboard's ESLint and
   type-check); it stops if either fails. Both need the sensor venv, the
   dashboard's dependencies (`make -C dashboard install`) and
   `golangci-lint` on `PATH`
5. Commits `chore: release vX.Y.Z`, pushes the branch and opens the PR

Before merging, edit the release section's opening summary on the branch
if it no longer describes the release. The PR's CI is the rest of the
gate: it boots a fresh stack and applies every migration from scratch on
Postgres 16 and 18, runs the integration suites and the full Playwright
suite in both themes.

The playground (`make playground-all`) is **not** part of the gate: it
calls the real provider APIs, costs money and needs live credentials.
Run it by hand before a release that changes the sensor's interceptors
or event shapes (sensor/CLAUDE.md rule 40d), and note the result in the
release PR.

### 2. Tag the merged release

```bash
make release-tag VERSION=vX.Y.Z
# or
./scripts/release.sh tag vX.Y.Z
```

On an up-to-date `main` that contains the merged release PR, the script
checks that every version location matches `vX.Y.Z`, then creates the
annotated tag and pushes it.

Installed plugins do not pick up a release on their own. Claude Code's
background auto-update is off for third-party marketplaces unless each
user enables it under **Marketplaces** in `/plugin` (or an admin sets
`autoUpdate` in managed settings), and even then a user receives a new
copy only when the plugin's `version` changes, which every release does.
Tell users in the release notes to run
`claude plugin update flightdeck@flightdeck-plugins` (or
`/plugin marketplace update flightdeck-plugins` inside a session). To pin
installs to the exact tested commit rather than the tag name, set
`source.sha` on the marketplace entry in a follow-up PR once the tag
exists (`claude plugin validate .` checks the file).

### 2. GitHub Actions takes over

Pushing the tag triggers `.github/workflows/release.yml`, which:

- **Job 1 -- Scan Docker images:** First checks that the tag matches
  `VERSION` and every version location; then builds the four images without
  pushing them and scans each with Trivy. The release stops here, before
  anything is published, if an image has a HIGH or CRITICAL
  vulnerability with a fixed version available or a base image whose OS
  has reached end of life. The job log names each failing image.
- **Job 2 -- Publish sensor to PyPI:** Builds the wheel and sdist,
  publishes via OIDC trusted publishing (no API key stored)
- **Job 3 -- Build and push Docker images:** Builds and pushes four
  images to Docker Hub under the `flightdeckhq` org:
  - `flightdeckhq/flightdeck-ingestion`
  - `flightdeckhq/flightdeck-workers`
  - `flightdeckhq/flightdeck-api`
  - `flightdeckhq/flightdeck-dashboard`
- **Job 4 -- Create GitHub release:** Auto-generates release notes

### 3. Verify

- Check PyPI: https://pypi.org/project/flightdeck-sensor/
- Check Docker Hub: https://hub.docker.com/u/flightdeckhq
- Check GitHub: https://github.com/flightdeckhq/flightdeck/releases
- In production deployments, migrations run automatically when workers
  start -- verify the workers service starts successfully after deployment

## If a Release Fails

If the release pipeline fails mid-way:

1. **PyPI published but Docker failed:** If the failure was transient (a
   registry or network error), re-run the failed jobs from the Actions
   page: the PyPI step skips a version that already exists. If it needs a
   code change, release a patch version (vX.Y.Z+1). Do not move the tag:
   the published sensor was built from it.

2. **Nothing published:** Fix the issue on `main` (through a PR), delete
   the tag (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`) and
   run `make release-tag VERSION=vX.Y.Z` again on the fixed `main`.
   A failed image scan always lands here. The fix is usually a newer
   base image (`alpine`, `nginx`) or Go toolchain in the failing
   image's Dockerfile, or a dependency bump for a finding in the Go
   binary. The scan job's log says why each image failed: the package
   and its fixed version, "Detected EOL OS" for an end-of-life base, or
   the error if the vulnerability database could not be downloaded (a
   re-run usually clears that one).

3. **Everything published but release notes wrong:** Edit the GitHub
   release manually.

Do not manually upload to PyPI or Docker Hub. Always go through the
release pipeline to ensure consistency.
