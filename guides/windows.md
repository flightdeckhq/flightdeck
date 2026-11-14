# Flightdeck on Windows

The `flightdeck` binary runs on Windows 10 and 11 and Windows Server, on x64 and Arm64, with no administrator rights and nothing else to install. This page is the Windows detail behind the [README](../README.md#install): what the installer does, running Flightdeck, its data, upgrading and removing it, and pointing agents at it from PowerShell.

## Install

In PowerShell (Windows PowerShell 5.1, which every Windows has, or PowerShell 7):

```powershell
irm https://flightdeck-hq.com/install.ps1 | iex
```

What that does, in order:

1. Downloads `flightdeck_windows_amd64.zip` (`_arm64` on an Arm64 machine) and `checksums.txt` from the latest GitHub release of `flightdeckhq/flightdeck`, over HTTPS.
2. Checks the archive's SHA-256 against `checksums.txt` and stops if it differs. When `cosign` is on your `PATH` it also checks that `checksums.txt` was signed by this repository's release workflow and stops if not; without `cosign` it says that the signature was not checked.
3. Puts `flightdeck.exe` in `%LOCALAPPDATA%\Programs\flightdeck`.
4. Adds that directory to your user `PATH`. Nothing else in the `PATH` changes: entries written with variables such as `%USERPROFILE%` stay that way. The window that ran the installer can run `flightdeck` at once, and so can every window opened after it; a window that was already open does not see the new `PATH` until you open it again.

Read the script before you pipe it to `iex`: it is [install.ps1](../install.ps1). `$env:VERSION = "v0.9.0"` before the command installs that release instead of the latest, and `$env:INSTALL_DIR` puts `flightdeck.exe` elsewhere. If flightdeck-hq.com is unreachable, the repository serves the same script at `https://raw.githubusercontent.com/flightdeckhq/flightdeck/main/install.ps1`. The `.zip` archives are also on the [release page](https://github.com/flightdeckhq/flightdeck/releases), to unpack by hand.

## Run it

```powershell
flightdeck
```

The dashboard is at http://localhost:4000. Flightdeck runs in that window and prints its start-up block there: the dashboard address, the ingestion address and the token, `tok_dev` while it listens on your own machine. Ctrl+C stops it, and so does closing the window. There is no Windows service; to keep Flightdeck running without a window open, run the Docker image under Docker Desktop instead (below).

If PowerShell says `flightdeck` is not recognised, open a new PowerShell window, or run it by its full path: `& "$env:LOCALAPPDATA\Programs\flightdeck\flightdeck.exe"`.

`flightdeck --help` lists the flags. Two that matter on Windows:

- `--data-dir` moves the data (below).
- `--listen 0.0.0.0:4000` makes Flightdeck reachable from other machines. It then refuses the development token and creates an access token on its first start, printed once in the start-up block. Windows Defender Firewall asks whether to allow `flightdeck.exe` the first time it listens on an address other than `127.0.0.1`; on the default address it does not ask. Whoever can reach the address can read the dashboard's token, so open it only on a network you trust, or put Flightdeck behind a proxy that authenticates.

## The data

Everything Flightdeck keeps is in `%LOCALAPPDATA%\flightdeck`: the SQLite database `flightdeck.db`, the message-bus store `nats\` and `secrets.json`. The directory must be on a local disk: a network drive or a UNC path does not provide the file locks SQLite and Flightdeck rely on. One `flightdeck` runs per data directory; a second one on the same directory exits at once and names the process that holds it.

[guides/self-hosting.md](self-hosting.md#backing-up) has how to back up the database while Flightdeck runs.

## Docker Desktop

The image runs under Docker Desktop for Windows with the same command as anywhere else, and `--restart unless-stopped` starts it again with Docker:

```powershell
docker run -d --name flightdeck --restart unless-stopped -p 127.0.0.1:4000:4000 -v flightdeck:/data flightdeckhq/flightdeck
```

The data is then in the `flightdeck` volume, and the container creates an access token on its first start: `docker logs flightdeck` shows it. [guides/self-hosting.md](self-hosting.md) has Docker Compose.

## Upgrade

Stop Flightdeck (Ctrl+C), then run the install command again. It replaces `flightdeck.exe` and adds nothing more to the `PATH`. While `flightdeck.exe` is running, Windows does not let it be replaced, and the installer stops with "The process cannot access the file … because it is being used by another process." The next start brings the database up to date; the data is kept.

## Uninstall

Stop Flightdeck, then:

```powershell
Remove-Item -Recurse "$env:LOCALAPPDATA\Programs\flightdeck"
```

and remove that directory from your user `PATH`: search the Start menu for **Edit environment variables for your account**, select **Path**, choose **Edit**, and delete the entry that ends in `\Programs\flightdeck`. To delete the data as well (every session, event and token):

```powershell
Remove-Item -Recurse "$env:LOCALAPPDATA\flightdeck"
```

## Connect agents from Windows

On the machine that runs Flightdeck, the Claude Code plugin and the Python sensor find it at `http://localhost:4000` with the development token: install them as the [README](../README.md#connect-your-agents) shows and set nothing.

- **Claude Code:** the plugin's hooks run `node`, so Node.js 22 or later must be on your `PATH`.
- **Python agents:** the sensor supports Python 3.11 to 3.14. With the Python launcher: `py -m pip install flightdeck-sensor`.

For a Flightdeck on another machine, give the agent its address and a token minted under **Settings → Access tokens**. The two take the address in different forms: the sensor's ends in `/ingest`, the plugin's does not. In PowerShell, for the current window, a Python agent:

```powershell
$env:FLIGHTDECK_SERVER = "https://flightdeck.example.com/ingest"
$env:FLIGHTDECK_TOKEN = "ftd_..."
python agent.py
```

and Claude Code:

```powershell
$env:FLIGHTDECK_SERVER = "https://flightdeck.example.com"
$env:FLIGHTDECK_TOKEN = "ftd_..."
claude
```

`setx FLIGHTDECK_SERVER "https://flightdeck.example.com"` and `setx FLIGHTDECK_TOKEN "ftd_..."` keep the values for windows opened from then on (not the current one), stored in your user environment where any program you run can read them. For Claude Code, the plugin's own options keep the token in Claude Code's credential store instead: `/plugin`, **flightdeck** on the **Installed** tab, **Configure options**.
