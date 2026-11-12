# Installs the flightdeck binary on Windows from a GitHub release.
#
#   irm https://flightdeck-hq.com/install.ps1 | iex
#
# The project's site serves a copy of this file (docs/install.ps1, which
# CI keeps identical to install.ps1 on the repository's main branch). If
# the site is unreachable, the repository serves the same script:
# https://raw.githubusercontent.com/flightdeckhq/flightdeck/main/install.ps1
#
# Downloads the release .zip for this CPU and the release's checksums.txt,
# verifies the archive against it, extracts flightdeck.exe into
# %LOCALAPPDATA%\Programs\flightdeck and adds that directory to the
# user's PATH. No administrator rights are needed.
#
# What is and is not verified: the archive's SHA-256 is checked against
# checksums.txt. checksums.txt itself is signed by the release workflow
# with Sigstore (keyless, cosign; the bundle is checksums.txt.sigstore.json
# next to it). When `cosign` is on PATH this script verifies that
# signature and refuses a release whose checksums were not produced by
# this repository's release workflow; without cosign the signature is
# NOT checked and the download is trusted as far as TLS to github.com
# is. Install cosign (https://docs.sigstore.dev/cosign/system_config/installation/)
# to close that gap. Read this script before piping it to iex.
#
# Overrides, as environment variables (a piped script takes no parameters):
#   VERSION                 a release tag (v1.2.3); default: the latest release
#   INSTALL_DIR             where flightdeck.exe goes
#   FLIGHTDECK_RELEASE_URL  the repository URL the release assets hang off
#                           (default https://github.com/flightdeckhq/flightdeck);
#                           HTTPS only except localhost; the signature is checked
#                           only for the default URL
#
# winget and scoop manifests are not published yet; this script and the
# .zip on the release page are the Windows channels.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# TLS 1.2 at least (Windows PowerShell 5.1 may still default to older
# protocols); TLS 1.3 where the .NET runtime knows it.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
} catch {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$defaultRepoUrl = 'https://github.com/flightdeckhq/flightdeck'
$repoUrl = if ($env:FLIGHTDECK_RELEASE_URL) { $env:FLIGHTDECK_RELEASE_URL } else { $defaultRepoUrl }
$binary = 'flightdeck'
# The signer of checksums.txt: this repository's release workflow, through GitHub's OIDC issuer.
$signerIdentityRe = '^https://github\.com/flightdeckhq/flightdeck/\.github/workflows/.+@refs/tags/v.+$'
$signerIssuer = 'https://token.actions.githubusercontent.com'

if ($repoUrl -notmatch '^https://' -and $repoUrl -notmatch '^http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(/|$)') {
    throw "install.ps1: FLIGHTDECK_RELEASE_URL must be https:// (or http://localhost for a local test server): $repoUrl"
}

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'amd64' }
    'ARM64' { 'arm64' }
    default { throw "install.ps1: unsupported CPU architecture $($env:PROCESSOR_ARCHITECTURE) (releases cover amd64 and arm64)" }
}
# An x64 PowerShell on an ARM64 machine reports AMD64; the native build is the right one.
if ($arch -eq 'amd64' -and $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $arch = 'arm64' }

$asset = "${binary}_windows_${arch}.zip"
if ($env:VERSION) {
    $version = if ($env:VERSION.StartsWith('v')) { $env:VERSION } else { "v$($env:VERSION)" }
    $base = "$repoUrl/releases/download/$version"
    Write-Host "Installing flightdeck $version for windows/$arch"
} else {
    $base = "$repoUrl/releases/latest/download"
    Write-Host "Installing the latest flightdeck release for windows/$arch"
}

$installDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\flightdeck' }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("flightdeck-install-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    Write-Host "Downloading $base/$asset"
    Invoke-WebRequest -Uri "$base/$asset" -OutFile (Join-Path $tmp $asset) -UseBasicParsing
    Invoke-WebRequest -Uri "$base/checksums.txt" -OutFile (Join-Path $tmp 'checksums.txt') -UseBasicParsing

    if ($repoUrl -ne $defaultRepoUrl) {
        Write-Host 'Signature of checksums.txt not checked: FLIGHTDECK_RELEASE_URL is not the flightdeckhq/flightdeck release'
    } elseif (-not (Get-Command cosign -ErrorAction SilentlyContinue)) {
        Write-Host 'Signature of checksums.txt not checked: cosign is not installed (see the header of install.ps1)'
    } else {
        Invoke-WebRequest -Uri "$base/checksums.txt.sigstore.json" -OutFile (Join-Path $tmp 'checksums.txt.sigstore.json') -UseBasicParsing
        # cosign reports "Verified OK" on stderr; under
        # ErrorActionPreference=Stop, Windows PowerShell 5.1 turns any
        # stderr line of a native command into a terminating error, so the
        # preference is relaxed around the call and its exit code decides.
        $savedPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $cosignOutput = & cosign verify-blob --bundle (Join-Path $tmp 'checksums.txt.sigstore.json') `
                --certificate-identity-regexp $signerIdentityRe --certificate-oidc-issuer $signerIssuer `
                (Join-Path $tmp 'checksums.txt') 2>&1
            $cosignExit = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $savedPreference
        }
        if ($cosignExit -ne 0) {
            Write-Host ($cosignOutput | Out-String)
            throw 'install.ps1: checksums.txt is not signed by the flightdeckhq/flightdeck release workflow; refusing to install'
        }
        Write-Host 'Signature of checksums.txt verified (Sigstore)'
    }

    $line = Get-Content (Join-Path $tmp 'checksums.txt') | Where-Object { $_ -match "\s$([regex]::Escape($asset))$" } | Select-Object -First 1
    if (-not $line) { throw "install.ps1: checksums.txt has no entry for $asset" }
    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "install.ps1: checksum mismatch for ${asset}: expected $expected, got $actual" }
    Write-Host 'Checksum verified'

    Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath (Join-Path $tmp 'unpacked') -Force
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    Copy-Item -Path (Join-Path $tmp 'unpacked' "$binary.exe") -Destination (Join-Path $installDir "$binary.exe") -Force
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$exe = Join-Path $installDir "$binary.exe"
$printed = & $exe --version
Write-Host "Installed $printed to $exe"

# Under GitHub Actions, later steps find the binary without a PATH edit.
if ($env:GITHUB_PATH) { Add-Content -Path $env:GITHUB_PATH -Value $installDir }

# The user PATH is read and written as a plain string: SetEnvironmentVariable
# stores REG_SZ, so a REG_EXPAND_SZ value with %VARIABLES% would come back
# expanded. Nothing is removed, only this directory appended.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$onPath = ($userPath -split ';') -contains $installDir -or ($env:Path -split ';') -contains $installDir
if (-not $onPath) {
    $newPath = if ($userPath) { "$userPath;$installDir" } else { $installDir }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    $env:Path = "$env:Path;$installDir"
    Write-Host "Added $installDir to your PATH (open a new terminal to pick it up)."
}
Write-Host ''
Write-Host 'Next: run `flightdeck` and open the URL it prints.'
