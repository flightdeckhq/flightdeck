package service

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/internal/cli"
	"github.com/flightdeckhq/flightdeck/internal/datadir"
)

// Main runs `flightdeck service` with args (the words after "service")
// and returns the exit status.
func Main(ctx context.Context, args []string, rt IO) int {
	if len(args) == 0 {
		usage(rt.Stderr)
		return ExitUsage
	}
	switch args[0] {
	case "install":
		return install(ctx, rt, args[1:])
	case "status":
		return status(ctx, rt, args[1:])
	case "restart":
		return restart(ctx, rt, args[1:])
	case "remove":
		return remove(ctx, rt, args[1:])
	case "-h", "-help", "--help", "help":
		usage(rt.Stdout)
		return ExitOK
	}
	_, _ = fmt.Fprintf(rt.Stderr, "flightdeck service: no command %q; the commands are install, status, restart and remove\n", args[0])
	usage(rt.Stderr)
	return ExitUsage
}

func usage(w io.Writer) {
	_, _ = fmt.Fprint(w, `Usage: flightdeck service install [flags]   start Flightdeck now and at every login, and again if it stops
       flightdeck service status              whether it runs and answers
       flightdeck service restart             restart it
       flightdeck service remove              stop it and stop starting it at login

install writes a service of this system's own manager, for your user, with no sudo:
  Linux   a systemd user unit, ~/.config/systemd/user/flightdeck.service; its log is in the
          journal: journalctl --user -u flightdeck
  macOS   a launchd agent, ~/Library/LaunchAgents/`+launchdLabel+`.plist; its log is
          flightdeck.log in the data dir
It runs this flightdeck with the server flags given to install (flightdeck service install --help
lists them): --port, --public, --listen, --data-dir, --allowed-hosts, --metrics, each read as
flightdeck reads it, a flag or else its FLIGHTDECK_ variable in this shell. A Postgres URL goes in a
file only you can read, given with --database-url-file, never on a command line. Run install again
to change the flags or to run a new binary: it rewrites the service and restarts it. remove leaves
the data dir as it is. On a Homebrew install, brew services start flightdeck runs the formula's own
service; install --no-brew writes this one instead.

Exit status: 0 done (status: it runs and answers); 1 a step failed (status: installed, and not
running or not answering); 2 a usage error; 3 not installed; 4 this system or this install cannot
run it, nothing was written, and the message says what to use instead.
`)
}

// fail prints a line for command and returns status.
func fail(rt IO, command string, status int, format string, a ...any) int {
	_, _ = fmt.Fprintf(rt.Stderr, "flightdeck service "+command+": "+format+"\n", a...)
	return status
}

// noFlags parses the arguments of a command that takes none but -h.
func noFlags(rt IO, command string, args []string, extra func(*flag.FlagSet)) (int, bool) {
	fs := flag.NewFlagSet("flightdeck service "+command, flag.ContinueOnError)
	fs.SetOutput(rt.Stderr)
	if extra != nil {
		extra(fs)
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK, false
		}
		return ExitUsage, false
	}
	if fs.NArg() > 0 {
		return fail(rt, command, ExitUsage, "unexpected argument %q", fs.Arg(0)), false
	}
	return 0, true
}

// managerHere returns the manager of this system once it answers, or
// the exit status of a refusal already printed.
func managerHere(ctx context.Context, rt IO, command string) (manager, int, bool) {
	m, err := managerFor(rt)
	if err == nil {
		err = m.available(ctx)
	}
	var unsup *unsupportedError
	switch {
	case errors.As(err, &unsup):
		return nil, fail(rt, command, ExitUnsupported, "%s", unsup.msg), false
	case err != nil:
		return nil, fail(rt, command, ExitFailed, "%v", err), false
	}
	return m, 0, true
}

// ---- install ----------------------------------------------------------

