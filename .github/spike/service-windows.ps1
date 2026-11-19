#Requires -Version 7
# TEMPORARY: the spike of `flightdeck service` on Windows (#347, PR 2). It
# runs on a GitHub-hosted Windows runner only, and is removed before the PR
# is ready. It compares the per-user mechanisms that could start
# flightdeck.exe at logon with no console window and no administrator
# rights, and restart it when it dies:
#
#   A  a HKCU\...\Run value
#   B  a scheduled task, logon type InteractiveToken ("run only when the
#      user is logged on"), with the console build, the GUI-subsystem build
#      and a GUI-subsystem launcher that starts the console build with
#      CREATE_NO_WINDOW
#   C  a scheduled task, logon type S4U ("run whether the user is logged on
#      or not", no password stored), registered by a standard user
#
# -Mode admin is the driver (the runner's own administrator account); it
# creates a standard local user whose name has a space and a non-ASCII
# letter, so its profile path has both, and runs -Mode user as that user.
param(
    [ValidateSet('admin', 'user')] [string] $Mode = 'admin',
    [string] $Root = 'C:\fdspike'
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Bin = Join-Path $Root 'bin'
$Out = Join-Path $Root 'out'
$Results = [System.Collections.Generic.List[object]]::new()

function Section([string] $Title) { Write-Host ''; Write-Host "==== $Title" }
function Note([string] $Text) { Write-Host "  $Text" }
function Result([string] $Case, [string] $Check, [string] $Outcome) {
    $Results.Add([pscustomobject]@{ Case = $Case; Check = $Check; Outcome = $Outcome })
    Write-Host "  RESULT | $Case | $Check | $Outcome"
}

# ---- probes ------------------------------------------------------------

function Get-Listener([int] $Port) {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return [int] $c.OwningProcess }
    $line = netstat -ano -p tcp | Select-String -Pattern "127\.0\.0\.1:$Port\s+\S+\s+LISTENING\s+(\d+)" | Select-Object -First 1
    if ($line) { return [int] $line.Matches[0].Groups[1].Value }
    return 0
}

# Wait-Listener waits up to $Seconds for a process other than $NotPid to
# listen on $Port and returns its pid and the seconds it took, or $null.
function Wait-Listener([int] $Port, [int] $Seconds, [int] $NotPid = 0) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
        $p = Get-Listener $Port
        if ($p -gt 0 -and $p -ne $NotPid) { return [pscustomobject]@{ Pid = $p; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) } }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

function Get-Health([int] $Port, [string] $Path) {
    try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port$Path").Content } catch { return $null }
}

# Windows reports a console window as owned by the console program, so a
# console program in a window of its own has a MainWindowHandle; one with
# no window has 0. Read from this session: a process in another session
# shows 0 whatever it has, so the program's own report (GetConsoleWindow,
# its window station) is read too.
function Get-WindowOf([int] $Id) {
    $p = Get-Process -Id $Id -ErrorAction SilentlyContinue
    if (-not $p) { return 'gone' }
    $p.Refresh()
    return "MainWindowHandle=$($p.MainWindowHandle) session=$($p.SessionId) title='$($p.MainWindowTitle)'"
}

# Every visible top-level window of this session's desktop, with the
# process Windows names as its owner. A window that appears when a program
# starts is what the user would see, whoever owns it (on Server 2025 a
# console window is not the console program's MainWindowHandle).
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SpikeWindows {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    public static List<string> Visible() {
        var list = new List<string>();
        EnumProc f = (h, l) => {
            if (IsWindowVisible(h)) {
                uint pid; GetWindowThreadProcessId(h, out pid);
                var c = new StringBuilder(256); GetClassName(h, c, 256);
                var t = new StringBuilder(256); GetWindowText(h, t, 256);
                list.Add(h.ToInt64() + "|" + pid + "|" + c + "|" + t);
            }
            return true;
        };
        EnumWindows(f, IntPtr.Zero);
        GC.KeepAlive(f);
        return list;
    }
}
'@

function Get-NewWindows([string[]] $Before) {
    $new = [SpikeWindows]::Visible() | Where-Object { $_ -notin $Before }
    if (-not $new) { return 'no new visible window' }
    return 'NEW VISIBLE WINDOWS: ' + (($new | ForEach-Object {
                $f = $_.Split('|'); $n = (Get-Process -Id ([int] $f[1]) -ErrorAction SilentlyContinue).ProcessName
                "pid $($f[1]) ($n) class '$($f[2])' title '$($f[3])'"
            }) -join '; ')
}

