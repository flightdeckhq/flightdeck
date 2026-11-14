# Tests install.ps1 end to end against a local HTTP server that mirrors
# the GitHub release layout (releases/latest/download/<asset> and
# releases/download/<tag>/<asset>, checksums.txt beside them), the way
# scripts/test-install-sh.sh tests install.sh. The archive holds a
# stand-in flightdeck.exe, a copy of Windows' own curl.exe, which
# answers --version, so no release and no Go build is needed.
#
# CI runs it on Windows under Windows PowerShell 5.1 and PowerShell 7
# (the "Installer on Windows" job), because the installer is piped to
# whichever of the two the user has:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-install-ps1.ps1
#   pwsh -NoProfile -File scripts\test-install-ps1.ps1
#
# What it checks: an install piped through iex, as the README shows it,
# downloads, verifies the checksum, installs, appends the directory to
# the user PATH without expanding its %VARIABLES% or changing its
# registry type, puts it on this session's PATH, and leaves no variable
# or preference of its own in the session; a second run adds nothing to
# the PATH; a pinned VERSION; and the refusals (a bad checksum, a
# missing checksum entry, an unknown version, a plain-HTTP host).
#
# It changes the user PATH, as the installer does, and puts it back:
# the Path value of HKCU\Environment is saved, raw and with its
# registry type, before the first case, and written back at the end of
# the run, after which running programs are told the environment
# changed. Its own entries are only ever appended, so a run that is
# killed before the end leaves the PATH it found with a few entries of
# temporary directories after it, never without its own.
#
# The server is `python -m http.server`, so python must be on PATH,
# unless -ReleaseUrl names a server that already serves -ServeDir (a
# run from WSL serves a Windows directory from the Linux side).
param(
    [string]$ReleaseUrl = '',
    [string]$ServeDir = '',
    [int]$Port = 8766
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path ([IO.Path]::GetTempPath()) ('fd-install-ps1-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$serve = if ($ServeDir) { $ServeDir } else { Join-Path $work 'serve' }
$tag = 'v0.0.1-test'
$script:failures = 0

function Write-Pass([string]$what) { Write-Host "  ok: $what" }
function Write-Failure([string]$what, [string]$detail = '') {
    Write-Host "FAIL: $what"
    if ($detail) { Write-Host ($detail -replace '(?m)^', '    ') }
    $script:failures++
}

# The user PATH as the registry holds it, and how to put it back.
$envKeyPath = 'Environment'
function Get-UserPath {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($envKeyPath)
    try {
        if (-not $key -or ($key.GetValueNames() -notcontains 'Path')) { return $null }
        return [pscustomobject]@{
            Raw  = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            Kind = $key.GetValueKind('Path')
        }
    } finally {
        if ($key) { $key.Close() }
    }
}
function Set-UserPath($value) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($envKeyPath)
    try {
        if ($null -eq $value) { $key.DeleteValue('Path', $false) } else { $key.SetValue('Path', $value.Raw, $value.Kind) }
    } finally {
        $key.Close()
    }
}
$savedPath = Get-UserPath
$savedSessionPath = $env:Path
$server = $null

try {
    # ---- the release layout ---------------------------------------------
    $stage = Join-Path $work 'stage'
    New-Item -ItemType Directory -Path $stage | Out-Null
    Copy-Item -Path (Join-Path $env:SystemRoot 'System32\curl.exe') -Destination (Join-Path $stage 'flightdeck.exe')
    $latest = Join-Path $serve 'releases\latest\download'
    New-Item -ItemType Directory -Path $latest -Force | Out-Null
    $sums = @()
    foreach ($arch in 'amd64', 'arm64') {
        $zip = Join-Path $latest "flightdeck_windows_$arch.zip"
        Compress-Archive -Path (Join-Path $stage 'flightdeck.exe') -DestinationPath $zip -Force
        $sums += '{0}  flightdeck_windows_{1}.zip' -f (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant(), $arch
    }
    Set-Content -Path (Join-Path $latest 'checksums.txt') -Value $sums -Encoding Ascii
    foreach ($name in $tag, 'v0.0.1-bad', 'v0.0.1-noentry') {
        $dir = Join-Path $serve "releases\download\$name"
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Copy-Item -Path (Join-Path $latest '*') -Destination $dir
    }
    # A tampered release: the archives no longer match their checksums.
    foreach ($arch in 'amd64', 'arm64') {
        Add-Content -Path (Join-Path $serve "releases\download\v0.0.1-bad\flightdeck_windows_$arch.zip") -Value 'x' -NoNewline
    }
    # A release whose checksums.txt forgot the Windows archives.
    Set-Content -Path (Join-Path $serve 'releases\download\v0.0.1-noentry\checksums.txt') -Value '0000  flightdeck_linux_amd64.tar.gz' -Encoding Ascii
    # The script itself, served for the piped case as the project's site serves it.
    Copy-Item -Path (Join-Path $root 'install.ps1') -Destination (Join-Path $serve 'install.ps1')

    if (-not $ReleaseUrl) {
        $ReleaseUrl = "http://localhost:$Port"
        $server = Start-Process -FilePath python -ArgumentList '-m', 'http.server', "$Port", '--bind', '127.0.0.1', '--directory', $serve `
            -PassThru -WindowStyle Hidden -RedirectStandardError (Join-Path $work 'server.log')
    }
    $up = $false
    for ($i = 0; $i -lt 40 -and -not $up; $i++) {
        try { Invoke-WebRequest -UseBasicParsing "$ReleaseUrl/install.ps1" | Out-Null; $up = $true } catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $up) { throw "the release server at $ReleaseUrl did not answer" }
    Write-Host "== install.ps1 against $ReleaseUrl"

    # ---- piped through iex, as the README shows it ----------------------
    # A user PATH with an entry that uses a variable, stored as
    # REG_EXPAND_SZ, as Windows creates it: the one found, with such an
    # entry appended.
    $fixturePath = if ($savedPath -and $savedPath.Raw) { $savedPath.Raw.TrimEnd(';') + ';%USERPROFILE%\fd-install-test-entry' } else { '%USERPROFILE%\fd-install-test-entry' }
    Set-UserPath ([pscustomobject]@{ Raw = $fixturePath; Kind = [Microsoft.Win32.RegistryValueKind]::ExpandString })
    $dir1 = Join-Path $work 'inst1'
    $env:INSTALL_DIR = $dir1
    $env:FLIGHTDECK_RELEASE_URL = $ReleaseUrl
    Remove-Item Env:VERSION -ErrorAction SilentlyContinue
    # The caller's own preferences, which the installer must leave alone.
    $ErrorActionPreference = 'Continue'
    $ProgressPreference = 'Continue'
    Write-Host '-- latest, piped (irm | iex), INSTALL_DIR'
    $out = ''
    try {
        $out = Invoke-RestMethod "$ReleaseUrl/install.ps1" | Invoke-Expression *>&1 | Out-String
    } catch {
        Write-Failure 'the piped install succeeds' $_.Exception.Message
    }
    $callerErrorAction = $ErrorActionPreference
    $callerProgress = $ProgressPreference
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    if ($out -match 'Checksum verified') { Write-Pass 'the checksum is verified' } else { Write-Failure 'the checksum is verified' $out }
    if ($out -match 'Signature of checksums.txt not checked: FLIGHTDECK_RELEASE_URL') { Write-Pass 'the installer says the signature was not checked for another URL' } else { Write-Failure 'the signature notice' $out }
    if (Test-Path (Join-Path $dir1 'flightdeck.exe')) { Write-Pass 'flightdeck.exe is installed' } else { Write-Failure 'flightdeck.exe is installed' $out }
    if (($env:Path -split ';') -contains $dir1) { Write-Pass 'the directory is on this session''s PATH' } else { Write-Failure 'the directory is on this session''s PATH' $env:Path }
    $userPath = Get-UserPath
    if ($userPath.Raw -ceq "$fixturePath;$dir1") { Write-Pass 'the user PATH gains the directory and keeps %USERPROFILE% unexpanded' } else { Write-Failure 'the user PATH' $userPath.Raw }
    if ($userPath.Kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) { Write-Pass 'the user PATH stays REG_EXPAND_SZ' } else { Write-Failure 'the user PATH stays REG_EXPAND_SZ' "$($userPath.Kind)" }
    if ($callerErrorAction -eq 'Continue' -and $callerProgress -eq 'Continue') { Write-Pass 'the caller''s preferences are untouched' } else { Write-Failure 'the caller''s preferences are untouched' "ErrorActionPreference=$callerErrorAction ProgressPreference=$callerProgress" }
    $leaked = @('asset', 'installDir', 'tmp', 'repoUrl', 'envKey') | Where-Object { Get-Variable -Name $_ -Scope Script -ErrorAction SilentlyContinue }
    if (-not $leaked) { Write-Pass 'no variable of the installer is left in the session' } else { Write-Failure 'no variable of the installer is left in the session' ($leaked -join ', ') }

    # ---- the cases that need no session check ---------------------------
    function Invoke-Install([string]$Version, [string]$Dir, [string]$Url = $ReleaseUrl) {
        $env:INSTALL_DIR = $Dir
        $env:FLIGHTDECK_RELEASE_URL = $Url
        if ($Version) { $env:VERSION = $Version } else { Remove-Item Env:VERSION -ErrorAction SilentlyContinue }
        try {
            $text = Invoke-RestMethod "$ReleaseUrl/install.ps1" | Invoke-Expression *>&1 | Out-String
            return [pscustomobject]@{ Ok = $true; Text = $text }
        } catch {
            return [pscustomobject]@{ Ok = $false; Text = $_.Exception.Message }
        }
    }

    Write-Host '-- the same install again'
    $again = Invoke-Install -Dir $dir1
    if ($again.Ok -and (Get-UserPath).Raw -ceq "$fixturePath;$dir1") { Write-Pass 'a second run adds nothing to the user PATH' } else { Write-Failure 'a second run adds nothing to the user PATH' "$($again.Text)`n$((Get-UserPath).Raw)" }
    if ($again.Text -notmatch 'Added ') { Write-Pass 'and does not say it added it' } else { Write-Failure 'and does not say it added it' $again.Text }

    Write-Host '-- a pinned VERSION'
    $pinned = Invoke-Install -Version $tag -Dir (Join-Path $work 'inst2')
    if ($pinned.Ok -and $pinned.Text -match "Installing flightdeck $tag" -and (Test-Path (Join-Path $work 'inst2\flightdeck.exe'))) { Write-Pass 'VERSION installs that release' } else { Write-Failure 'VERSION installs that release' $pinned.Text }

    Write-Host '-- refusals'
    $bad = Invoke-Install -Version 'v0.0.1-bad' -Dir (Join-Path $work 'inst3')
    if (-not $bad.Ok -and $bad.Text -match 'checksum mismatch' -and -not (Test-Path (Join-Path $work 'inst3\flightdeck.exe'))) { Write-Pass 'a bad checksum aborts the install' } else { Write-Failure 'a bad checksum aborts the install' $bad.Text }
    $noEntry = Invoke-Install -Version 'v0.0.1-noentry' -Dir (Join-Path $work 'inst4')
    if (-not $noEntry.Ok -and $noEntry.Text -match 'has no entry for flightdeck_windows_') { Write-Pass 'a missing checksum entry aborts the install' } else { Write-Failure 'a missing checksum entry aborts the install' $noEntry.Text }
    $unknown = Invoke-Install -Version 'v9.9.9' -Dir (Join-Path $work 'inst5')
    if (-not $unknown.Ok -and $unknown.Text -match '404') { Write-Pass 'an unknown version aborts the install' } else { Write-Failure 'an unknown version aborts the install' $unknown.Text }
    $plain = Invoke-Install -Dir (Join-Path $work 'inst6') -Url 'http://example.invalid'
    if (-not $plain.Ok -and $plain.Text -match 'must be https') { Write-Pass 'a plain-HTTP host other than localhost is refused' } else { Write-Failure 'a plain-HTTP host other than localhost is refused' $plain.Text }
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    Set-UserPath $savedPath
    # HWND_BROADCAST, WM_SETTINGCHANGE, "Environment", SMTO_ABORTIFHUNG,
    # five seconds: what the installer sends after its change.
    if (-not ('FlightdeckInstallTest.NativeMethods' -as [type])) {
        Add-Type -Namespace FlightdeckInstallTest -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
'@
    }
    $broadcast = [UIntPtr]::Zero
    [void][FlightdeckInstallTest.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$broadcast)
    $env:Path = $savedSessionPath
    Remove-Item Env:INSTALL_DIR, Env:FLIGHTDECK_RELEASE_URL, Env:VERSION -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

if ($script:failures -gt 0) {
    Write-Host "INSTALL.PS1 TESTS FAILED ($script:failures)"
    exit 1
}
Write-Host 'INSTALL.PS1 TESTS OK'