func install(ctx context.Context, rt IO, args []string) int {
	var dryRun, noBrew bool
	opts, err := cli.ParseCommand(args, rt.Getenv, rt.Stderr, cli.Command{
		Name: "flightdeck service install",
		Flags: func(fs *flag.FlagSet) {
			fs.BoolVar(&dryRun, "dry-run", false, "print the file install would write and the commands it would run, and change nothing")
			fs.BoolVar(&noBrew, "no-brew", false, "on a Homebrew install, write this service instead of using the formula's own (brew services)")
		},
		Usage: installUsage,
	})
	if errors.Is(err, cli.ErrHelp) {
		return ExitOK
	}
	if err != nil {
		return fail(rt, "install", ExitUsage, "%v", err)
	}
	if rt.EUID == 0 {
		return fail(rt, "install", ExitUsage, "it runs as your own user, not as root: a service root installs for itself runs as root, "+
			"with root's home and data dir. Run it without sudo, as the user whose agents report to Flightdeck")
	}
	switch {
	case opts.Domain != "":
		return fail(rt, "install", ExitUsage, "--domain (FLIGHTDECK_DOMAIN) serves ports 443 and 80, which a service of your user may not bind; "+
			"run flightdeck --domain under a system service manager or in Docker, or give the service --public --port <port> behind a proxy")
	case opts.NatsURL != "":
		return fail(rt, "install", ExitUsage, "--nats-url (FLIGHTDECK_NATS_URL) is not carried into the service, since its URL can hold a token; "+
			"the service runs the embedded bus. Leave it out (unset FLIGHTDECK_NATS_URL) to install it")
	case opts.DatabaseURL != "" && opts.DatabaseURLFile == "":
		return fail(rt, "install", ExitUsage, "the database URL is never written into the service or on its command line, since it can hold a password: "+
			"put it in a file only you can read (chmod 600) and give that with --database-url-file <file> instead of --database-url "+
			"(unset FLIGHTDECK_DATABASE_URL in this shell)")
	}
	m, status, ok := managerHere(ctx, rt, "install")
	if !ok {
		return status
	}
	c, brew, status, ok := configFor(rt, opts)
	if !ok {
		return status
	}
	if brew && !noBrew {
		return fail(rt, "install", ExitUnsupported, "this flightdeck was installed with Homebrew, whose own service runs it: "+
			"brew services start flightdeck. That service takes no flags; for a port, a data dir or a Postgres of your own, "+
			"run flightdeck service install --no-brew with them instead. Nothing was written")
	}
	if m.homebrewLoaded(ctx) {
		return fail(rt, "install", ExitUnsupported, "Homebrew's flightdeck service is loaded (brew services list), and one flightdeck runs "+
			"per data dir: stop it first with brew services stop flightdeck. Nothing was written")
	}
	return installWith(ctx, rt, m, c, dryRun)
}

func installUsage(w io.Writer) {
	_, _ = fmt.Fprint(w, `Usage: flightdeck service install [flags]

Writes the service that runs this flightdeck in the background with the flags given here, starts it,
and waits for it to answer. The server's flags below (all but --database-url, --domain and
--nats-url) are read as flightdeck reads them: a flag, else its FLIGHTDECK_ variable in this shell.
Run it again to change them; flightdeck service --help has the rest.

Flags:
`)
}

// configFor turns the parsed flags into what the service runs, and
// finds the binary. brew is true for a Homebrew install.
func configFor(rt IO, opts cli.Options) (c Config, brew bool, status int, ok bool) {
	dataDir, err := filepath.Abs(opts.DataDir)
	if err != nil {
		return Config{}, false, fail(rt, "install", ExitUsage, "data dir %q: %v", opts.DataDir, err), false
	}
	c = Config{Listen: opts.Listen, DataDir: dataDir, AllowedHosts: opts.AllowedHosts, Metrics: opts.Metrics}
	if opts.DatabaseURLFile != "" {
		if c.DatabaseURLFile, err = filepath.Abs(opts.DatabaseURLFile); err != nil {
			return Config{}, false, fail(rt, "install", ExitUsage, "--database-url-file %q: %v", opts.DatabaseURLFile, err), false
		}
		if info, err := os.Stat(c.DatabaseURLFile); err == nil && info.Mode().Perm()&0o077 != 0 {
			_, _ = fmt.Fprintf(rt.Stderr, "warning: %s can be read by other users (mode %04o) and holds the database URL: chmod 600 %s\n",
				c.DatabaseURLFile, info.Mode().Perm(), c.DatabaseURLFile)
		}
	}
	var refusal string
	c.Binary, brew, refusal, err = binaryPath(rt)
	switch {
	case err != nil:
		return Config{}, false, fail(rt, "install", ExitFailed, "the path of this flightdeck: %v", err), false
	case refusal != "":
		return Config{}, false, fail(rt, "install", ExitUnsupported, "%s", refusal), false
	}
	if err := checkValues(c.Argv()); err != nil {
		return Config{}, false, fail(rt, "install", ExitUsage, "%v", err), false
	}
	return c, brew, 0, true
}