# Step runs one part of the spike in this scope; an error ends that part
# only.
function Step([string] $Name, [scriptblock] $Body) {
    try { . $Body } catch { Result $Name 'error' "$($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))" }
}

function Get-Report([string] $Tag) {
    $file = Join-Path $Out "report-$Tag.jsonl"
    if (-not (Test-Path $file)) { return $null }
    return Get-Content -LiteralPath $file | Select-Object -Last 1 | ConvertFrom-Json
}

function Describe-Report($r) {
    if (-not $r) { return 'no report' }
    return "session=$($r.session) station=$($r.window_station) desktop=$($r.desktop) console_window=$($r.console_window) visible=$($r.console_visible) user=$($r.username) LOCALAPPDATA=$($r.localappdata)"
}

# ---- scheduled tasks -----------------------------------------------------

function New-TaskXml {
    param([string] $UserId, [string] $LogonType, [string] $Command, [string] $Arguments, [string] $WorkDir,
        [switch] $RestartOnFailure, [switch] $Repeat)
    $e = { param($s) [Security.SecurityElement]::Escape($s) }
    $triggers = "<LogonTrigger><Enabled>true</Enabled><UserId>$(& $e $UserId)</UserId></LogonTrigger>"
    if ($Repeat) {
        $start = (Get-Date).AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss')
        $triggers += "<TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>$start</StartBoundary><Enabled>true</Enabled></TimeTrigger>"
    }
    $restart = if ($RestartOnFailure) { '<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>' } else { '' }
    return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Flightdeck service spike</Description></RegistrationInfo>
  <Triggers>$triggers</Triggers>
  <Principals><Principal id="Author"><UserId>$(& $e $UserId)</UserId><LogonType>$LogonType</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    $restart
  </Settings>
  <Actions Context="Author"><Exec><Command>$(& $e $Command)</Command><Arguments>$(& $e $Arguments)</Arguments><WorkingDirectory>$(& $e $WorkDir)</WorkingDirectory></Exec></Actions>
</Task>
"@
}

# Register-Task registers the task $Name from $Xml with schtasks /Create
# /XML, as the Go code would, and returns schtasks' exit code.
function Register-Task([string] $Name, [string] $Xml) {
    $file = Join-Path $env:TEMP "fdspike-$([guid]::NewGuid().ToString('N')).xml"
    [IO.File]::WriteAllText($file, $Xml, [Text.Encoding]::Unicode)
    $o = schtasks /Create /XML $file /TN $Name /F 2>&1
    $code = $LASTEXITCODE
    Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue
    Note "schtasks /Create /XML /TN '$Name': exit $code $($o -join ' ')"
    return $code
}

function Start-Task([string] $Name) {
    $o = schtasks /Run /TN $Name 2>&1
    Note "schtasks /Run /TN '$Name': exit $LASTEXITCODE $($o -join ' ')"
    return $LASTEXITCODE
}

function Remove-Task([string] $Name) {
    $o = schtasks /End /TN $Name 2>&1; Note "schtasks /End: exit $LASTEXITCODE $($o -join ' ')"
    $o = schtasks /Delete /TN $Name /F 2>&1; Note "schtasks /Delete: exit $LASTEXITCODE $($o -join ' ')"
}

function Get-TaskLastResult([string] $Name) {
    $q = schtasks /Query /TN $Name /V /FO LIST 2>&1
    $status = ($q | Select-String '^Status:').Line
    $last = ($q | Select-String '^Last Result:').Line
    return "$status; $last"
}

# Test-KillAndRestart kills the process listening on $Port with taskkill
# /F, as a crash or the Task Manager would end it, and waits for another to
# listen there.
function Test-KillAndRestart([string] $Case, [string] $TaskName, [int] $Port, [int] $Seconds) {
    $before = Get-Listener $Port
    if ($before -le 0) { Result $Case 'restart after taskkill /F' 'not tested: nothing listened'; return }
    $o = taskkill /F /PID $before 2>&1
    Note "taskkill /F /PID $before (from $env:USERNAME's process): exit $LASTEXITCODE $($o -join ' ')"
    if ($LASTEXITCODE -ne 0) { Result $Case 'taskkill /F by the same user' "FAILED: $($o -join ' ')"; return }
    Start-Sleep -Seconds 3
    if ($TaskName) { Note "after the kill: $(Get-TaskLastResult $TaskName)" }
    $w = Wait-Listener $Port $Seconds $before
    if ($w) { Result $Case 'restart after taskkill /F' "restarted after $($w.Seconds) s (pid $before -> $($w.Pid))" }
    else { Result $Case 'restart after taskkill /F' "NOT restarted within $Seconds s" }
}

