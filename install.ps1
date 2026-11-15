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
#                           key, so that its runs never touch a real PATH. It
#                           must name a key under Software\flightdeck-test\;
#                           any other value stops the script before it
#                           downloads or changes anything.
#   FLIGHTDECK_CONNECT      which coding agents to connect to Flightdeck once the
#                           binary is installed, without asking: agent ids
#                           separated by commas (claude-code), all (every agent
#                           found that is not connected yet) or none. Unset, the
#                           script asks for each agent it finds when the session
#                           is interactive, and prints the command to run
#                           otherwise. Connecting runs `flightdeck connect`; a
#                           connect that fails never fails the install. An agent
#                           too old to connect is never connected: the script
#                           says to update it first.
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

    # Offers to connect the coding agents the installed binary finds, or
    # connects the ones FLIGHTDECK_CONNECT names ($Choice). The binary
    # knows the agents and how to connect them (`flightdeck connect`);
    # `flightdeck connect --detected` prints one line per agent found on
    # this machine: its id, connected, not-connected or outdated (found,
    # too old to connect), and its name, separated by tabs. This script is
    # fetched fresh for every install, so it is never older than the
    # binary it installs; a binary older than it (pinned with VERSION)
    # prints only connected and not-connected, which it reads as before.
    # $Ask asks one question and returns $true for yes;
    # it is $null when no person can answer. Returns what was found and
    # the lines to print after the install's next step. A connect that
    # fails is reported and never throws: the binary is installed either
    # way.
    function Invoke-FlightdeckConnect {
        param([string]$Exe, [string]$Choice, [scriptblock]$Ask)
        $result = [pscustomobject]@{ Known = $false; Found = $false; Hints = @() }
        # A native command's stderr is a terminating error under
        # ErrorActionPreference=Stop in Windows PowerShell 5.1, so the
        # preference is relaxed around each call and its exit code decides.
        $savedPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $detected = @(& $Exe connect --detected 2>$null)
            $result.Known = ($LASTEXITCODE -eq 0)
        } catch {
            $detected = @()
        } finally {
            $ErrorActionPreference = $savedPreference
        }
        # An older release, pinned with VERSION, does not know the command.
        if (-not $result.Known) { return $result }
        # Only a word of lower-case letters, digits and - is an agent id,
        # and only an id is passed on to the binary.
        $agentIdPattern = '^[a-z0-9-]+$'
        $agents = @($detected | Where-Object { $_ } | ForEach-Object {
            $fields = "$_" -split "`t"
            [pscustomobject]@{ Id = $fields[0]; State = $(if ($fields.Count -gt 1) { $fields[1] } else { '' }); Name = $(if ($fields.Count -gt 2) { $fields[2] } else { $fields[0] }) }
        } | Where-Object { $_.Id -cmatch $agentIdPattern })
        # `flightdeck connect <id>` exits with this status when the agent
        # is too old for it (one already connected from inside it exits 0
        # instead: this script names no server): running it again fails
        # the same way until the agent is updated, so the script says to
        # update it, not to try again later.
        $outdated = 5
        $outdatedHint = { param([string]$Id, [string]$Name) "To connect ${Name}: update it (this version is too old for flightdeck connect), then run flightdeck connect $Id" }
        $connectOne = {
            param([string]$Id, [string]$Name)
            Write-Host ''
            $savedPreference = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            $connectStatus = 1
            try {
                & $Exe connect $Id --yes 2>&1 | ForEach-Object { Write-Host "$_" }
                $connectStatus = $LASTEXITCODE
            } catch {
                Write-Host $_.Exception.Message
            } finally {
                $ErrorActionPreference = $savedPreference
            }
            if ($connectStatus -eq $outdated) {
                Write-Host "Connecting $Name needs a newer $Name (see above): update it, then run flightdeck connect $Id"
            } elseif ($connectStatus -ne 0) {
                Write-Host "Connecting $Name did not finish (see above); run it again later: flightdeck connect $Id"
            }
        }
        # The value's words, separated by commas or spaces.
        $words = @("$Choice" -split '[,\s]+' | Where-Object { $_ })
        $hints = @()
        if ($words.Count -gt 0 -and -not ($words.Count -eq 1 -and ($words[0] -eq 'all' -or $words[0] -eq 'none'))) {
            foreach ($id in $words) {
                $result.Found = $true
                if ($id -cnotmatch $agentIdPattern) {
                    Write-Host ''
                    Write-Host 'FLIGHTDECK_CONNECT names something that is not an agent id (lower-case letters, digits and -); skipped it'
                    continue
                }
                $match = @($agents | Where-Object { $_.Id -eq $id })
                $name = if ($match.Count -gt 0) { $match[0].Name } else { $id }
                # Named or not, an agent too old to connect is not connected.
                if ($match.Count -gt 0 -and $match[0].State -eq 'outdated') {
                    $hints += & $outdatedHint $id $name
                    continue
                }
                & $connectOne $id $name
            }
            $result.Hints = $hints
            return $result
        }
        foreach ($agent in $agents) {
            $result.Found = $true
            if ($agent.State -eq 'connected') {
                Write-Host ''
                Write-Host "$($agent.Name) is already connected to Flightdeck."
                continue
            }
            # Too old to connect: nothing to plan or ask, whatever the choice.
            if ($agent.State -eq 'outdated') {
                $hints += & $outdatedHint $agent.Id $agent.Name
                continue
            }
            $mode = if ($words.Count -eq 1) { $words[0] } else { '' }
            if ($mode -eq 'all') {
                & $connectOne $agent.Id $agent.Name
                continue
            }
            if ($mode -ne 'none' -and $Ask) {
                Write-Host ''
                # What connecting changes and what the agent's integration
                # then records, in the binary's words, before the question;
                # when the binary cannot say (it printed why), nothing is asked.
                $savedPreference = $ErrorActionPreference
                $ErrorActionPreference = 'Continue'
                # `connect --dry-run` exits 4 when the plan needs a person's
                # yes on a terminal (a caution, such as a plugin from a
                # marketplace other than this repository's): the installer
                # does not ask then, since its connect passes --yes, which
                # refuses such a plan.
                $needsConfirmation = 4
                $planStatus = 1
                try {
                    & $Exe connect $agent.Id --dry-run 2>&1 | ForEach-Object { Write-Host "$_" }
                    $planStatus = $LASTEXITCODE
                } catch {
                    Write-Host $_.Exception.Message
                } finally {
                    $ErrorActionPreference = $savedPreference
                }
                if ($planStatus -eq $needsConfirmation) {
                    Write-Host "Connecting $($agent.Name) needs your own yes (see the caution above): run flightdeck connect $($agent.Id) yourself, which shows it and asks."
                    continue
                }
                # Too old after all (planning met a command it lacks).
                if ($planStatus -eq $outdated) {
                    $hints += & $outdatedHint $agent.Id $agent.Name
                    continue
                }
                if ($planStatus -eq 0 -and (& $Ask "Connect $($agent.Name) to Flightdeck?")) {
                    & $connectOne $agent.Id $agent.Name
                    continue
                }
            }
            $hints += "To connect $($agent.Name): flightdeck connect $($agent.Id)"
        }
        $result.Hints = $hints
        return $result
    }

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

    # The user PATH is the Path value of HKCU\Environment. The installer's
    # test points it at a throwaway key instead, and only a key under
    # HKCU\Software\flightdeck-test\ is honoured: a stray setting must not
    # send the PATH write anywhere else (a Run key, say) while the
    # installer reports the PATH changed. Forward slashes count as
    # backslashes, case is ignored, and a . or .. segment is refused.
    $envKeyName = 'Environment'
    if ($env:FLIGHTDECK_INSTALL_REGISTRY_KEY) {
        $testKeyPrefix = 'Software\flightdeck-test\'
        $requestedKey = (($env:FLIGHTDECK_INSTALL_REGISTRY_KEY.Trim() -replace '/', '\') -replace '\\+', '\').Trim('\')
        $dotSegments = @($requestedKey.Split('\') | Where-Object { $_.Trim() -eq '.' -or $_.Trim() -eq '..' })
        if (-not $requestedKey.StartsWith($testKeyPrefix, [StringComparison]::OrdinalIgnoreCase) -or $requestedKey.Length -le $testKeyPrefix.Length -or $dotSegments.Count -gt 0) {
            throw "install.ps1: FLIGHTDECK_INSTALL_REGISTRY_KEY is for this repository's installer test and must name a key under HKCU\$testKeyPrefix, got '$($env:FLIGHTDECK_INSTALL_REGISTRY_KEY)'. Nothing was downloaded or changed; unset it to install normally."
        }
        $envKeyName = $requestedKey
        Write-Host "Test registry key in use: the user PATH is read from and written to HKCU\$envKeyName (FLIGHTDECK_INSTALL_REGISTRY_KEY), not HKCU\Environment"
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
    # A person can answer when the session is interactive and its input
    # is the console: not a CI job, not -NonInteractive, not a pipe.
    $nonInteractiveArg = @([Environment]::GetCommandLineArgs() | Where-Object { $_ -match '^-noni' })
    $ask = $null
    if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and $nonInteractiveArg.Count -eq 0) {
        $ask = {
            param([string]$Question)
            try {
                $answer = Read-Host "$Question [Y/n]"
            } catch {
                # A host that cannot read (a non-interactive host) is a no.
                return $false
            }
            return ($answer -match '^\s*(y|yes)?\s*$')
        }
    }
    $connect = Invoke-FlightdeckConnect -Exe $exe -Choice $env:FLIGHTDECK_CONNECT -Ask $ask
    # $LASTEXITCODE is the session's, and now holds the last native exit
    # status of the connect step: an older binary's refusal of --detected,
    # or a connect that failed. Neither is the install's status, which
    # succeeded, so the session that ran the installer sees 0, as it did
    # before the step (a CI shell exits with $LASTEXITCODE).
    $global:LASTEXITCODE = 0

    Write-Host ''
    Write-Host 'Next: run `flightdeck` and open the URL it prints.'
    foreach ($hint in $connect.Hints) { Write-Host $hint }
    if ($connect.Known -and -not $connect.Found) {
        Write-Host 'To connect a coding agent later: flightdeck connect (it lists the agents it can connect)'
    }
}