// homebrewCellar is the part of a Homebrew install's path that names the
// formula's versions: <prefix>/Cellar/flightdeck/<version>/bin/flightdeck.
const homebrewCellar = "/Cellar/flightdeck/"

// ephemeralCache names the cache exe runs from when it is one that can
// be cleaned at any time, "" otherwise: uv's (uvx and uv run unpack
// wheels into <cache>/archive-v<n> and build environments in
// <cache>/environments-v<n>, wherever UV_CACHE_DIR puts the cache), that
// of pipx run (<PIPX_HOME>/.cache), and go run's builds (a go-build
// directory, under GOTMPDIR when it is set).
func ephemeralCache(rt IO, exe string) string {
	for _, part := range strings.Split(filepath.ToSlash(exe), "/") {
		switch {
		case uvBucket(part):
			return "uv's cache (uvx)"
		case strings.HasPrefix(part, "go-build"):
			return "a go run build"
		}
	}
	uvCaches := []string{filepath.Join(rt.Home, ".cache", "uv"), filepath.Join(rt.Home, "Library", "Caches", "uv")}
	for _, v := range []string{"UV_CACHE_DIR", "XDG_CACHE_HOME"} {
		if dir := rt.Getenv(v); dir != "" {
			if v == "XDG_CACHE_HOME" {
				dir = filepath.Join(dir, "uv")
			}
			uvCaches = append(uvCaches, dir)
		}
	}
	for _, dir := range uvCaches {
		if within(exe, resolved(dir)) {
			return "uv's cache (uvx)"
		}
	}
	pipxCaches := []string{filepath.Join(rt.Home, ".local", "pipx", ".cache"), filepath.Join(rt.Home, ".local", "share", "pipx", ".cache"),
		filepath.Join(rt.Home, ".local", "state", "pipx", ".cache"), filepath.Join(rt.Home, "Library", "Application Support", "pipx", ".cache")}
	if home := rt.Getenv("PIPX_HOME"); home != "" {
		pipxCaches = append(pipxCaches, filepath.Join(home, ".cache"))
	}
	for _, dir := range pipxCaches {
		if within(exe, resolved(dir)) {
			return "the cache of pipx run"
		}
	}
	return ""
}

// uvBucket reports whether a path component is one of uv's cache buckets
// that hold what uvx runs: archive-v<n> (unpacked wheels) and
// environments-v<n> (the environments built from them).
func uvBucket(part string) bool {
	for _, bucket := range []string{"archive-v", "environments-v"} {
		if v, ok := strings.CutPrefix(part, bucket); ok && v != "" && strings.Trim(v, "0123456789") == "" {
			return true
		}
	}
	return false
}