# ---- the programs the spike runs ----------------------------------------

$SleeperGo = @'
// sleeper reports how it was started (session, window station, console
// window, profile) into -out and listens on 127.0.0.1:-port until killed.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32                   = syscall.NewLazyDLL("kernel32.dll")
	user32                     = syscall.NewLazyDLL("user32.dll")
	pGetConsoleWindow          = kernel32.NewProc("GetConsoleWindow")
	pProcessIdToSessionId      = kernel32.NewProc("ProcessIdToSessionId")
	pGetCurrentThreadId        = kernel32.NewProc("GetCurrentThreadId")
	pIsWindowVisible           = user32.NewProc("IsWindowVisible")
	pGetProcessWindowStation   = user32.NewProc("GetProcessWindowStation")
	pGetThreadDesktop          = user32.NewProc("GetThreadDesktop")
	pGetUserObjectInformationW = user32.NewProc("GetUserObjectInformationW")
)

func objName(h uintptr) string {
	if h == 0 {
		return ""
	}
	var buf [256]uint16
	var n uint32
	r, _, _ := pGetUserObjectInformationW.Call(h, 2, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)*2), uintptr(unsafe.Pointer(&n)))
	if r == 0 {
		return "?"
	}
	return syscall.UTF16ToString(buf[:])
}

func main() {
	runtime.LockOSThread()
	port := flag.Int("port", 0, "port")
	tag := flag.String("tag", "", "tag")
	out := flag.String("out", "", "report file")
	flag.Parse()
	var session uint32
	pProcessIdToSessionId.Call(uintptr(os.Getpid()), uintptr(unsafe.Pointer(&session)))
	cw, _, _ := pGetConsoleWindow.Call()
	vis := uintptr(0)
	if cw != 0 {
		vis, _, _ = pIsWindowVisible.Call(cw)
	}
	ws, _, _ := pGetProcessWindowStation.Call()
	tid, _, _ := pGetCurrentThreadId.Call()
	desk, _, _ := pGetThreadDesktop.Call(tid)
	stdout, _ := syscall.GetStdHandle(syscall.STD_OUTPUT_HANDLE)
	_, werr := fmt.Fprintln(os.Stdout, "sleeper", *tag, "started")
	report := map[string]any{
		"tag": *tag, "pid": os.Getpid(), "ppid": os.Getppid(), "session": session,
		"console_window": cw != 0, "console_visible": vis != 0,
		"window_station": objName(ws), "desktop": objName(desk),
		"stdout_handle": uintptr(stdout), "stdout_write_error": fmt.Sprint(werr),
		"username": os.Getenv("USERNAME"), "localappdata": os.Getenv("LOCALAPPDATA"), "userprofile": os.Getenv("USERPROFILE"),
		"started": time.Now().UTC().Format(time.RFC3339Nano), "args": os.Args,
	}
	data, _ := json.Marshal(report)
	if *out != "" {
		if f, err := os.OpenFile(*out, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o666); err == nil {
			_, _ = f.Write(append(data, '\n'))
			_ = f.Close()
		}
	}
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(data) })
	if err := http.ListenAndServe(fmt.Sprintf("127.0.0.1:%d", *port), nil); err != nil {
		os.Exit(3)
	}
}
'@

$LauncherGo = @'
// launcher, built as a GUI-subsystem program, starts the console program
// its arguments name with CREATE_NO_WINDOW and waits for it.
package main

import (
	"os"
	"os/exec"
	"syscall"
)

