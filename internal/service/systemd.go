package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// systemdUnit is the unit's name; the file is <user unit dir>/systemdUnit.
const systemdUnit = "flightdeck.service"

// homebrewSystemdUnit is the unit `brew services` writes for the formula
// on Linux.
const homebrewSystemdUnit = "homebrew.flightdeck.service"

// systemd is the systemd user manager, through systemctl --user.
type systemd struct {
	rt IO
	// configHome is the manager's XDG_CONFIG_HOME, read by available.
	configHome string
}

func (s *systemd) kind() string { return "systemd user unit" }

func (s *systemd) path() string {
	home := s.configHome
	if home == "" {
		home = filepath.Join(s.rt.Home, ".config")
	}
	return filepath.Join(home, "systemd", "user", systemdUnit)
}

func (s *systemd) run(ctx context.Context, args ...string) ([]byte, []byte, error) {
	return s.rt.Run(ctx, "systemctl", append([]string{"--user"}, args...)...)
}

// available asks the user manager for its environment: an answer is a
// manager to talk to, and its XDG_CONFIG_HOME, when it sets one, is where
// it reads user units from, whatever this shell's says.
func (s *systemd) available(ctx context.Context) error {
	out, stderr, err := s.run(ctx, "show-environment")
	switch {
	case errors.Is(err, exec.ErrNotFound):
		return unsupported("this system has no systemctl, and flightdeck service runs a systemd user unit; start flightdeck with " +
			"your init system, or in Docker with --restart unless-stopped")
	case err != nil && bytes.Contains(stderr, []byte("not been booted with systemd")) && s.rt.WSL:
		return unsupported("WSL runs here without systemd, so there is no user service manager: add [boot] systemd=true to " +
			"/etc/wsl.conf, run wsl --shutdown from Windows, open WSL again and run this again")
	case err != nil && bytes.Contains(stderr, []byte("not been booted with systemd")):
		return unsupported("systemd is not running on this system (it is not PID 1), so there is no user service manager; start " +
			"flightdeck with your init system, or in Docker with --restart unless-stopped")
	case err != nil:
		return unsupported("no systemd user manager answers for this user (systemctl --user: %s). A login session starts one; "+
			"for a user with none (a shell reached through sudo, cron), lingering starts it at boot: sudo loginctl enable-linger %s",
			firstLine(append(stderr, []byte(err.Error())...)), s.user())
	}
	for _, line := range strings.Split(string(out), "\n") {
		if v, ok := strings.CutPrefix(line, "XDG_CONFIG_HOME="); ok && filepath.IsAbs(v) {
			s.configHome = v
		}
	}
	return nil
}

func (s *systemd) user() string {
	if s.rt.User != "" {
		return s.rt.User
	}
	return "$USER"
}

// render writes the unit. Every argument of ExecStart is in double
// quotes, with systemd's escapes: \ and " take a backslash, and % and $
// are doubled, since systemd reads them as specifiers and variables
// anywhere on the line. checkValues has refused control characters.
func (s *systemd) render(c Config) []byte {
	words := make([]string, 0, len(c.Argv()))
	for _, a := range c.Argv() {
		words = append(words, systemdQuote(a))
	}
	return []byte(fmt.Sprintf(`# %s: flightdeck service install rewrites it, and
# flightdeck service remove removes it. ARCHITECTURE.md, Deployment > Running in
# the background, at https://github.com/flightdeckhq/flightdeck says what each line does.
[Unit]
Description=Flightdeck
Documentation=https://github.com/flightdeckhq/flightdeck
# Started again for as long as it takes: a crash, a database that is down.
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=%s
Restart=on-failure
RestartSec=%d
TimeoutStopSec=%d

[Install]
WantedBy=default.target
`, marker, strings.Join(words, " "), restartDelaySecs, stopTimeoutSecs))
}

func systemdQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		case '%':
			b.WriteString("%%")
		case '$':
			b.WriteString("$$")
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// argv reads ExecStart back: the words render wrote, unquoted by the
// same rules systemd applies to them.
func (s *systemd) argv(content []byte) ([]string, error) {
	for _, line := range strings.Split(string(content), "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "ExecStart="); ok {
			return systemdWords(v)
		}
	}
	return nil, errors.New("the unit has no ExecStart line")
}

func systemdWords(line string) ([]string, error) {
	var words []string
	i := 0
	for {
		for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
			i++
		}
		if i >= len(line) {
			return words, nil
		}
		var b strings.Builder
		quoted := line[i] == '"'
		if quoted {
			i++
		}
		for {
			if i >= len(line) {
				if quoted {
					return nil, errors.New("ExecStart has a quote that is not closed")
				}
				break
			}
			ch := line[i]
			switch {
			case quoted && ch == '"':
				i++
			case !quoted && (ch == ' ' || ch == '\t'):
			case ch == '\\' && i+1 < len(line):
				b.WriteByte(line[i+1])
				i += 2
				continue
			case (ch == '%' || ch == '$') && i+1 < len(line) && line[i+1] == ch:
				b.WriteByte(ch)
				i += 2
				continue
			default:
				b.WriteByte(ch)
				i++
				continue
			}
			break
		}
		words = append(words, b.String())
	}
}