// binaryPath is the absolute path the service runs: the running binary,
// symbolic links resolved, or on a Homebrew install the path Homebrew
// keeps across upgrades (<prefix>/opt/flightdeck/bin/flightdeck). A
// binary that may be gone at the next login (a temporary directory, a
// cache) is refused with the reason.
func binaryPath(rt IO) (path string, brew bool, refusal string, err error) {
	exe, err := rt.Executable()
	if err != nil {
		return "", false, "", err
	}
	if exe, err = filepath.Abs(exe); err != nil {
		return "", false, "", err
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	if i := strings.Index(exe, homebrewCellar); i >= 0 {
		opt := filepath.Join(exe[:i], "opt", "flightdeck", "bin", "flightdeck")
		if _, err := os.Stat(opt); err == nil {
			return opt, true, "", nil
		}
		return exe, true, "", nil
	}
	if cache := ephemeralCache(rt, exe); cache != "" {
		return "", false, fmt.Sprintf("this flightdeck runs from %s (%s), which may be cleaned before the next login; "+
			"install it first (the install command, brew or pip install flightdeck-cli), then run flightdeck service install "+
			"with that flightdeck. Nothing was written", cache, exe), nil
	}
	if tmp := resolved(rt.TempDir); tmp != "" && within(exe, tmp) {
		return "", false, fmt.Sprintf("this flightdeck runs from the temporary directory %s, which may be emptied before the next login; "+
			"put it somewhere it stays, then run flightdeck service install with it. Nothing was written", filepath.Dir(exe)), nil
	}
	return exe, false, "", nil
}

func resolved(dir string) string {
	if dir == "" {
		return ""
	}
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		return real
	}
	return filepath.Clean(dir)
}