func main() {
	cmd := exec.Command(os.Args[1], os.Args[2:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000, HideWindow: true}
	if err := cmd.Run(); err != nil {
		os.Exit(1)
	}
}
'@

function Build-Programs([string] $Repo) {
    New-Item -ItemType Directory -Force -Path $Bin, $Out | Out-Null
    foreach ($p in @(@{ Name = 'sleeper'; Src = $SleeperGo }, @{ Name = 'launcher'; Src = $LauncherGo })) {
        $dir = Join-Path $env:RUNNER_TEMP "spike-$($p.Name)"
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Set-Content -LiteralPath (Join-Path $dir 'main.go') -Value $p.Src -Encoding utf8NoBOM
        Set-Content -LiteralPath (Join-Path $dir 'go.mod') -Value "module $($p.Name)`n`ngo 1.27`n" -Encoding utf8NoBOM
        Push-Location $dir
        if ($p.Name -eq 'sleeper') { go build -o (Join-Path $Bin 'sleeper.exe') . }
        go build -ldflags '-H=windowsgui' -o (Join-Path $Bin "$($p.Name)w.exe") .
        Pop-Location
    }
    Push-Location $Repo
    go build -o (Join-Path $Bin 'flightdeck.exe') ./cmd/flightdeck
    go build -ldflags '-H=windowsgui' -o (Join-Path $Bin 'flightdeckw.exe') ./cmd/flightdeck
    Pop-Location
    Get-ChildItem $Bin | ForEach-Object { Note "$($_.Name) $([math]::Round($_.Length / 1MB, 1)) MB" }
    # The standard user reads the programs and writes its reports here.
    icacls $Root /grant '*S-1-5-32-545:(OI)(CI)M' /T | Out-Null
}

function Environment-Report {
    Section 'the runner'
    $os = Get-CimInstance Win32_OperatingSystem
    Note "$($os.Caption) $($os.Version) build $($os.BuildNumber)"
    Note "this process: $env:USERDOMAIN\$env:USERNAME session $((Get-Process -Id $PID).SessionId)"
    Note "integrity: $((whoami /groups | Select-String 'Mandatory Label').Line.Trim())"
    $lua = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue).EnableLUA
    Note "UAC EnableLUA=$lua"
    Get-Process explorer -ErrorAction SilentlyContinue | ForEach-Object { Note "explorer pid $($_.Id) session $($_.SessionId)" }
    $q = query user 2>&1; Note "query user: $($q -join ' | ')"
    $mp = Get-MpComputerStatus -ErrorAction SilentlyContinue
    if ($mp) { Note "Defender: AMServiceEnabled=$($mp.AMServiceEnabled) RealTimeProtectionEnabled=$($mp.RealTimeProtectionEnabled) AntivirusEnabled=$($mp.AntivirusEnabled)" }
    else { Note 'Defender: no status' }
}

# ---- the administrator's part ---------------------------------------------

# Start-Watched runs $Start (which starts a program listening on $Port),
# waits for the listener, and reports the windows that appeared and the
# program's own report.
function Start-Watched([string] $Case, [int] $Port, [string] $Tag, [scriptblock] $Start, [int] $Seconds = 30) {
    $before = [SpikeWindows]::Visible()
    $p = & $Start
    $w = Wait-Listener $Port $Seconds
    if (-not $w) { Result $Case 'start' 'did not listen'; return $null }
    Start-Sleep -Seconds 2
    $self = if ($Tag) { "; $(Describe-Report (Get-Report $Tag))" } else { '' }
    Result $Case 'window' "$(Get-NewWindows $before); $(Get-WindowOf $w.Pid)$self"
    return $w
}