// state reads the unit's properties. A unit the manager has no file for
// is LoadState=not-found, which systemctl answers without an error.
func (s *systemd) state(ctx context.Context) (state, error) {
	props, err := s.show(ctx, systemdUnit)
	if err != nil {
		return state{}, err
	}
	pid, _ := strconv.Atoi(props["MainPID"])
	active, sub := props["ActiveState"], props["SubState"]
	return state{
		loaded:  props["LoadState"] == "loaded",
		running: (active == "active" || active == "reloading") && pid > 0,
		pid:     pid,
		enabled: props["UnitFileState"] == "enabled",
		failed:  active == "failed" || sub == "auto-restart",
		detail:  active + ", " + sub,
	}, nil
}

func (s *systemd) show(ctx context.Context, unit string) (map[string]string, error) {
	args := []string{"show", unit, "--property=LoadState,ActiveState,SubState,MainPID,UnitFileState"}
	out, stderr, err := s.run(ctx, args...)
	if err != nil {
		return nil, commandError("systemctl --user", args, stderr, err)
	}
	props := map[string]string{}
	for _, line := range strings.Split(string(out), "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(line), "="); ok {
			props[k] = v
		}
	}
	return props, nil
}

// do runs systemctl --user with args and turns a failure into an error
// that names the command.
func (s *systemd) do(ctx context.Context, args ...string) error {
	if _, stderr, err := s.run(ctx, args...); err != nil {
		return commandError("systemctl --user", args, stderr, err)
	}
	return nil
}

// load reloads the manager's units, enables the unit and restarts it,
// which starts it when it was stopped. reset-failed first clears a
// failed state, which would otherwise be reported.
func (s *systemd) load(ctx context.Context) error {
	for _, args := range [][]string{{"daemon-reload"}, {"enable", systemdUnit}} {
		if err := s.do(ctx, args...); err != nil {
			return err
		}
	}
	_ = s.do(ctx, "reset-failed", systemdUnit)
	return s.do(ctx, "restart", systemdUnit)
}

// restart reloads the units first, so a file the manager has not read
// yet is the one restarted.
func (s *systemd) restart(ctx context.Context) error {
	_ = s.do(ctx, "daemon-reload")
	_ = s.do(ctx, "reset-failed", systemdUnit)
	return s.do(ctx, "restart", systemdUnit)
}

// unload stops the unit and disables it; the file stays for the caller
// to remove. A unit whose file is already gone cannot be disabled, but
// the manager still runs it until it is stopped.
func (s *systemd) unload(ctx context.Context) error {
	err := s.do(ctx, "disable", "--now", systemdUnit)
	if err != nil && s.do(ctx, "stop", systemdUnit) == nil {
		return nil
	}
	return err
}

// forget reloads the units once the file is gone, so the manager no
// longer lists it, and clears a failed state it may have kept.
func (s *systemd) forget(ctx context.Context) {
	_ = s.do(ctx, "daemon-reload")
	_ = s.do(ctx, "reset-failed", systemdUnit)
}

func (s *systemd) commands(load bool) []string {
	if load {
		return []string{
			"systemctl --user daemon-reload",
			"systemctl --user enable " + systemdUnit,
			"systemctl --user restart " + systemdUnit,
		}
	}
	return []string{
		"systemctl --user disable --now " + systemdUnit,
		"rm " + s.path(),
		"systemctl --user daemon-reload",
	}
}

func (s *systemd) logHint(Config) string { return "journalctl --user -u flightdeck" }

func (s *systemd) recentLog(ctx context.Context, _ Config, since time.Time) string {
	out, _, err := s.rt.Run(ctx, "journalctl", "--user", "-u", systemdUnit, "--no-pager",
		"-n", strconv.Itoa(recentLogLines), "--since", "@"+strconv.FormatInt(since.Unix(), 10))
	if err != nil {
		return ""
	}
	return string(out)
}

// homebrewLoaded reports whether the unit brew services writes on Linux
// runs or starts at login.
func (s *systemd) homebrewLoaded(ctx context.Context) bool {
	props, err := s.show(ctx, homebrewSystemdUnit)
	if err != nil {
		return false
	}
	active := props["ActiveState"]
	return props["LoadState"] == "loaded" &&
		(active == "active" || active == "activating" || active == "reloading" || props["UnitFileState"] == "enabled")
}

// notes says when a user manager runs: while its user has a session,
// unless lingering starts it at boot; on WSL, while WSL runs.
func (s *systemd) notes(ctx context.Context) []string {
	if s.rt.WSL {
		return []string{"On WSL it runs while WSL does: it starts with WSL and stops when WSL shuts down."}
	}
	out, _, err := s.rt.Run(ctx, "loginctl", "show-user", strconv.Itoa(s.rt.UID), "--property=Linger", "--value")
	if err != nil || strings.TrimSpace(string(out)) != "no" {
		return nil
	}
	return []string{
		"It runs while you are logged in. On a server nobody stays logged in to, keep it running from boot with:",
		"  sudo loginctl enable-linger " + s.user(),
	}
}