// within reports whether path is dir or under it.
func within(path, dir string) bool {
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// installWith checks what is there, writes the file, loads it and waits
// for the service; a service that does not come up is rolled back.
func installWith(ctx context.Context, rt IO, m manager, c Config, dryRun bool) int {
	previous, existed, err := readFile(m.path())
	if err != nil {
		return fail(rt, "install", ExitFailed, "%v", err)
	}
	if existed && !m.ours(previous) {
		return fail(rt, "install", ExitFailed, "%s exists and was not written by flightdeck service install, so it is left as it is: "+
			"remove or rename it, then run this again. Nothing was written", m.path())
	}
	st, err := m.state(ctx)
	if err != nil {
		return fail(rt, "install", ExitFailed, "%v", err)
	}
	var running Config
	if existed && st.running {
		if argv, err := m.argv(previous); err == nil {
			running, _ = configOf(argv)
		}
	}
	if pid, held, err := datadir.Holder(lockPath(c)); err != nil {
		return fail(rt, "install", ExitFailed, "the data dir's lock: %v", err)
	} else if held && (!st.running || pid != st.pid) {
		who := "another flightdeck"
		if pid > 0 {
			who += fmt.Sprintf(" (pid %d)", pid)
		}
		return fail(rt, "install", ExitFailed, "%s runs on the data dir %s, and one flightdeck runs per data dir: stop it (Ctrl+C in its "+
			"terminal), then run flightdeck service install again. Nothing was written", who, c.DataDir)
	}
	if !st.running || running.Listen != c.Listen {
		if err := portFree(c.Listen); err != nil {
			return fail(rt, "install", ExitFailed, "%s is in use by another program (%v), so the service could not listen there: "+
				"stop it, or give install another --port. Nothing was written", c.Listen, err)
		}
	}
	content := m.render(c)
	if dryRun {
		describe(rt, m, c, content, existed)
		return ExitOK
	}
	if _, ok := m.(*launchd); ok {
		// launchd opens the log file in the data dir before it starts the
		// binary, which would otherwise create the directory itself.
		if err := os.MkdirAll(c.DataDir, 0o700); err != nil {
			return fail(rt, "install", ExitFailed, "create the data dir %s: %v", c.DataDir, err)
		}
	}
	since := time.Now()
	if err := writeFile(m.path(), content); err != nil {
		return fail(rt, "install", ExitFailed, "%v", err)
	}
	err = m.load(ctx)
	var pid int
	if err == nil {
		pid, err = waitReady(ctx, rt, m, c)
	}
	if err != nil {
		// An interrupt (Ctrl+C, SIGTERM) cancels ctx, and the manager's
		// commands of the rollback must still run: they get a context of
		// their own, bounded.
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
		defer cancel()
		if ctx.Err() != nil {
			_, _ = fmt.Fprintln(rt.Stderr, "flightdeck service install: interrupted before the service answered; putting back what was there")
		} else {
			_, _ = fmt.Fprintf(rt.Stderr, "flightdeck service install: the service did not come up: %v\n", err)
		}
		showLog(cleanup, rt, m, c, since)
		rollback(cleanup, rt, m, previous, existed)
		return ExitFailed
	}
	verb := "is installed"
	if existed {
		verb = "is updated"
	}
	w := rt.Stdout
	_, _ = fmt.Fprintf(w, "The Flightdeck service %s and runs: %s (pid %d).\n", verb, DashboardURL(c.Listen), pid)
	_, _ = fmt.Fprintf(w, "It starts at every login, and again if it stops. The service is %s.\n", homeRelative(rt, m.path()))
	hint := func(what, does string) { _, _ = fmt.Fprintf(w, "  %-32s %s\n", what, does) }
	hint("flightdeck service status", "whether it runs and answers")
	hint(m.logHint(c), "its log")
	hint("flightdeck service remove", "stops and removes it; the data in "+c.DataDir+" stays")
	for _, note := range m.notes(ctx) {
		_, _ = fmt.Fprintln(rt.Stdout, note)
	}
	if rt.AgentNotes != nil && loopback(c.Listen) {
		for _, line := range rt.AgentNotes(ctx, c.Listen) {
			_, _ = fmt.Fprintln(rt.Stdout, line)
		}
	}
	return ExitOK
}

// describe is --dry-run: the file, its content and the commands.
func describe(rt IO, m manager, c Config, content []byte, existed bool) {
	w := rt.Stdout
	verb := "Write"
	if existed {
		verb = "Rewrite"
	}
	_, _ = fmt.Fprintf(w, "%s the %s %s:\n\n%s\n", verb, m.kind(), m.path(), content)
	_, _ = fmt.Fprintln(w, "Then run:")
	for _, cmd := range m.commands(true) {
		_, _ = fmt.Fprintf(w, "  %s\n", cmd)
	}
	_, _ = fmt.Fprintf(w, "and wait for %s to answer. Nothing was changed.\n", DashboardURL(c.Listen))
}

// cleanupTimeout bounds a rollback, which runs on a context of its own
// so that an interrupted install still puts things back: an unload that
// waits for the binary's stop and a load after it, two manager commands'
// worth.
const cleanupTimeout = 2 * managerTimeout

// rollback puts back what install replaced, the earlier file loaded and
// started again or no service at all, and says what is there afterwards
// as the manager reports it, with the one command that clears what is
// left when it could not.
func rollback(ctx context.Context, rt IO, m manager, previous []byte, existed bool) {
	if existed {
		err := writeFile(m.path(), previous)
		if err == nil {
			err = m.load(ctx)
		}
		if err != nil {
			_, _ = fmt.Fprintf(rt.Stderr, "The earlier service could not be put back (%v); %s may hold either version. "+
				"Run flightdeck service install with the flags you want, or flightdeck service remove.\n", err, m.path())
			return
		}
		if st, err := m.state(ctx); err == nil && st.running {
			_, _ = fmt.Fprintf(rt.Stderr, "The service is back as it was before this install (%s, pid %d).\n", m.path(), st.pid)
			return
		}
		_, _ = fmt.Fprintf(rt.Stderr, "The earlier service is written back and started (%s); flightdeck service status shows whether it runs.\n", m.path())
		return
	}
	var problems []string
	if err := m.unload(ctx); err != nil {
		problems = append(problems, err.Error())
	}
	if err := os.Remove(m.path()); err != nil && !errors.Is(err, os.ErrNotExist) {
		problems = append(problems, err.Error())
	}
	m.forget(ctx)
	if st, err := m.state(ctx); err != nil {
		problems = append(problems, err.Error())
	} else if st.loaded || st.running {
		problems = append(problems, fmt.Sprintf("the %s still knows the service (%s)", m.kind(), describeState(st)))
	}
	if left := m.leftover(); left != "" {
		problems = append(problems, left+" is still there")
	}
	if len(problems) > 0 {
		_, _ = fmt.Fprintf(rt.Stderr, "The service could not be removed again: %s. flightdeck service remove removes what is left.\n",
			strings.Join(problems, "; "))
		return
	}
	_, _ = fmt.Fprintln(rt.Stderr, "Nothing is installed: the service was removed again. Fix what the log says, then run flightdeck service install again.")
}

// showLog prints the last lines of the service's log since since.
func showLog(ctx context.Context, rt IO, m manager, c Config, since time.Time) {
	if lines := strings.TrimSpace(m.recentLog(ctx, c, since)); lines != "" {
		_, _ = fmt.Fprintf(rt.Stderr, "Its log (%s):\n%s\n", m.logHint(c), lines)
		return
	}
	_, _ = fmt.Fprintf(rt.Stderr, "Its log: %s\n", m.logHint(c))
}

// portFree reports whether addr can be listened on now.
func portFree(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	return ln.Close()
}

func loopback(listen string) bool {
	host, _, err := net.SplitHostPort(listen)
	ip := net.ParseIP(host)
	return err == nil && ip != nil && ip.IsLoopback()
}

// waitReady waits until the service answers from the process the manager
// started: its health routes answer, and the data dir's lock file names
// the manager's PID, so another flightdeck on the port does not pass for
// it. A service the manager reports exited fails at once.
func waitReady(ctx context.Context, rt IO, m manager, c Config) (int, error) {
	deadline := time.Now().Add(rt.ReadyTimeout)
	// Why the latest look found it not up: every pass sets it.
	var last error
	for {
		st, err := m.state(ctx)
		switch {
		case err != nil:
			last = err
		case st.failed:
			return 0, fmt.Errorf("it exited (%s)", st.detail)
		case st.running && st.pid > 0:
			if _, err := rt.Answers(ctx, c.Listen); err != nil {
				last = err
			} else if holder := datadir.LockPID(lockPath(c)); holder != st.pid {
				last = fmt.Errorf("%s answers, but the data dir is held by pid %d, not by the service's pid %d", c.Listen, holder, st.pid)
			} else {
				return st.pid, nil
			}
		default:
			last = fmt.Errorf("it is not running (%s)", st.detail)
		}
		if !time.Now().Before(deadline) {
			return 0, fmt.Errorf("no answer within %s: %v", rt.ReadyTimeout, last)
		}
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(rt.PollInterval):
		}
	}
}

