# Installs the flightdeck binary on Windows from a GitHub release.
#
#   irm https://raw.githubusercontent.com/flightdeckhq/flightdeck/main/install.ps1 | iex
#
# Downloads the release .zip for this CPU and the release's checksums.txt,
# verifies the archive, extracts flightdeck.exe into
# %LOCALAPPDATA%\Programs\flightdeck and adds that directory to the
# user's PATH. No administrator rights are needed.
#
# Overrides, as environment variables (a piped script takes no parameters):
#   VERSION                 a release tag (v1.2.3); default: the latest release
#   INSTALL_DIR             where flightdeck.exe goes
#   FLIGHTDECK_RELEASE_URL  the repository URL the release assets hang off
#                           (default https://github.com/flightdeckhq/flightdeck)
#
# winget and scoop manifests are not published yet; this script and the
# .zip on the release page are the Windows channels.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoUrl = if ($env:FLIGHTDECK_RELEASE_URL) { $env:FLIGHTDECK_RELEASE_URL } else { 'https://github.com/flightdeckhq/flightdeck' }
$binary = 'flightdeck'

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
