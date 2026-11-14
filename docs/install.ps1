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
# user's PATH (a new PowerShell window sees it). No administrator rights
# are needed. Running it again installs the release over the old binary;
# stop a running flightdeck first, since Windows will not replace an
# .exe that is running.
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
#   VERSION                 a release tag (v1.2.3, v1.2.3-rc.1; the v is optional);
#                           default: the latest release
#   INSTALL_DIR             where flightdeck.exe goes
#   FLIGHTDECK_RELEASE_URL  the repository URL the release assets hang off
#                           (default https://github.com/flightdeckhq/flightdeck);
#                           HTTPS only except localhost; the signature is checked
#                           only for the default URL
#   FLIGHTDECK_INSTALL_REGISTRY_KEY
#                           the key under HKEY_CURRENT_USER whose Path value is
#                           the user PATH (default Environment). Only
#                           scripts/test-install-ps1.ps1 sets it, to a throwaway
#                           key, so that its runs never touch a real PATH.
#
# winget and scoop manifests are not published yet; this script and the
# .zip on the release page are the Windows channels.

# Everything runs in a script block of its own. Piped to iex, a script
# runs in the caller's session: without the block, its variables and
# its preferences ($ErrorActionPreference = 'Stop', a silenced progress
# bar) would stay set in the user's PowerShell after it finishes. The
# PATH change below is made to the process environment on purpose, so
# `flightdeck` runs at once in the window that ran this.
& {
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
    if ($env:VERSION -and $env:VERSION -notmatch '^v?\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') {
        throw "install.ps1: VERSION must be a release tag such as v0.9.0 or v0.9.0-rc.1, got '$($env:VERSION)'"
    }
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
        # Join-Path takes one child path in Windows PowerShell 5.1 (a third
        # argument is an error there), so nested paths are joined twice.
        Copy-Item -Path (Join-Path (Join-Path $tmp 'unpacked') "$binary.exe") -Destination (Join-Path $installDir "$binary.exe") -Force
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }

    $exe = Join-Path $installDir "$binary.exe"
    $printed = & $exe --version
    Write-Host "Installed $printed to $exe"

    # Under GitHub Actions, later steps find the binary without a PATH edit.
    if ($env:GITHUB_PATH) { Add-Content -Path $env:GITHUB_PATH -Value $installDir }

    # The user PATH is the Path value of HKCU\Environment, normally a
    # REG_EXPAND_SZ whose entries use %VARIABLES% (%USERPROFILE%\...). It is
    # read without expanding them and written back with the type it had, so
    # the only change is the one entry appended. ([Environment]::
    # SetEnvironmentVariable would store it as REG_SZ with every variable
    # expanded.) A directory already on the PATH, spelled with a variable,
    # in quotes or with a trailing backslash, is not added again.
    #
    # Windows allows an environment variable 32,767 characters: a PATH the
    # entry would take past that is left as it is and the installer stops,
    # saying where flightdeck.exe is. Past 2,047 characters it is written
    # with a warning, since some older programs read no further.
    $pathMaxLength = 32767
    $pathWarnLength = 2047
    $envKeyName = if ($env:FLIGHTDECK_INSTALL_REGISTRY_KEY) { $env:FLIGHTDECK_INSTALL_REGISTRY_KEY } else { 'Environment' }
    $envKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($envKeyName)
    try {
        $userPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $pathKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        if (($envKey.GetValueNames() -contains 'Path') -and $envKey.GetValueKind('Path') -eq [Microsoft.Win32.RegistryValueKind]::String) {
            $pathKind = [Microsoft.Win32.RegistryValueKind]::String
        }
        $wanted = $installDir.Trim().Trim('"').TrimEnd('\')
        $entries = @($userPath -split ';') + @($env:Path -split ';') |
            ForEach-Object { $_.Trim().Trim('"') } |
            Where-Object { $_ } |
            ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') }
        if ($entries -notcontains $wanted) {
            $newPath = if (-not $userPath) { $installDir } elseif ($userPath.EndsWith(';')) { "$userPath$installDir" } else { "$userPath;$installDir" }
            $newLength = [Environment]::ExpandEnvironmentVariables($newPath).Length
            if ($newLength -gt $pathMaxLength) {
                throw "install.ps1: adding $installDir would make your user PATH $newLength characters long, more than the $pathMaxLength Windows allows, so your PATH is unchanged. flightdeck is installed: run it as & '$exe', or shorten your PATH and run this installer again."
            }
            $envKey.SetValue('Path', $newPath, $pathKind)
            $env:Path = "$env:Path;$installDir"
            # Tell running programs the environment changed (what
            # SetEnvironmentVariable does after writing), so a terminal
            # started from the Start menu or Explorer from now on has the
            # new PATH: HWND_BROADCAST, WM_SETTINGCHANGE, "Environment",
            # SMTO_ABORTIFHUNG, at most five seconds. The PATH is already
            # written, so a failure here (Add-Type is refused in
            # Constrained Language Mode) is only a warning.
            try {
                if (-not ('FlightdeckInstaller.NativeMethods' -as [type])) {
                    Add-Type -Namespace FlightdeckInstaller -Name NativeMethods -MemberDefinition @'
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
'@
                }
                $broadcastResult = [UIntPtr]::Zero
                [void][FlightdeckInstaller.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$broadcastResult)
            } catch {
                Write-Warning "Could not tell running programs that the PATH changed ($($_.Exception.Message)). Windows started from the Start menu may not see it until you sign out and back in."
            }
            Write-Host "Added $installDir to your user PATH: flightdeck runs in this window now and in windows opened from now on; reopen any other window that is already open."
            if ($newLength -gt $pathWarnLength) {
                Write-Warning "Your user PATH is now $newLength characters long. Some older programs read only its first $pathWarnLength characters; if one of them cannot find a program, shorten your PATH."
            }
        }
    } finally {
        $envKey.Close()
    }
    Write-Host ''
    Write-Host 'Next: run `flightdeck` and open the URL it prints.'
}
