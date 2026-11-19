package service

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// launchdLabel is the agent's label, the reverse of the project's domain
// (flightdeck-hq.com); the file is ~/Library/LaunchAgents/<label>.plist.
const launchdLabel = "com.flightdeck-hq.flightdeck"

// homebrewLaunchdLabel is the label `brew services` gives the formula's
// agent.
const homebrewLaunchdLabel = "homebrew.mxcl.flightdeck"

// launchdLogFile is the agent's log, in the data dir: launchd appends the
// binary's stdout and stderr to it.
const launchdLogFile = "flightdeck.log"

// bootstrapAttempts and bootstrapRetryDelay bound the retries of
// launchctl bootstrap right after a bootout: launchd can still be
// tearing the job down and answer "Bootstrap failed: 5: Input/output
// error" for a second or two.
const (
	bootstrapAttempts   = 10
	bootstrapRetryDelay = time.Second
)

// unloadTimeout bounds the wait for launchd to forget the agent after a
// bootout, which waits for the binary's stop.
const unloadTimeout = (stopTimeoutSecs + 15) * time.Second

// launchd is the user's launchd domain, through launchctl.
type launchd struct{ rt IO }

func (l *launchd) kind() string { return "launchd agent" }

func (l *launchd) path() string {
	return filepath.Join(l.rt.Home, "Library", "LaunchAgents", launchdLabel+".plist")
}

func (l *launchd) domain() string { return "gui/" + strconv.Itoa(l.rt.UID) }

func (l *launchd) target() string { return l.domain() + "/" + launchdLabel }

func (l *launchd) run(ctx context.Context, args ...string) ([]byte, []byte, error) {
	return l.rt.Run(ctx, "launchctl", args...)
}

// available asks for the user's login domain, which exists while the
// user is logged in to the Mac: an SSH session alone has none, and an
// agent bootstrapped elsewhere would not be the one launchd loads at the
// next login.
func (l *launchd) available(ctx context.Context) error {
	_, stderr, err := l.run(ctx, "print", l.domain())
	switch {
	case errors.Is(err, exec.ErrNotFound):
		return unsupported("this Mac has no launchctl on PATH, and flightdeck service runs a launchd agent; add /bin to PATH and run this again")
	case err != nil:
		return unsupported("there is no login session for this user (launchctl print %s: %s): a launchd agent runs in the session of "+
			"a user logged in to the Mac. Log in to its desktop and run this there; over SSH alone, run flightdeck in a terminal "+
			"multiplexer instead", l.domain(), firstLine(stderr))
	}
	return nil
}

func (l *launchd) logPath(c Config) string { return filepath.Join(c.DataDir, launchdLogFile) }

// render writes the agent's plist. Every value is XML-escaped;
// checkValues has refused the characters XML cannot carry.
func (l *launchd) render(c Config) []byte {
	var b bytes.Buffer
	esc := func(s string) string {
		var e bytes.Buffer
		_ = xml.EscapeText(&e, []byte(s))
		return e.String()
	}
	key := func(k string) { b.WriteString("\t<key>" + esc(k) + "</key>\n") }
	str := func(indent, s string) { b.WriteString(indent + "<string>" + esc(s) + "</string>\n") }
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	b.WriteString(`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">` + "\n")
	b.WriteString("<!-- " + marker + ": flightdeck service install rewrites it, and\n")
	b.WriteString("     flightdeck service remove removes it. ARCHITECTURE.md, Deployment > Running in\n")
	b.WriteString("     the background, at https://github.com/flightdeckhq/flightdeck says what each key does. -->\n")
	b.WriteString(`<plist version="1.0">` + "\n<dict>\n")
	key("Label")
	str("\t", launchdLabel)
	key("ProgramArguments")
	b.WriteString("\t<array>\n")
	for _, a := range c.Argv() {
		str("\t\t", a)
	}
	b.WriteString("\t</array>\n")
	key("RunAtLoad")
	b.WriteString("\t<true/>\n")
	key("KeepAlive")
	b.WriteString("\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>\n")
	key("ExitTimeOut")
	b.WriteString("\t<integer>" + strconv.Itoa(stopTimeoutSecs) + "</integer>\n")
	key("StandardOutPath")
	str("\t", l.logPath(c))
	key("StandardErrorPath")
	str("\t", l.logPath(c))
	b.WriteString("</dict>\n</plist>\n")
	return b.Bytes()
}