function Invoke-Admin {
    Environment-Report
    Section 'build'
    Build-Programs (Get-Location).Path
    $me = "$env:USERDOMAIN\$env:USERNAME"
    $sleeper = Join-Path $Bin 'sleeper.exe'
    $sleeperw = Join-Path $Bin 'sleeperw.exe'
    $launcherw = Join-Path $Bin 'launcherw.exe'
    $flightdeck = Join-Path $Bin 'flightdeck.exe'
    $flightdeckw = Join-Path $Bin 'flightdeckw.exe'

    Step 'control' {
        Section 'control: a console program started in a window of its own in this session'
        $script:p = $null
        Start-Watched 'control (console, new window)' 4231 control {
            $script:p = Start-Process -FilePath $sleeper -ArgumentList '-port 4231 -tag control -out', (Join-Path $Out 'report-control.jsonl') -PassThru
        } | Out-Null
        Get-Process sleeper -ErrorAction SilentlyContinue | Stop-Process -Force
    }

    Step 'A Run value' {
        Section 'A: a HKCU Run value, started as Explorer starts it at logon'
        $run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        foreach ($c in @(@{ Tag = 'run-console'; Exe = $sleeper; Port = 4232 }, @{ Tag = 'run-gui'; Exe = $sleeperw; Port = 4233 })) {
            $cmd = "`"$($c.Exe)`" -port $($c.Port) -tag $($c.Tag) -out `"$(Join-Path $Out "report-$($c.Tag).jsonl")`""
            # A profile may have no Run key yet (the 2025 image's has none).
            if (-not (Test-Path $run)) { New-Item -Path $run -Force | Out-Null; Note "created $run" }
            Set-ItemProperty -Path $run -Name 'FlightdeckSpike' -Value $cmd
            $value = (Get-ItemProperty -Path $run).FlightdeckSpike
            # Explorer runs each value's command line in the user's session at
            # logon: the same as starting it from this session.
            $exe = $value.Substring(1, $value.IndexOf('"', 1) - 1); $argline = $value.Substring($value.IndexOf('"', 1) + 2)
            Start-Watched "A Run value ($($c.Tag))" $c.Port $c.Tag { Start-Process -FilePath $exe -ArgumentList $argline -PassThru } | Out-Null
            if ($c.Tag -eq 'run-gui') { Test-KillAndRestart "A Run value ($($c.Tag))" '' $c.Port 75 }
            Get-Process sleeper, sleeperw -ErrorAction SilentlyContinue | Stop-Process -Force
            Remove-ItemProperty -Path $run -Name 'FlightdeckSpike'
        }
    }

    Section 'B: scheduled tasks, InteractiveToken, for the logged-on administrator'
    $cases = @(
        @{ Tag = 'it-console'; Cmd = $sleeper; Args = '-port 4234 -tag it-console -out "{0}"'; Port = 4234; Restart = $true; Repeat = $false },
        @{ Tag = 'it-gui'; Cmd = $sleeperw; Args = '-port 4235 -tag it-gui -out "{0}"'; Port = 4235; Restart = $false; Repeat = $true },
        @{ Tag = 'it-launcher'; Cmd = $launcherw; Args = "`"$sleeper`" -port 4236 -tag it-launcher -out `"{0}`""; Port = 4236; Restart = $false; Repeat = $false },
        @{ Tag = ''; Name = 'it-flightdeckw'; Cmd = $flightdeckw; Args = "--port 4240 --data-dir `"$(Join-Path $Root 'data-flightdeckw')`""; Port = 4240; Restart = $false; Repeat = $true },
        @{ Tag = ''; Name = 'it-launcher-flightdeck'; Cmd = $launcherw; Args = "`"$flightdeck`" --port 4241 --data-dir `"$(Join-Path $Root 'data-launcher')`""; Port = 4241; Restart = $false; Repeat = $true }
    )
    foreach ($c in $cases) {
        $label = if ($c.Tag) { $c.Tag } else { $c.Name }
        Step "B interactive ($label)" {
            $name = "FlightdeckSpike-$label"
            $argline = if ($c.Tag) { $c.Args -f (Join-Path $Out "report-$($c.Tag).jsonl") } else { $c.Args }
            $xml = New-TaskXml -UserId $me -LogonType InteractiveToken -Command $c.Cmd -Arguments $argline -WorkDir $Bin -RestartOnFailure:$c.Restart -Repeat:$c.Repeat
            if ((Register-Task $name $xml) -ne 0) { Result "B interactive ($label)" 'register' 'FAILED'; return }
            $w = Start-Watched "B interactive ($label)" $c.Port $c.Tag { Start-Task $name | Out-Null } 90
            if ($w -and -not $c.Tag) { Result "B interactive ($label)" 'health' "$(Get-Health $c.Port '/api/health')" }
            if ($w -and $c.Restart) { Test-KillAndRestart "B interactive ($label), RestartOnFailure 1 min" $name $c.Port 140 }
            if ($w -and $c.Repeat) { Test-KillAndRestart "B interactive ($label), time trigger every 1 min" $name $c.Port 100 }
            Remove-Task $name
            Get-Process sleeper, sleeperw, launcherw, flightdeck, flightdeckw -ErrorAction SilentlyContinue | Stop-Process -Force
        }
    }

    Section 'a standard user whose profile path has a space and a non-ASCII letter'
    $user = "Fd Sp$([char]0x00EF)ke"
    $pw = 'Fd!' + (-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 16 | ForEach-Object { [char] $_ })) + 'a1'
    $computer = [ADSI]"WinNT://$env:COMPUTERNAME,computer"
    $u = $computer.Create('User', $user); $u.SetPassword($pw); $u.SetInfo()
    ([ADSI]"WinNT://$env:COMPUTERNAME/Users,group").Add("WinNT://$env:COMPUTERNAME/$user,user")
    Note "groups of '$user': $((net user $user | Select-String 'Local Group').Line)"
    $cred = [pscredential]::new("$env:COMPUTERNAME\$user", (ConvertTo-SecureString $pw -AsPlainText -Force))
    $pwsh = (Get-Command pwsh).Source
    # The checkout is the runner account's; the user reads its own copy.
    $script = Join-Path $Root 'spike.ps1'
    Copy-Item -LiteralPath $PSCommandPath -Destination $script
    try {
        $p = Start-Process -FilePath $pwsh -ArgumentList '-NoProfile', '-File', "`"$script`"", '-Mode', 'user', '-Root', $Root `
            -Credential $cred -LoadUserProfile -WorkingDirectory $Root -RedirectStandardOutput (Join-Path $Out 'user.log') `
            -RedirectStandardError (Join-Path $Out 'user.err') -PassThru -Wait
        Note "the user's part ran through Start-Process -Credential: exit $($p.ExitCode)"
    } catch { Note "Start-Process -Credential failed: $_" }
    Section "the standard user's part (its log)"
    Get-Content -LiteralPath (Join-Path $Out 'user.log') -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  | $_"
        if ($_ -match '^\s*RESULT \| (.+?) \| (.+?) \| (.*)$') { $Results.Add([pscustomobject]@{ Case = $Matches[1]; Check = $Matches[2]; Outcome = $Matches[3] }) }
    }
    Get-Content -LiteralPath (Join-Path $Out 'user.err') -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  ! $_" }
    Get-Process sleeper, flightdeck -ErrorAction SilentlyContinue | Stop-Process -Force

    Step 'removal' {
        Section 'nothing left: tasks, the task cache, the Tasks folder, the Run values'
        $left = schtasks /Query /FO CSV /NH 2>$null | Select-String 'FlightdeckSpike'
        Result 'removal' 'schtasks /Query' $(if ($left) { "LEFT: $($left -join '; ')" } else { 'no FlightdeckSpike task' })
        $tree = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Schedule\TaskCache\Tree' -ErrorAction SilentlyContinue | Where-Object PSChildName -like 'FlightdeckSpike*'
        Result 'removal' 'TaskCache\Tree' $(if ($tree) { "LEFT: $($tree.PSChildName -join ', ')" } else { 'no key' })
        $files = Get-ChildItem 'C:\Windows\System32\Tasks' -Filter 'FlightdeckSpike*' -ErrorAction SilentlyContinue
        Result 'removal' 'System32\Tasks' $(if ($files) { "LEFT: $($files.Name -join ', ')" } else { 'no file' })
        $runLeft = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).PSObject.Properties.Name -contains 'FlightdeckSpike'
        Result 'removal' "administrator's Run value" $(if ($runLeft) { 'LEFT' } else { 'gone' })
        $procs = Get-Process sleeper, sleeperw, launcherw, flightdeck, flightdeckw -ErrorAction SilentlyContinue
        Result 'removal' 'processes' $(if ($procs) { "LEFT: $(($procs | ForEach-Object { "$($_.ProcessName) $($_.Id)" }) -join ', ')" } else { 'none' })
    }

    Step 'antivirus' {
        Section 'Defender'
        $det = Get-MpThreatDetection -ErrorAction SilentlyContinue
        Result 'antivirus' 'Get-MpThreatDetection' $(if ($det) { "$($det.Count) detections: $(($det | ForEach-Object { $_.ThreatID }) -join ', ')" } else { 'none' })
        $ev = Get-WinEvent -LogName 'Microsoft-Windows-Windows Defender/Operational' -MaxEvents 200 -ErrorAction SilentlyContinue | Where-Object { $_.Id -in 1006, 1007, 1015, 1116, 1117 }
        Result 'antivirus' 'Defender events 1006/1015/1116/1117' $(if ($ev) { "$($ev.Count): $($ev[0].Message.Split("`n")[0])" } else { 'none' })
    }

    Section 'summary'
    $Results | Format-Table -AutoSize -Wrap | Out-String -Width 400 | Write-Host
    if ($env:GITHUB_STEP_SUMMARY) {
        $md = @("## flightdeck service spike on $((Get-CimInstance Win32_OperatingSystem).Caption)", '', '| Case | Check | Outcome |', '|---|---|---|')
        $md += $Results | ForEach-Object { "| $($_.Case) | $($_.Check) | $($_.Outcome.Replace('|', '/')) |" }
        Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $md
    }
}

