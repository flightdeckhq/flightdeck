# flightdeck-cli

[Flightdeck](https://github.com/flightdeckhq/flightdeck) is fleet
observability and control for AI coding agents: one `flightdeck` binary
runs the ingestion API, the workers, the query API and the dashboard.
This package delivers that binary through PyPI, one wheel per platform
(Linux, macOS and Windows on x86-64 and arm64), with a `flightdeck`
console script that runs it.

```sh
pip install flightdeck-cli
flightdeck
```

or without installing anything permanently:

```sh
uvx flightdeck-cli
pipx run flightdeck-cli
```

Open the URL it prints. Nothing else needs installing or configuring:
the binary keeps its data in a SQLite database under `~/.flightdeck`
(`%LOCALAPPDATA%\flightdeck` on Windows), so a later run, `uvx` included,
finds it again; `flightdeck --database-url postgres://…` uses a Postgres
database instead. The package has no Python dependencies and no
Python code beyond the shim that starts the binary; the version of the
package is the version of the binary (`flightdeck --version`).

The package is named `flightdeck-cli` because `flightdeck` on PyPI
belongs to an unrelated project. The Python *sensor* that reports an
agent's calls to Flightdeck is a separate package,
[`flightdeck-sensor`](https://pypi.org/project/flightdeck-sensor/).

Other ways to install the same binary: the shell installer
(`curl -fsSL https://raw.githubusercontent.com/flightdeckhq/flightdeck/main/install.sh | sh`),
Homebrew (`brew install flightdeckhq/tap/flightdeck`), the Docker image
`flightdeckhq/flightdeck`, and the archives on the
[release page](https://github.com/flightdeckhq/flightdeck/releases).