// argv reads ProgramArguments back from the plist.
func (l *launchd) argv(content []byte) ([]string, error) {
	dec := xml.NewDecoder(bytes.NewReader(content))
	dec.Strict = true
	depth := 0
	lastKey := ""
	var args []string
	inArgs := false
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("the plist does not parse: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			depth++
			switch {
			case t.Name.Local == "key" && depth == 3:
				var k string
				if err := dec.DecodeElement(&k, &t); err != nil {
					return nil, fmt.Errorf("the plist does not parse: %w", err)
				}
				depth--
				lastKey = k
			case t.Name.Local == "array" && depth == 3 && lastKey == "ProgramArguments":
				inArgs = true
			case t.Name.Local == "string" && inArgs && depth == 4:
				var s string
				if err := dec.DecodeElement(&s, &t); err != nil {
					return nil, fmt.Errorf("the plist does not parse: %w", err)
				}
				depth--
				args = append(args, s)
			}
		case xml.EndElement:
			if t.Name.Local == "array" && inArgs && depth == 3 {
				return args, nil
			}
			depth--
		}
	}
	return nil, errors.New("the plist has no ProgramArguments")
}

// state reads `launchctl print` of the agent: a service launchd does not
// know is an error there. The lines read are the agent's own, one tab in;
// deeper ones belong to its sub-sections.
func (l *launchd) state(ctx context.Context) (state, error) {
	out, _, err := l.run(ctx, "print", l.target())
	if exited(err) {
		// launchctl print exits non-zero (113) for a service the domain
		// does not have.
		return state{detail: "not loaded", enabled: l.enabled(ctx)}, nil
	}
	if err != nil {
		return state{}, commandError("launchctl", []string{"print", l.target()}, nil, err)
	}
	props := map[string]string{}
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.HasPrefix(line, "\t") || strings.HasPrefix(line, "\t\t") {
			continue
		}
		if k, v, ok := strings.Cut(strings.TrimSpace(line), " = "); ok {
			if _, seen := props[k]; !seen {
				props[k] = v
			}
		}
	}
	pid, _ := strconv.Atoi(props["pid"])
	running := props["state"] == "running" && pid > 0
	exit := props["last exit code"]
	// Failed is an exit with a status of its own: a process ended by a
	// signal (kickstart -k, a kill launchd is about to answer with a new
	// start) is not a binary that refused to run.
	code, numeric := strconv.Atoi(exit)
	return state{
		loaded:  true,
		running: running,
		pid:     pid,
		enabled: l.enabled(ctx),
		failed:  !running && numeric == nil && code != 0 && props["last terminating signal"] == "",
		detail:  strings.TrimSpace(props["state"] + ", last exit code " + exit),
	}, nil
}

