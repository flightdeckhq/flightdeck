# Releasing Flightdeck

## Versioning

Flightdeck follows [Semantic Versioning](https://semver.org/):

- **Major** (v1.0.0): Breaking API changes
- **Minor** (v0.2.0): New features, backward-compatible
- **Patch** (v0.1.1): Bug fixes
- **Pre-release tag** (v0.9.0-rc.1): a dry run of the release pipeline
  and the install gate on the version the files already carry (see
  "Dry run" below). It is never written into the version locations: the
  sensor needs the PEP 440 form (`0.9.0rc1`) and the Helm chart the
  SemVer form (`0.9.0-rc1`), so one `VERSION` string cannot serve both.

## What a release ships

One tag produces every artifact, all built from the same commit:

| Artifact | Where | Built by |
|---|---|---|
| `flightdeck` binary for linux, darwin and windows on amd64 and arm64, as `flightdeck_<os>_<arch>.tar.gz` (`.zip` on Windows) with `checksums.txt` | the GitHub release | goreleaser (`.goreleaser.yaml`) |
| Release notes | the GitHub release | the tag's section of CHANGELOG.md (`scripts/release_notes.py`) |
| Homebrew formula `flightdeck` | [flightdeckhq/homebrew-tap](https://github.com/flightdeckhq/homebrew-tap) | goreleaser (stable tags only) |
| `flightdeck-cli` wheels, one per platform, carrying the binary | PyPI | `packaging/pypi/build_wheels.py` |
| `flightdeck-sensor` | PyPI | `python -m build` in `sensor/` |
| `flightdeckhq/flightdeck` image, linux/amd64 and linux/arm64, `:<tag>` and `:latest` | Docker Hub | the root `Dockerfile` with buildx |

`install.sh` and `install.ps1` download from the GitHub release. Users
fetch them from the project's site, `https://flightdeck-hq.com/install.sh`
and `https://flightdeck-hq.com/install.ps1`: GitHub Pages serves `docs/`
of `main` there as static files and cannot redirect to the repository's
raw file, so `docs/install.sh` and `docs/install.ps1` are copies of the
root installers. `make installer-copies` refreshes them after an edit,
and CI fails when a copy differs from its source
(`scripts/check-installer-copies.sh`). An installer change reaches users
once it is on `main` and Pages has deployed, a few minutes after the
merge. To check, on an up-to-date `main`:

```bash
curl -fsSL https://flightdeck-hq.com/install.sh | cmp - install.sh
```

The repository's raw address
(`https://raw.githubusercontent.com/flightdeckhq/flightdeck/main/install.sh`,
and `install.ps1` beside it) serves the same files and is the fallback
when the site is unreachable.

The short address changes nothing about what is installed. Whichever
address the script came from, it downloads only from the GitHub release
over HTTPS, verifies the archive against `checksums.txt`, and verifies
the Sigstore signature of `checksums.txt` when cosign is installed. The
script itself is the repository's `main` branch at both addresses,
published by GitHub over HTTPS, and signed at neither, which is why the
installers' headers say to read them before piping. The site's address
does rest on one thing more than the raw address: the domain's DNS
record and its binding to this repository's Pages site, so whoever
controls the domain can serve another script from it.

## Release process

The version lives in one place, the root `VERSION` file.
`scripts/version.py` writes it into every other file that carries it: the
sensor (`sensor/pyproject.toml`), the plugin (`plugin/package.json`,
`plugin/.claude-plugin/plugin.json`), the marketplace entry (`version` and
`source.ref` in `.claude-plugin/marketplace.json`), the Helm chart
(`version`, `appVersion` and the default `image.tag`), the Helm section
of `guides/self-hosting.md`, the compose file's image (`docker/docker-compose.yml`)
and the commented default in `docker/.env.example`, and the two services'
Swagger version. CI fails if any of them
differs from `VERSION` (`make version-check`).

`main` is protected, so a release is two steps: the version bump goes
through a pull request, and only the tag is pushed directly.

### Before the first release that ships the binary

The README on `main` tells a new user to run
`curl -fsSL https://flightdeck-hq.com/install.sh | sh` (or
`irm https://flightdeck-hq.com/install.ps1 | iex` on Windows), then to
connect a Python agent with `pip install flightdeck-sensor` and
`flightdeck_sensor.init()` with no arguments. All of that works only when
everything below holds: v0.8.0 and earlier have no binary assets, and
flightdeck-sensor 0.8.0, the latest on PyPI, requires `server` and
`token` (the no-argument `init()` first ships in the release after
v0.8.0). So each line is a gate, in this order, before and after the
first tag whose release carries the binary:

- [x] **#303 and #313 are merged** (Compose and the Helm chart on the
  one image), which the README's Compose and Helm lines and
  `guides/self-hosting.md` describe.
- [x] **The README with the install commands (#314) is merged, after
  them.** From that merge until the final tag is out, `main`'s README
  and the site show install commands that find no binary and a sensor
  snippet that fails against flightdeck-sensor 0.8.0, so merge it when
  the release is next.
- [x] **Pages has deployed and serves this `main`'s installers.** Both
  must answer 200 with the bytes of the files about to be tagged:

  ```bash
  curl -fsSI https://flightdeck-hq.com/install.sh
  curl -fsSL https://flightdeck-hq.com/install.sh | cmp - install.sh
  curl -fsSL https://flightdeck-hq.com/install.ps1 | cmp - install.ps1
  ```

  The install gate repeats the comparison against the tag's scripts and
  goes red when the site serves anything else.
- [ ] **A dry run passes first.** Once the release PR (step 1) has
  set `VERSION` to `X.Y.Z` on `main`, tag `vX.Y.Z-rc.1` there as "Dry
  run: a pre-release tag" below describes (a new `-rc.N` after each
  fix; the version guard requires the rc's `X.Y.Z` to match `VERSION`). The
  Release workflow publishes the pre-release: the GitHub pre-release
  with its assets, `flightdeck-cli` as `X.Y.ZrcN` on PyPI and the image
  as `flightdeckhq/flightdeck:vX.Y.Z-rc.N` on Docker Hub; no Homebrew
  formula and no flightdeck-sensor. Then:
  - the install gate is green on all five legs (it starts when the
    Release workflow succeeds; `gh run list --workflow install-gate.yml`
    shows it). Its installer legs also require the site to serve the
    tag's `install.sh` and `install.ps1`; on an rc its macos-arm64 leg
    installs with `install.sh`, since the tap carries no pre-release;
  - the channels, by hand, on a machine whose `localhost:4000` holds no
    real data (a fresh VM). The installers come from the site, pinned to
    the rc because their default, the latest release, skips
    pre-releases:

    ```bash
    curl -fsSL https://flightdeck-hq.com/install.sh | VERSION=vX.Y.Z-rc.N sh
    pip install flightdeck-cli==X.Y.ZrcN
    docker run --rm flightdeckhq/flightdeck:vX.Y.Z-rc.N --version
    ```

    ```powershell
    $env:VERSION = 'vX.Y.Z-rc.N'; irm https://flightdeck-hq.com/install.ps1 | iex
    ```

    Each `flightdeck --version` prints `flightdeck vX.Y.Z-rc.N`, and
    `flightdeck` started from the shell installer serves the dashboard
    on `http://localhost:4000`. Homebrew cannot be checked on an rc: the
    tap gets a formula from a stable tag only, and is checked after the
    final tag (below).

  Only then the final tag, `vX.Y.Z` (step 2), on the same `main`.
- [ ] **The final release has its assets**, which are what the
  installers download: the six archives, `checksums.txt` and its
  Sigstore bundle. `gh release view vX.Y.Z --json assets -q
  '.assets[].name'` lists them, and the install gate, green on all five
  legs, installs from them, the macos-arm64 leg through `brew install
  flightdeckhq/tap/flightdeck` and `brew services`.
- [ ] **flightdeck-sensor X.Y.Z is on PyPI and the README's snippet
  runs.** The final tag publishes it in the same run as the binary
  (the `publish-sensor` job, stable tags only, after `flightdeck-cli`),
  so the sensor with the no-argument `init()` reaches PyPI with the
  release that makes the install commands work, never after it. If
  `publish-sensor` failed, the install commands work while the README's
  sensor snippet does not: re-run it ("If a release fails", case 2)
  before announcing the release. Then, on a machine where a
  `flightdeck` from this release is the only thing on
  `localhost:4000`, in a fresh virtualenv: `pip install
  flightdeck-sensor` resolves to `X.Y.Z`, and the README's lines

  ```python
  import flightdeck_sensor

  flightdeck_sensor.init()
  flightdeck_sensor.patch()
  ```

  run with one warning (the development token in use) and no error,
  and the session appears in the dashboard.

Later releases need none of this: CI keeps the site's copies identical
to the root installers. Delete this section once that release is out.

### 1. Open the release PR

```bash
make release-prep VERSION=vX.Y.Z
# or
./scripts/release.sh prep vX.Y.Z
```

From a clean, up-to-date `main`, the script:
1. Checks that `python3`, `gh`, `uv`, `golangci-lint`, `npm` and `go` are
   on `PATH`
2. Runs `make test` (sensor, Go services, the binary, plugin and
   dashboard unit tests) and `make lint` on `main`, before changing
   anything; it stops if either fails. Both need the sensor venv and the
   dashboard's dependencies (`make -C dashboard install`)
3. Creates the branch `release/vX.Y.Z`
4. Writes `X.Y.Z` into `VERSION` and every version location (including
   `sensor/uv.lock`'s own entry, so CI's `uv sync --locked` accepts it)
5. Dates the CHANGELOG: the `## Unreleased` entries move under
   `## vX.Y.Z — <date>`, and an empty `## Unreleased` stays above them
6. Commits `chore: release vX.Y.Z`, pushes the branch and opens the PR

If the push or `gh pr create` fails, the commit is on the local
`release/vX.Y.Z` branch: fix the cause, then run
`git push -u origin release/vX.Y.Z` and `gh pr create` by hand (a second
`prep` refuses to run while that branch exists).

Before merging, edit the release section's opening summary on the branch
if it no longer describes the release. The PR's CI is the rest of the
gate: it boots a fresh stack and applies every migration from scratch on
Postgres 16 and 18, runs the integration suites and the full Playwright
suite in both themes, cross-builds the six release binaries
(`goreleaser build --snapshot`), builds the Docker image and runs the
install gate's checks (step 4) on the binary and on that image.

The playground (`make playground-all`) is **not** part of the gate: it
calls the real provider APIs, costs money and needs live credentials.
Run it by hand before a release that changes the sensor's interceptors
or event shapes (sensor/CLAUDE.md rule 40d), and note the result in the
release PR.

### 2. Tag the merged release

Tag as soon as the release PR merges. From the merge until the tag
exists, `main`'s marketplace entry points at a `vX.Y.Z` ref that does not
exist yet, so plugin installs and updates fail in that window.

```bash
make release-tag VERSION=vX.Y.Z
# or
./scripts/release.sh tag vX.Y.Z
```

On an up-to-date `main` that contains the merged release PR, the script
checks that every version location matches `vX.Y.Z` and that the
CHANGELOG has a dated `## vX.Y.Z` section, then creates the annotated tag
and pushes it.

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

### 3. GitHub Actions takes over

Pushing the tag triggers `.github/workflows/release.yml`:

- **verify**: the tag matches `VERSION` and every version location
  (`scripts/version.py check --tag`), then `govulncheck` runs on the
  root module and on `api`, `ingestion`, `workers` and `storage`. A
  known vulnerability in code the binaries reach stops the release
  before anything is published.
- **webui** (after verify): builds the dashboard bundle with read-only
  permissions and hands it over as an artifact.
- **goreleaser** (after webui): cross-compiles the six binaries with
  the bundle embedded, writes the archives and `checksums.txt`, signs
  `checksums.txt` keyless with cosign, creates the GitHub release with
  the tag's CHANGELOG section as its notes and uploads the assets, and
  pushes the Homebrew formula to the tap (stable tags only). The
  binaries are kept as a workflow artifact.
- **publish-cli** (after goreleaser): builds one `flightdeck-cli` wheel
  per platform from those binaries and publishes them to PyPI through
  OIDC trusted publishing (no API key stored).
- **publish-sensor** (after verify, stable tags only): builds and
  publishes `flightdeck-sensor` the same way.
- **publish-docker** (after goreleaser): builds the image for
  linux/amd64, scans it with Trivy (the release fails on a HIGH or
  CRITICAL vulnerability with a fix available, or an end-of-life base),
  then builds linux/amd64 and linux/arm64 and pushes
  `flightdeckhq/flightdeck:<tag>` and, for a stable tag, `:latest`.

When the Release workflow completes successfully,
`.github/workflows/install-gate.yml` starts on its own.

### 4. The install gate

The gate installs what was just published on fresh runners, the way a
user would, and runs `scripts/install-gate.sh` against it: start
`flightdeck` with no database and nothing else configured (the script
removes the binary's settings from its environment), wait for
`/ingest/health` and for the binary's own start-up block (an answer
alone could be another server that took the port), read the token
from the start-up block, require that
block to name a SQLite database and `flightdeck.db` to be in the data
dir, check `/runtime-config.json` and `GET /` (the dashboard), require
a 401 from `/api/v1/sessions` and from `/ingest/v1/events` with no token
and with a wrong one, POST one sensor-shaped `session_start` to
`/ingest/v1/events` with the token, read the session back from
`GET /api/v1/sessions/{id}` and `GET /api/v1/sessions`, stop it with
SIGINT and require a clean exit within 75 seconds (the binary's own
shutdown bound; a process that has to be killed fails the leg), then
start it again on the same data dir and require the session to be
served still. Each leg has a job timeout, so a step that wedges fails
the leg in minutes.

| Leg | Runner | Channel |
|---|---|---|
| linux-amd64 | ubuntu-24.04 | `install.sh` piped from the raw URL of the tag, after a check that `https://flightdeck-hq.com/install.sh` serves the same bytes; `pip install flightdeck-cli==<version>` and `uvx flightdeck-cli`; `docker run -p … -v <new volume>:/data flightdeckhq/flightdeck:<tag>` (token read from `docker logs`, no data-dir warning in them, clean `docker stop`, then a new container on the same volume serves the session); the `install.sh` binary once more with `--database-url` on a Postgres service container |
| linux-arm64 | ubuntu-24.04-arm | `install.sh`, with the same check of the site's copy |
| macos-arm64 | macos-14 | `brew install flightdeckhq/tap/flightdeck`, `brew test`, the checks on the installed binary, then `brew services start flightdeck`: the same checks against the service on `:4000` (start-up block read from its log), `~/.flightdeck/flightdeck.db` exists, and the session is served after `brew services stop` and `start` |
| macos-amd64 | macos-15-intel | `install.sh` |
| windows-amd64 | windows-2022 | `install.ps1` piped from the raw URL of the tag under Windows PowerShell 5.1 (the `.zip`), after a check under 5.1 and PowerShell 7 that `irm https://flightdeck-hq.com/install.ps1` returns the same script, then the checks under Git Bash |

Every leg checks `flightdeck --version` prints `flightdeck <tag>`. No
leg starts or names a database: the binary's default, a SQLite file in
its data dir, is what a new user gets, so it is what the gate proves on
every platform. Postgres stays a supported database, so one leg,
linux-amd64, runs the checks a second time with `--database-url` against
an empty Postgres in a service container (`GATE_EXPECT_DATABASE=Postgres`
makes the script require a Postgres in the start-up block). On Windows
the checks run under Git Bash, which cannot send the binary a Ctrl+C:
the stop there ends the process outright, so that leg's restart also
proves a start after a kill, and its exit status is not checked.

On a pre-release tag the tap has no formula, so the macos-arm64 leg
installs with `install.sh` and its `brew services` step does not run;
that step runs on stable tags only.

`scripts/install-gate.sh` is also run by CI on every pull request,
against the binary it builds (SQLite, then Postgres) and against the
image (a new volume, a read-only root filesystem, a second container on
the same volume), so the script and the image's data dir are not first
exercised on a tag. It runs locally the same way:
`scripts/install-gate.sh run 127.0.0.1:4100 bin/flightdeck`.
`scripts/test-install-gate.sh` tests the script itself against fake
binaries, each broken in one way the gate must catch (it exits at once,
never listens and ignores SIGINT, never serves the session, needs no
token, will not stop, forgets the session over a restart); CI runs it
with the other script tests, and `scripts/test-install-gate.sh
bin/flightdeck` adds a run against a real binary.

The gate runs after the publish, so a red leg means something was
published that does not install or run on that platform. Fix forward
with a patch release; the next section says what not to do.

A gate run can be repeated by hand against any published tag from the
Actions tab (**Install gate → Run workflow**, enter the tag) or with
`gh workflow run install-gate.yml -f tag=vX.Y.Z`.

### 5. Verify

- The GitHub release has six archives, `checksums.txt` and the
  CHANGELOG section as notes: https://github.com/flightdeckhq/flightdeck/releases
- The tap's `Formula/flightdeck.rb` names the new version:
  https://github.com/flightdeckhq/homebrew-tap
- PyPI: https://pypi.org/project/flightdeck-cli/ and
  https://pypi.org/project/flightdeck-sensor/
- Docker Hub: https://hub.docker.com/r/flightdeckhq/flightdeck
- The install gate is green on all five legs.

## Dry run: a pre-release tag

The pipeline and the gate can be exercised before a release, on the
version the files already carry, by pushing a pre-release tag by hand
(the release script refuses them on purpose):

```bash
git fetch origin && git checkout main && git pull --ff-only origin main
python3 scripts/version.py check --tag v$(cat VERSION)-rc.1
git tag -a v$(cat VERSION)-rc.1 -m "Dry run of the release pipeline"
git push origin v$(cat VERSION)-rc.1
```

What a pre-release tag does differently: the GitHub release is marked
as a pre-release (the installers' `latest` and the release page's
"Latest" skip it), the Homebrew formula is not pushed (the macos-arm64
leg of the gate installs with `install.sh` and says so), the Docker
image gets `:<tag>` but not `:latest`, `flightdeck-sensor` is not
published (its version would be the final `X.Y.Z`), and `flightdeck-cli`
is published as the PEP 440 pre-release (`0.9.0rc1`), which `pip` and
`uvx` do not pick without an exact pin. The version guard still
requires `X.Y.Z` to match `VERSION`, which the release PR sets, so the
release notes are the `X.Y.Z` section that PR dated (the CHANGELOG's
Unreleased section only for a pre-release of a version not dated yet).
A fix merged after the release PR adds its entry to that dated section,
not to Unreleased, so the final release's notes carry it.

A second dry run after a fix is a new tag, `-rc.2`: PyPI never
replaces a published file (the publish step skips a version that already
exists, so a re-pushed `-rc.1` would silently keep the old wheels), and
the installers cache nothing but would otherwise see two builds under
one name.

Clean up afterwards: delete the pre-release on GitHub if it should not
stay visible (`gh release delete vX.Y.Z-rc.1 --cleanup-tag`). The PyPI
pre-release and the Docker tag stay; neither is what a default install
resolves to.

## If a release fails

Published artifacts are built from the tag; do not move the tag.

1. **verify or goreleaser failed, nothing published:** the PyPI and
   Docker jobs wait for goreleaser, so nothing has left the runner. Fix
   the cause on `main` (through a PR), delete the tag and any partial
   GitHub release (`gh release delete vX.Y.Z --cleanup-tag`, or `git tag
   -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z` when no release was
   created) and run `make release-tag VERSION=vX.Y.Z` again on the fixed
   `main`. Until the tag is back, plugin installs fail (the marketplace
   entry points at it), so keep the gap short. govulncheck names the
   module, the package and the fixed version; the fix is a dependency
   bump.

2. **The GitHub release exists but a later job failed** (a PyPI or
   Docker Hub error, the image scan): if the failure was transient,
   re-run the failed jobs from the Actions page. goreleaser replaces the
   release's assets (`release.mode: replace`), the PyPI steps skip a
   version that already exists, and the Docker push is idempotent. If it
   needs a code change, release a patch version. A failed image scan
   lands here: the fix is a newer base image digest in the `Dockerfile`
   or a Go dependency bump. The install gate starts only when the
   Release workflow succeeds, so after a re-run that turns it green,
   run the gate by hand (`gh workflow run install-gate.yml -f
   tag=vX.Y.Z`) if it did not start on its own.

3. **The install gate is red:** something published does not install or
   run on that platform. Read the leg's log (the gate prints the binary's
   output on failure), fix on `main` and release a patch version. A
   published artifact is never replaced in place.

4. **Release notes wrong:** edit the GitHub release by hand, or fix
   CHANGELOG.md on `main`; the notes are not regenerated.

Do not upload to PyPI or Docker Hub by hand. Always go through the
release pipeline so every channel carries the same build.

## One-time setup (maintainer)

The pipeline needs these, each once:

- **Homebrew tap**: the repository `flightdeckhq/homebrew-tap` exists.
  The secret `HOMEBREW_TAP_GITHUB_TOKEN` must hold a fine-grained
  personal access token (or a GitHub App token) scoped to that one
  repository with *Contents: read and write* and nothing else; the
  workflow's `GITHUB_TOKEN` cannot push to another repository. Give it
  an expiry (a year at most) and note the date; a stable release fails
  at the formula step when it lapses, after the GitHub release exists
  (case 2 above). `brew services start flightdeck` runs the binary with
  its defaults and no environment, which is a complete setup: loopback
  `:4000` and the SQLite database in `~/.flightdeck`, the data dir a
  `flightdeck` run by hand uses, so the two share one database. It
  cannot pass `--database-url` or `FLIGHTDECK_DATABASE_URL`; a Homebrew
  user on Postgres starts the binary from a terminal, and the formula's
  caveats say so.
- **PyPI trusted publishing** for `flightdeck-cli`, as a pending
  publisher at https://pypi.org/manage/account/publishing/ until the
  first publish creates the project: owner `flightdeckhq`, repository
  `flightdeck`, workflow `release.yml`, environment `pypi`. The same
  settings exist for `flightdeck-sensor`.
- **Docker Hub**: the secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`
  (already used by the per-service images) must be allowed to create
  the repository `flightdeckhq/flightdeck` on the first push, or the
  repository is created on Docker Hub first.
- **GitHub environments** `pypi` and `docker-hub` exist; the release
  jobs run under them so the Deployments panel shows where a version
  shipped. Give each a deployment branch rule that allows tags matching
  `v*` only, so a workflow on a branch can never reach the PyPI
  trusted publisher or the Docker Hub credentials.
- **checksums.txt signature**: no setup; the goreleaser job signs with
  its own OIDC identity through `sigstore/cosign-installer`, and the
  installers verify it when `cosign` is present. The identity the
  installers accept ends in `@refs/tags/v…`, so only a tag push (this
  workflow's only trigger) produces a signature they take; a signature
  made from a branch, by hand or by another workflow is refused. The
  dashboard bundle is built in a separate job without those scopes and
  handed over as an artifact, so `npm ci` never runs next to the release
  token or the OIDC token.