// installed reads the service file of m: ok is false, with the exit
// status printed, when there is none or it is not ours.
func installed(rt IO, m manager, command string) (content []byte, status int, ok bool) {
	content, exists, err := readFile(m.path())
	switch {
	case err != nil:
		return nil, fail(rt, command, ExitFailed, "%v", err), false
	case !exists:
		return nil, fail(rt, command, ExitNotInstalled, "the Flightdeck service is not installed (%s is not there): "+
			"flightdeck service install installs it", m.path()), false
	case !m.ours(content):
		return nil, fail(rt, command, ExitFailed, "%s was not written by flightdeck service install; it is not this command's to change", m.path()), false
	}
	return content, 0, true
}

// ---- status -----------------------------------------------------------

func status(ctx context.Context, rt IO, args []string) int {
	if code, ok := noFlags(rt, "status", args, nil); !ok {
		return code
	}
	m, code, ok := managerHere(ctx, rt, "status")
	if !ok {
		return code
	}
	content, exists, err := readFile(m.path())
	if err != nil {
		return fail(rt, "status", ExitFailed, "%v", err)
	}
	w := rt.Stdout
	if !exists {
		// The file can be gone while the manager still runs what it read
		// from it (deleted by hand): that is not "not installed".
		if st, err := m.state(ctx); err == nil && (st.running || st.enabled) {
			_, _ = fmt.Fprintf(w, "The Flightdeck service's file %s is gone, but the %s still has it (%s): flightdeck service remove stops and removes it.\n",
				m.path(), m.kind(), describeState(st))
			return ExitFailed
		}
		_, _ = fmt.Fprintf(w, "The Flightdeck service is not installed: flightdeck service install installs it.\n")
		if m.homebrewLoaded(ctx) {
			_, _ = fmt.Fprintf(w, "Homebrew's flightdeck service is loaded: brew services list shows it.\n")
		}
		return ExitNotInstalled
	}
	if !m.ours(content) {
		return fail(rt, "status", ExitFailed, "%s was not written by flightdeck service install", m.path())
	}
	_, _ = fmt.Fprintf(w, "Flightdeck service: the %s %s\n", m.kind(), homeRelative(rt, m.path()))
	line := func(label, format string, a ...any) {
		_, _ = fmt.Fprintf(w, "  %-10s "+format+"\n", append([]any{label}, a...)...)
	}
	st, err := m.state(ctx)
	if err != nil {
		line("state", "unknown: %v", err)
	} else {
		line("state", "%s", describeState(st))
	}
	argv, perr := m.argv(content)
	var c Config
	if perr == nil {
		line("command", "%s", shellQuote(argv))
		c, perr = configOf(argv)
	}
	if perr != nil {
		line("command", "unreadable (%v); flightdeck service install rewrites it", perr)
		return ExitFailed
	}
	// The health line is about this service's process: an answer on its
	// port from anything else is said to be that.
	healthy := false
	_, port, _ := net.SplitHostPort(c.Listen)
	answered, aerr := rt.Answers(ctx, c.Listen)
	switch {
	case (err != nil || !st.running) && aerr == nil:
		line("health", "the service is not running; something else answers on port %s (%s)", port, answered)
	case err != nil || !st.running:
		line("health", "the service is not running, and nothing answers on port %s", port)
	case aerr != nil:
		line("health", "unhealthy: %v", aerr)
	case datadir.LockPID(lockPath(c)) != st.pid:
		line("health", "%s answers, but not from the service's process (pid %d): another flightdeck holds its data dir", answered, st.pid)
	default:
		line("health", "healthy: %s answers /api/health and /ingest/health", answered)
		healthy = true
	}
	line("dashboard", "%s", DashboardURL(c.Listen))
	line("data dir", "%s", c.DataDir)
	line("log", "%s", m.logHint(c))
	for _, note := range m.notes(ctx) {
		_, _ = fmt.Fprintln(w, note)
	}
	if healthy {
		return ExitOK
	}
	return ExitFailed
}

