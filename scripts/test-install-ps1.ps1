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
# or preference of its own in the session; a second run, and a PATH
# that has the directory in quotes, add nothing; a PATH past 2,047
# characters gets the entry and a warning, one the entry would take past
# 32,767 is left as it is and the install stops; a failing broadcast of
# the change is a warning; a pinned VERSION, with or without its v; and
# the refusals (an invalid VERSION, a bad checksum, a missing checksum
# entry, an unknown version, a plain-HTTP host).
#
# The user's real PATH is never touched. Every case points the installer
# at a throwaway key, HKCU\Software\flightdeck-test\Environment-<random>,
# through FLIGHTDECK_INSTALL_REGISTRY_KEY, and the key is deleted at the
# end; a run that is killed leaves only that key behind. With
# -UseRealRegistry one more case runs the installer against the real
# HKCU\Environment, the code path users get: it saves the Path value,
# raw and with its registry type, and writes it back at the end. CI
# passes it, on a runner that is thrown away; on your own machine, a
# concurrent change to your PATH during that case would be overwritten
# by the restore.
#
# The server is `python -m http.server`, so python must be on PATH,
# unless -ReleaseUrl names a server that already serves -ServeDir (a
# run from WSL serves a Windows directory from the Linux side).
param(
    [string]$ReleaseUrl = '',
    [string]$ServeDir = '',
    [int]$Port = 8766,
    [switch]$UseRealRegistry
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$runId = [Guid]::NewGuid().ToString('N')
$work = Join-Path ([IO.Path]::GetTempPath()) ('fd-install-ps1-test-' + $runId)
New-Item -ItemType Directory -Path $work | Out-Null
$serve = if ($ServeDir) { $ServeDir } else { Join-Path $work 'serve' }
$tag = 'v0.0.1-test'
$script:failures = 0

# The limits install.ps1 holds the user PATH to.
$pathMaxLength = 32767
$pathWarnLength = 2047

function Write-Pass([string]$what) { Write-Host "  ok: $what" }
function Write-Failure([string]$what, [string]$detail = '') {
    Write-Host "FAIL: $what"
    if ($detail) { Write-Host ($detail -replace '(?m)^', '    ') }
    $script:failures++
}

# The Path value of a key under HKEY_CURRENT_USER, as the registry holds
# it, and how to write one.
$testRoot = 'Software\flightdeck-test'
$testKey = "$testRoot\Environment-$runId"
function Get-PathValue([string]$keyName) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyName)
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
function Set-PathValue([string]$keyName, $value) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyName)
    try {
        if ($null -eq $value) { $key.DeleteValue('Path', $false) } else { $key.SetValue('Path', $value.Raw, $value.Kind) }
    } finally {
        $key.Close()
    }
}
function New-PathValue([string]$raw) {
    [pscustomobject]@{ Raw = $raw; Kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
}

$savedSessionPath = $env:Path
$savedRealPath = $null
$realTouched = $false
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
    Write-Host "== install.ps1 against $ReleaseUrl, the user PATH in HKCU\$testKey"
    $env:FLIGHTDECK_INSTALL_REGISTRY_KEY = $testKey

    # ---- piped through iex, as the README shows it ----------------------
    # A user PATH with an entry that uses a variable, stored as
    # REG_EXPAND_SZ, as Windows creates it.
    $fixturePath = '%USERPROFILE%\fd-install-test-entry'
    Set-PathValue $testKey (New-PathValue $fixturePath)
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
    $userPath = Get-PathValue $testKey
    if ($userPath.Raw -ceq "$fixturePath;$dir1") { Write-Pass 'the user PATH gains the directory and keeps %USERPROFILE% unexpanded' } else { Write-Failure 'the user PATH' $userPath.Raw }
    if ($userPath.Kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) { Write-Pass 'the user PATH stays REG_EXPAND_SZ' } else { Write-Failure 'the user PATH stays REG_EXPAND_SZ' "$($userPath.Kind)" }
    if ($callerErrorAction -eq 'Continue' -and $callerProgress -eq 'Continue') { Write-Pass 'the caller''s preferences are untouched' } else { Write-Failure 'the caller''s preferences are untouched' "ErrorActionPreference=$callerErrorAction ProgressPreference=$callerProgress" }
    $leaked = @('asset', 'installDir', 'tmp', 'repoUrl', 'envKey', 'envKeyName', 'newPath', 'newLength') | Where-Object { Get-Variable -Name $_ -Scope Script -ErrorAction SilentlyContinue }
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
    if ($again.Ok -and (Get-PathValue $testKey).Raw -ceq "$fixturePath;$dir1") { Write-Pass 'a second run adds nothing to the user PATH' } else { Write-Failure 'a second run adds nothing to the user PATH' "$($again.Text)`n$((Get-PathValue $testKey).Raw)" }
    if ($again.Text -notmatch 'Added ') { Write-Pass 'and does not say it added it' } else { Write-Failure 'and does not say it added it' $again.Text }

    Write-Host '-- a PATH that has the directory in quotes'
    $dir7 = Join-Path $work 'inst7'
    $quoted = "%USERPROFILE%\fd-install-test-entry;`"$dir7\`""
    Set-PathValue $testKey (New-PathValue $quoted)
    $quotedRun = Invoke-Install -Dir $dir7
    if ($quotedRun.Ok -and (Get-PathValue $testKey).Raw -ceq $quoted -and $quotedRun.Text -notmatch 'Added ') { Write-Pass 'a quoted entry with a trailing backslash counts as the directory' } else { Write-Failure 'a quoted entry counts as the directory' "$($quotedRun.Text)`n$((Get-PathValue $testKey).Raw)" }

    Write-Host '-- a long PATH'
    # Entries of a hundred characters, enough to pass 2,047 with the new one.
    $longEntries = 1..20 | ForEach-Object { 'C:\fd-install-test-long-' + ('{0:D2}' -f $_) + ('x' * 74) }
    $long = $longEntries -join ';'
    Set-PathValue $testKey (New-PathValue $long)
    $dir8 = Join-Path $work 'inst8'
    $longRun = Invoke-Install -Dir $dir8
    if ($longRun.Ok -and (Get-PathValue $testKey).Raw -ceq "$long;$dir8") { Write-Pass "a PATH past $pathWarnLength characters gets the entry" } else { Write-Failure "a PATH past $pathWarnLength characters gets the entry" $longRun.Text }
    if ($longRun.Text -match "characters long\. Some older programs read only its first $pathWarnLength characters") { Write-Pass 'and a warning' } else { Write-Failure 'and a warning' $longRun.Text }

    # Short of the limit by less than the entry's length.
    $tooLong = 'C:\fd-install-test-' + ('y' * ($pathMaxLength - 40))
    Set-PathValue $testKey (New-PathValue $tooLong)
    $dir9 = Join-Path $work 'inst9'
    $tooLongRun = Invoke-Install -Dir $dir9
    if (-not $tooLongRun.Ok -and $tooLongRun.Text -match "more than the $pathMaxLength Windows allows, so your PATH is unchanged" -and (Get-PathValue $testKey).Raw -ceq $tooLong) { Write-Pass "a PATH the entry would take past $pathMaxLength characters is left as it is" } else { Write-Failure "a PATH past $pathMaxLength characters is left as it is" $tooLongRun.Text }
    if ($tooLongRun.Text -match [regex]::Escape((Join-Path $dir9 'flightdeck.exe')) -and (Test-Path (Join-Path $dir9 'flightdeck.exe'))) { Write-Pass 'and the message says where flightdeck.exe is' } else { Write-Failure 'and the message says where flightdeck.exe is' $tooLongRun.Text }

    Write-Host '-- a broadcast that fails'
    # A new PowerShell in which the type the installer broadcasts through
    # already exists, with a method that throws: the installer uses the
    # type it finds instead of compiling its own.
    Set-PathValue $testKey (New-PathValue $fixturePath)
    $dir10 = Join-Path $work 'inst10'
    $env:INSTALL_DIR = $dir10
    $env:FLIGHTDECK_RELEASE_URL = $ReleaseUrl
    Remove-Item Env:VERSION -ErrorAction SilentlyContinue
    $childScript = Join-Path $work 'broadcast-fails.ps1'
    Set-Content -Path $childScript -Encoding Ascii -Value @'
Add-Type -Namespace FlightdeckInstaller -Name NativeMethods -MemberDefinition @"
public static IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result) { throw new InvalidOperationException("simulated broadcast failure"); }
"@
irm "$env:FLIGHTDECK_RELEASE_URL/install.ps1" | iex
'@
    $shell = (Get-Process -Id $PID).Path
    $ErrorActionPreference = 'Continue'
    $childOut = & $shell -NoProfile -ExecutionPolicy Bypass -File $childScript 2>&1 | Out-String
    $childExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    # The child's console wraps long lines; match on the text with its
    # line breaks folded into spaces.
    $childFlat = $childOut -replace '\s+', ' '
    if ($childExit -eq 0 -and $childFlat -match 'Could not tell running programs that the PATH changed \(.*simulated broadcast failure') { Write-Pass 'a failing broadcast is a warning' } else { Write-Failure 'a failing broadcast is a warning' "exit $childExit`n$childOut" }
    if ($childOut -match 'Added ' -and (Get-PathValue $testKey).Raw -ceq "$fixturePath;$dir10") { Write-Pass 'and the PATH is written and reported all the same' } else { Write-Failure 'and the PATH is written and reported' "$childOut`n$((Get-PathValue $testKey).Raw)" }

    Write-Host '-- VERSION'
    $pinned = Invoke-Install -Version $tag -Dir (Join-Path $work 'inst2')
    if ($pinned.Ok -and $pinned.Text -match "Installing flightdeck $tag" -and (Test-Path (Join-Path $work 'inst2\flightdeck.exe'))) { Write-Pass 'VERSION installs that release' } else { Write-Failure 'VERSION installs that release' $pinned.Text }
    $noV = Invoke-Install -Version $tag.Substring(1) -Dir (Join-Path $work 'inst12')
    if ($noV.Ok -and $noV.Text -match "Installing flightdeck $tag") { Write-Pass 'VERSION may leave out its v' } else { Write-Failure 'VERSION may leave out its v' $noV.Text }
    foreach ($bad in 'latest', 'v1.2', 'v1.2.3/../../evil', 'v1.2.3; Remove-Item x') {
        $badVersion = Invoke-Install -Version $bad -Dir (Join-Path $work 'inst13')
        if (-not $badVersion.Ok -and $badVersion.Text -match 'VERSION must be a release tag' -and -not (Test-Path (Join-Path $work 'inst13'))) { Write-Pass "VERSION '$bad' is refused before anything is downloaded" } else { Write-Failure "VERSION '$bad' is refused" $badVersion.Text }
    }

    Write-Host '-- refusals'
    $bad = Invoke-Install -Version 'v0.0.1-bad' -Dir (Join-Path $work 'inst3')
    if (-not $bad.Ok -and $bad.Text -match 'checksum mismatch' -and -not (Test-Path (Join-Path $work 'inst3\flightdeck.exe'))) { Write-Pass 'a bad checksum aborts the install' } else { Write-Failure 'a bad checksum aborts the install' $bad.Text }
    $noEntry = Invoke-Install -Version 'v0.0.1-noentry' -Dir (Join-Path $work 'inst4')
    if (-not $noEntry.Ok -and $noEntry.Text -match 'has no entry for flightdeck_windows_') { Write-Pass 'a missing checksum entry aborts the install' } else { Write-Failure 'a missing checksum entry aborts the install' $noEntry.Text }
    $unknown = Invoke-Install -Version 'v9.9.9' -Dir (Join-Path $work 'inst5')
    if (-not $unknown.Ok -and $unknown.Text -match '404') { Write-Pass 'an unknown version aborts the install' } else { Write-Failure 'an unknown version aborts the install' $unknown.Text }
    $plain = Invoke-Install -Dir (Join-Path $work 'inst6') -Url 'http://example.invalid'
    if (-not $plain.Ok -and $plain.Text -match 'must be https') { Write-Pass 'a plain-HTTP host other than localhost is refused' } else { Write-Failure 'a plain-HTTP host other than localhost is refused' $plain.Text }

    if ($UseRealRegistry) {
        Write-Host '-- the real HKCU\Environment (-UseRealRegistry)'
        Remove-Item Env:FLIGHTDECK_INSTALL_REGISTRY_KEY
        $savedRealPath = Get-PathValue 'Environment'
        $realTouched = $true
        $realBefore = if ($savedRealPath) { $savedRealPath.Raw } else { '' }
        $dir11 = Join-Path $work 'inst11'
        $real = Invoke-Install -Dir $dir11
        $realAfter = Get-PathValue 'Environment'
        $expected = if (-not $realBefore) { $dir11 } elseif ($realBefore.EndsWith(';')) { "$realBefore$dir11" } else { "$realBefore;$dir11" }
        if ($real.Ok -and $realAfter.Raw -ceq $expected) { Write-Pass 'the real user PATH gains the directory and nothing else changes' } else { Write-Failure 'the real user PATH' "$($real.Text)`n$($realAfter.Raw)" }
        $expectedKind = if ($savedRealPath -and $savedRealPath.Kind -eq [Microsoft.Win32.RegistryValueKind]::String) { 'String' } else { 'ExpandString' }
        if ("$($realAfter.Kind)" -eq $expectedKind) { Write-Pass "it keeps its registry type ($expectedKind)" } else { Write-Failure 'it keeps its registry type' "$($realAfter.Kind)" }
    }
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    # Only once the real Path value was read: restoring a value never
    # saved would delete the user's PATH.
    if ($realTouched) {
        Set-PathValue 'Environment' $savedRealPath
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
    }
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($testKey, $false)
    $parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($testRoot)
    if ($parent) {
        $empty = $parent.SubKeyCount -eq 0 -and $parent.ValueCount -eq 0
        $parent.Close()
        if ($empty) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($testRoot, $false) }
    }
    $env:Path = $savedSessionPath
    Remove-Item Env:INSTALL_DIR, Env:FLIGHTDECK_RELEASE_URL, Env:VERSION, Env:FLIGHTDECK_INSTALL_REGISTRY_KEY -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

if ($script:failures -gt 0) {
    Write-Host "INSTALL.PS1 TESTS FAILED ($script:failures)"
    exit 1
}
Write-Host 'INSTALL.PS1 TESTS OK'