# ---- the standard user's part ----------------------------------------------

function Invoke-User {
    try {
        # Start-Process -Credential hands this process the administrator's
        # environment; the token is the standard user's. The paths come
        # from the token, and the variables are set for what this starts.
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $me = $id.Name
        $env:USERDOMAIN, $env:USERNAME = $me.Split('\', 2)
        # The profile directory comes from the token; the known folders of a
        # new profile expand %LOCALAPPDATA% from the inherited environment.
        $env:USERPROFILE = [Environment]::GetFolderPath('UserProfile')
        $env:LOCALAPPDATA = Join-Path $env:USERPROFILE 'AppData\Local'
        $env:APPDATA = Join-Path $env:USERPROFILE 'AppData\Roaming'
        $env:TEMP = $env:TMP = Join-Path $env:LOCALAPPDATA 'Temp'
        New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
        Section "as $me"
        Note "profile $env:USERPROFILE; LOCALAPPDATA $env:LOCALAPPDATA"
        Note "integrity: $((whoami /groups | Select-String 'Mandatory Label').Line.Trim())"
        $admin = ([Security.Principal.WindowsPrincipal] $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        Result 'standard user' 'is an administrator' "$admin"
        Result 'standard user' 'profile' "$env:USERPROFILE"
        # The programs where an install under this profile puts them.
        $prog = Join-Path $env:LOCALAPPDATA 'Programs\Flight Deck'
        New-Item -ItemType Directory -Force -Path $prog | Out-Null
        Copy-Item (Join-Path $Bin '*.exe') $prog
        $sleeper = Join-Path $prog 'sleeper.exe'
        $flightdeck = Join-Path $prog 'flightdeck.exe'
        Note "programs in $prog"

        Step 'A Run value, standard user' {
            Section 'A: a Run value written without administrator rights'
            $o = reg add 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' /v FlightdeckSpike /t REG_SZ /d "`"$flightdeck`" --port 4250" /f 2>&1
            Result 'A Run value, standard user' 'reg add HKCU Run' "exit $LASTEXITCODE"
            $o = reg delete 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' /v FlightdeckSpike /f 2>&1
            Result 'A Run value, standard user' 'reg delete' "exit $LASTEXITCODE"
        }

        Step 'B interactive, standard user' {
            Section 'B: an InteractiveToken task registered by the standard user'
            $name = 'FlightdeckSpike-user-it'
            $xml = New-TaskXml -UserId $me -LogonType InteractiveToken -Command $sleeper -Arguments "-port 4251 -tag user-it -out `"$(Join-Path $Out 'report-user-it.jsonl')`"" -WorkDir $prog -RestartOnFailure -Repeat
            $code = Register-Task $name $xml
            Result 'B interactive, standard user' 'register' "exit $code"
            if ($code -eq 0) {
                Start-Task $name | Out-Null
                $w = Wait-Listener 4251 20
                Result 'B interactive, standard user' 'run with no Winlogon session of its own' $(if ($w) { "ran: $(Describe-Report (Get-Report user-it))" } else { "did not run: $(Get-TaskLastResult $name)" })
                Remove-Task $name
            }
        }

        $script:s4uWorks = $false
        foreach ($c in @(
                @{ Tag = 'user-s4u-restart'; Port = 4252; Restart = $true; Repeat = $false; Wait = 140 },
                @{ Tag = 'user-s4u-repeat'; Port = 4253; Restart = $false; Repeat = $true; Wait = 100 })) {
            Step "C S4U ($($c.Tag))" {
                Section "C: an S4U task registered by the standard user ($($c.Tag))"
                $name = "FlightdeckSpike-$($c.Tag)"
                $xml = New-TaskXml -UserId $me -LogonType S4U -Command $sleeper -Arguments "-port $($c.Port) -tag $($c.Tag) -out `"$(Join-Path $Out "report-$($c.Tag).jsonl")`"" -WorkDir $prog -RestartOnFailure:$c.Restart -Repeat:$c.Repeat
                $code = Register-Task $name $xml
                Result "C S4U ($($c.Tag))" 'register as a standard user' "exit $code"
                if ($code -ne 0) { return }
                $before = [SpikeWindows]::Visible()
                Start-Task $name | Out-Null
                $w = Wait-Listener $c.Port 30
                if (-not $w) { Result "C S4U ($($c.Tag))" 'start' "did not listen: $(Get-TaskLastResult $name)"; Remove-Task $name; return }
                $script:s4uWorks = $true
                Start-Sleep 2
                Result "C S4U ($($c.Tag))" 'window' "$(Get-NewWindows $before); $(Get-WindowOf $w.Pid); $(Describe-Report (Get-Report $c.Tag))"
                $label = if ($c.Restart) { 'RestartOnFailure 1 min' } else { 'time trigger every 1 min' }
                Test-KillAndRestart "C S4U ($($c.Tag)), $label" $name $c.Port $c.Wait
                Remove-Task $name
                $null = schtasks /Query /TN $name 2>&1
                Result "C S4U ($($c.Tag))" 'removed' "schtasks /Query exit $LASTEXITCODE; listener $(Get-Listener $c.Port)"
            }
        }

        Step 'C S4U flightdeck.exe' {
            Section 'C: flightdeck.exe from an S4U task, its default data dir under this profile'
            if (-not $script:s4uWorks) { Result 'C S4U flightdeck.exe' 'run' 'skipped: no S4U task ran'; return }
            $name = 'FlightdeckSpike-user-flightdeck'
            $xml = New-TaskXml -UserId $me -LogonType S4U -Command $flightdeck -Arguments '--port 4254' -WorkDir $prog -Repeat
            if ((Register-Task $name $xml) -ne 0) { Result 'C S4U flightdeck.exe' 'register' 'FAILED'; return }
            $before = [SpikeWindows]::Visible()
            Start-Task $name | Out-Null
            $w = Wait-Listener 4254 90
            if (-not $w) { Result 'C S4U flightdeck.exe' 'start' "did not listen: $(Get-TaskLastResult $name)"; Remove-Task $name; return }
            Start-Sleep 2
            Result 'C S4U flightdeck.exe' 'window' "$(Get-NewWindows $before); $(Get-WindowOf $w.Pid)"
            Result 'C S4U flightdeck.exe' 'health' "$(Get-Health 4254 '/api/health')"
            $data = Join-Path $env:LOCALAPPDATA 'flightdeck'
            Result 'C S4U flightdeck.exe' 'data dir' "$data has: $((Get-ChildItem -LiteralPath $data -Name -ErrorAction SilentlyContinue) -join ', ')"
            try { $held = (Get-Content -LiteralPath (Join-Path $data 'flightdeck.lock') -Raw -ErrorAction Stop).Trim() } catch { $held = "unreadable: $($_.Exception.Message)" }
            Result 'C S4U flightdeck.exe' 'pid in flightdeck.lock' "'$held', listener pid $($w.Pid)"
            Test-KillAndRestart 'C S4U flightdeck.exe, time trigger every 1 min' $name 4254 100
            Section 'C: a second install on another port'
            $o = schtasks /End /TN $name 2>&1; Note "schtasks /End: exit $LASTEXITCODE $($o -join ' ')"
            Start-Sleep 2
            $old = Get-Listener 4254
            Result 'C S4U flightdeck.exe' 'schtasks /End stops it' $(if ($old -gt 0) { "NO: pid $old still listens" } else { 'yes' })
            if ($old -gt 0) { taskkill /F /PID $old | Out-Null }
            $xml = New-TaskXml -UserId $me -LogonType S4U -Command $flightdeck -Arguments '--port 4255' -WorkDir $prog -Repeat
            Register-Task $name $xml | Out-Null
            Start-Task $name | Out-Null
            $w2 = Wait-Listener 4255 90
            Result 'C S4U flightdeck.exe' 'second install' $(if ($w2) { "4255 answers $(Get-Health 4255 '/api/health'); 4254 listener: $(Get-Listener 4254)" } else { 'did not listen on 4255' })
            Remove-Task $name
            Start-Sleep 2
            $still = Get-Listener 4255
            if ($still -gt 0) { taskkill /F /PID $still | Out-Null }
            $null = schtasks /Query /TN $name 2>&1
            Result 'C S4U flightdeck.exe' 'remove' "schtasks /Query exit $LASTEXITCODE; a listener on 4255 after /End and /Delete: $still"
        }
        $runLeft = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).PSObject.Properties.Name -contains 'FlightdeckSpike'
        Result 'removal' "standard user's Run value" $(if ($runLeft) { 'LEFT' } else { 'gone' })
    } finally {
        Set-Content -LiteralPath (Join-Path $Out 'user.done') -Value 'done'
    }
}

if ($Mode -eq 'admin') { Invoke-Admin } else { Invoke-User }
