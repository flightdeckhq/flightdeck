# Releasing Flightdeck

## Versioning

Flightdeck follows [Semantic Versioning](https://semver.org/):

- **Major** (v1.0.0): Breaking API changes
- **Minor** (v0.2.0): New features, backward-compatible
- **Patch** (v0.1.1): Bug fixes
- **Pre-release** (v0.1.0a1): Alpha/beta releases

## Release Process

### 1. Run the release script

```bash
make release VERSION=v0.1.0
# or
./scripts/release.sh v0.1.0
```

The script:
1. Validates the working tree is clean
2. Confirms you are on the `main` branch
3. Updates `version` in `sensor/pyproject.toml`
4. Runs `make test` to verify all tests pass
5. Commits: `chore: release v0.1.0`
6. Creates an annotated git tag
7. Pushes the commit and tag to origin

### 2. GitHub Actions takes over

Pushing the tag triggers `.github/workflows/release.yml`, which:

- **Job 1 -- Publish sensor to PyPI:** Builds the wheel and sdist,
  publishes via OIDC trusted publishing (no API key stored)
- **Job 2 -- Build and push Docker images:** Builds and pushes four
  images to Docker Hub under the `flightdeckhq` org:
  - `flightdeckhq/flightdeck-ingestion`
  - `flightdeckhq/flightdeck-workers`
  - `flightdeckhq/flightdeck-api`
  - `flightdeckhq/flightdeck-dashboard`
- **Job 3 -- Create GitHub release:** Auto-generates release notes

### 3. Verify

- Check PyPI: https://pypi.org/project/flightdeck-sensor/
- Check Docker Hub: https://hub.docker.com/u/flightdeckhq
- Check GitHub: https://github.com/flightdeckhq/flightdeck/releases

## If a Release Fails

If the release pipeline fails mid-way:

1. **PyPI published but Docker failed:** Fix the Dockerfile issue,
   delete the git tag (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`),
   re-tag and re-push. PyPI will reject the duplicate -- bump to a patch
   version (e.g. v0.1.1).

2. **Nothing published:** Fix the issue, delete the tag, re-tag, re-push.

3. **Everything published but release notes wrong:** Edit the GitHub
   release manually.

Do not manually upload to PyPI or Docker Hub. Always go through the
release pipeline to ensure consistency.