func describeState(st state) string {
	var s string
	switch {
	case st.running:
		s = fmt.Sprintf("running, pid %d", st.pid)
	case st.failed:
		s = "failed: it exited and is started again (" + st.detail + ")"
	case st.loaded:
		s = "not running (" + st.detail + ")"
	default:
		s = "not loaded by the service manager"
	}
	if st.enabled {
		return s + "; starts at login"
	}
	return s + "; does not start at login"
}

// ---- restart ----------------------------------------------------------

func restart(ctx context.Context, rt IO, args []string) int {
	if code, ok := noFlags(rt, "restart", args, nil); !ok {
		return code
	}
	m, code, ok := managerHere(ctx, rt, "restart")
	if !ok {
		return code
	}
	content, code, ok := installed(rt, m, "restart")
	if !ok {
		return code
	}
	argv, err := m.argv(content)
	var c Config
	if err == nil {
		c, err = configOf(argv)
	}
	if err != nil {
		return fail(rt, "restart", ExitFailed, "%v; flightdeck service install rewrites it", err)
	}
	since := time.Now()
	if err := m.restart(ctx); err != nil {
		return fail(rt, "restart", ExitFailed, "%v", err)
	}
	pid, err := waitReady(ctx, rt, m, c)
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
		defer cancel()
		if ctx.Err() != nil {
			_, _ = fmt.Fprintln(rt.Stderr, "flightdeck service restart: interrupted before the service answered; the manager keeps "+
				"starting it, and flightdeck service status shows whether it runs")
		} else {
			_, _ = fmt.Fprintf(rt.Stderr, "flightdeck service restart: the service did not come up: %v\n", err)
		}
		showLog(cleanup, rt, m, c, since)
		return ExitFailed
	}
	_, _ = fmt.Fprintf(rt.Stdout, "The Flightdeck service restarted and runs: %s (pid %d).\n", DashboardURL(c.Listen), pid)
	return ExitOK
}