// enabled reports whether launchd loads the agent at login: its plist is
// in LaunchAgents and the domain does not list it as disabled
// (`launchctl print-disabled` writes `"<label>" => disabled`, or `=> true`
// on older systems).
func (l *launchd) enabled(ctx context.Context) bool {
	if _, err := os.Stat(l.path()); err != nil {
		return false
	}
	out, _, err := l.run(ctx, "print-disabled", l.domain())
	if err != nil {
		return true
	}
	for _, line := range strings.Split(string(out), "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(line), "=>"); ok && strings.Trim(strings.TrimSpace(k), `"`) == launchdLabel {
			v = strings.TrimSpace(v)
			return v != "disabled" && v != "true"
		}
	}
	return true
}

func (l *launchd) do(ctx context.Context, args ...string) error {
	if _, stderr, err := l.run(ctx, args...); err != nil {
		return commandError("launchctl", args, stderr, err)
	}
	return nil
}

// load boots out an agent already loaded (launchd reads a plist only when
// it is bootstrapped), enables the label, which a `launchctl disable`
// would otherwise keep from loading, and bootstraps the file, which
// starts it (RunAtLoad).
func (l *launchd) load(ctx context.Context) error {
	if err := l.unload(ctx); err != nil {
		return err
	}
	if err := l.do(ctx, "enable", l.target()); err != nil {
		return err
	}
	var err error
	for attempt := 1; attempt <= bootstrapAttempts; attempt++ {
		if err = l.do(ctx, "bootstrap", l.domain(), l.path()); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(bootstrapRetryDelay):
		}
	}
	return err
}

// restart kills the running process and starts it again (kickstart -k).
func (l *launchd) restart(ctx context.Context) error {
	st, err := l.state(ctx)
	if err != nil {
		return err
	}
	if !st.loaded {
		return l.load(ctx)
	}
	return l.do(ctx, "kickstart", "-k", l.target())
}

// unload boots the agent out, which stops its process, and waits until
// launchd no longer knows it.
func (l *launchd) unload(ctx context.Context) error {
	st, err := l.state(ctx)
	if err != nil || !st.loaded {
		return err
	}
	if err := l.do(ctx, "bootout", l.target()); err != nil {
		// A job already on its way out answers with an error too; the
		// wait below decides.
		if again, serr := l.state(ctx); serr == nil && !again.loaded {
			return nil
		}
	}
	deadline := time.Now().Add(unloadTimeout)
	for time.Now().Before(deadline) {
		if st, err := l.state(ctx); err == nil && !st.loaded {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(l.rt.PollInterval):
		}
	}
	return fmt.Errorf("launchd still lists %s %s after bootout", launchdLabel, unloadTimeout)
}

func (l *launchd) forget(context.Context) {}

// leftover: launchd keeps nothing of a booted-out agent but the enable
// state of its label, which loads nothing without a plist.
func (l *launchd) leftover() string { return "" }

// ours: the plist's first comment, after the XML declaration and the
// doctype, is the marker's.
func (l *launchd) ours(content []byte) bool {
	rest := content
	for _, prefix := range []string{"<?xml", "<!DOCTYPE"} {
		if bytes.HasPrefix(rest, []byte(prefix)) {
			if i := bytes.IndexByte(rest, '\n'); i >= 0 {
				rest = rest[i+1:]
			}
		}
	}
	return bytes.HasPrefix(rest, []byte("<!-- "+marker))
}

func (l *launchd) commands(load bool) []string {
	if load {
		return []string{
			"launchctl bootout " + l.target() + "   (when it is loaded)",
			"launchctl enable " + l.target(),
			"launchctl bootstrap " + l.domain() + " " + l.path(),
		}
	}
	return []string{
		"launchctl bootout " + l.target(),
		"rm " + l.path(),
	}
}

func (l *launchd) logHint(c Config) string { return l.logPath(c) }

// recentLog returns the last lines of the log file. since is not used:
// the file holds every start, and its end is the latest.
func (l *launchd) recentLog(_ context.Context, c Config, _ time.Time) string {
	f, err := os.Open(l.logPath(c))
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	if info, err := f.Stat(); err == nil && info.Size() > maxLogTailBytes {
		_, _ = f.Seek(-maxLogTailBytes, io.SeekEnd)
	}
	data, _ := io.ReadAll(io.LimitReader(f, maxLogTailBytes))
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	return strings.Join(lines[max(0, len(lines)-recentLogLines):], "\n")
}

func (l *launchd) homebrewLoaded(ctx context.Context) bool {
	_, _, err := l.run(ctx, "print", l.domain()+"/"+homebrewLaunchdLabel)
	return err == nil
}

// notes has nothing to add on macOS: an agent runs while its user is
// logged in, which install says.
func (l *launchd) notes(context.Context) []string { return nil }