// ---- remove -----------------------------------------------------------

func remove(ctx context.Context, rt IO, args []string) int {
	var dryRun bool
	if code, ok := noFlags(rt, "remove", args, func(fs *flag.FlagSet) {
		fs.BoolVar(&dryRun, "dry-run", false, "print what remove would do, and change nothing")
	}); !ok {
		return code
	}
	m, code, ok := managerHere(ctx, rt, "remove")
	if !ok {
		return code
	}
	content, exists, err := readFile(m.path())
	if err != nil {
		return fail(rt, "remove", ExitFailed, "%v", err)
	}
	if exists && !m.ours(content) {
		return fail(rt, "remove", ExitFailed, "%s was not written by flightdeck service install, so it is left as it is. Nothing changed", m.path())
	}
	st, err := m.state(ctx)
	if err != nil {
		return fail(rt, "remove", ExitFailed, "%v", err)
	}
	if !exists && !st.loaded && !st.running && m.leftover() == "" {
		_, _ = fmt.Fprintln(rt.Stdout, "The Flightdeck service is not installed; nothing changed.")
		return ExitOK
	}
	dataDir := ""
	if argv, err := m.argv(content); exists && err == nil {
		if c, err := configOf(argv); err == nil {
			dataDir = c.DataDir
		}
	}
	if dryRun {
		_, _ = fmt.Fprintf(rt.Stdout, "Remove the %s %s:\n", m.kind(), m.path())
		for _, cmd := range m.commands(false) {
			_, _ = fmt.Fprintf(rt.Stdout, "  %s\n", cmd)
		}
		_, _ = fmt.Fprintln(rt.Stdout, "The data dir is left as it is. Nothing was changed.")
		return ExitOK
	}
	if exists || st.loaded || st.running {
		if err := m.unload(ctx); err != nil {
			return fail(rt, "remove", ExitFailed, "%v", err)
		}
	}
	if err := os.Remove(m.path()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fail(rt, "remove", ExitFailed, "the service is stopped, but %s could not be removed: %v", m.path(), err)
	}
	m.forget(ctx)
	if after, err := m.state(ctx); err == nil && after.running {
		return fail(rt, "remove", ExitFailed, "the %s still runs the service (pid %d) after it was unloaded", m.kind(), after.pid)
	}
	if left := m.leftover(); left != "" {
		return fail(rt, "remove", ExitFailed, "the service is stopped and its file removed, but %s could not be removed", left)
	}
	_, _ = fmt.Fprintf(rt.Stdout, "The Flightdeck service is stopped and removed (%s).\n", homeRelative(rt, m.path()))
	if dataDir != "" {
		_, _ = fmt.Fprintf(rt.Stdout, "Its data dir, %s, is as it was: flightdeck uses it again when started on it.\n", dataDir)
	}
	return ExitOK
}

// ---- the server's question ------------------------------------------

// Running reports the settings of the installed service and its PID when
// the service's process runs; ok is false when there is no service of
// this command's, it does not run, or the manager does not answer within
// ctx. The binary asks it when its port or its data dir is taken, to say
// that the service holds it.
func Running(ctx context.Context, rt IO) (c Config, pid int, ok bool) {
	m, err := managerFor(rt)
	if err != nil {
		return Config{}, 0, false
	}
	content, exists, err := readFile(m.path())
	if err != nil || !exists || !m.ours(content) {
		return Config{}, 0, false
	}
	argv, err := m.argv(content)
	if err != nil {
		return Config{}, 0, false
	}
	if c, err = configOf(argv); err != nil {
		return Config{}, 0, false
	}
	st, err := m.state(ctx)
	if err != nil || !st.running || st.pid <= 0 {
		return Config{}, 0, false
	}
	return c, st.pid, true
}
