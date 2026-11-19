// Package service runs the flightdeck binary in the background as a
// per-user service of the system's own service manager: `flightdeck
// service`. On Linux it writes a systemd user unit, on macOS a launchd
// agent; each starts the binary at login and again when it dies, runs as
// the user who installed it and needs no root. The CLI writes the file
// and asks the manager to load it; the server never writes it.
// ARCHITECTURE.md (Deployment > Running in the background) is the
// contract this package keeps.
package service

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/flightdeckhq/flightdeck/internal/cli"
	"github.com/flightdeckhq/flightdeck/internal/datadir"
	"github.com/flightdeckhq/flightdeck/internal/health"
)

// The exit statuses of `flightdeck service`.
const (
	// ExitOK: done; for status, the service runs and answers.
	ExitOK = 0
	// ExitFailed: a step failed, or the service did not come up; for
	// status, it is installed but does not run or does not answer.
	ExitFailed = 1
	// ExitUsage: an unknown command or flag, or a value install refuses.
	ExitUsage = 2
	// ExitNotInstalled: status or restart of a service that is not
	// installed.
	ExitNotInstalled = 3
	// ExitUnsupported: this system or this install cannot run the
	// service (no user service manager, Windows, a Homebrew install whose
	// own service applies); nothing was written, and the message says
	// what to use instead.
	ExitUnsupported = 4
)

// stopTimeoutSecs is how long the manager waits for the binary to exit
// after SIGTERM before it kills it. The binary's stop is two steps of at
// most 30 seconds each, the HTTP drain and the services' stop, then it
// closes the database and the bus; seventy-five is that and slack, the
// install gate's stop bound.
const stopTimeoutSecs = 75

// restartDelaySecs is how long systemd waits before it starts again a
// service that died: long enough that a binary failing at once does not
// spin, short enough that a crash costs seconds of a session's events
// (the plugin drops what it cannot send). launchd's own throttle, ten
// seconds, is its floor there.
const restartDelaySecs = 5

// managerTimeout bounds one command of the service manager. The longest
// is a stop or a restart, which waits for the binary's stop until the
// manager kills it (stopTimeoutSecs); fifteen seconds more is slack for
// a loaded machine.
const managerTimeout = (stopTimeoutSecs + 15) * time.Second

// readyTimeout is how long install and restart wait for the service to
// answer. The binary waits up to 60 seconds for a database that does not
// answer yet and then applies the migrations; ninety is the install
// gate's bound for a first start.
const readyTimeout = 90 * time.Second

// pollInterval is how often the wait asks the manager and the health
// routes again.
const pollInterval = 250 * time.Millisecond

// recentLogLines is how many lines of the service's log a failure shows.
const recentLogLines = 20

// maxLogTailBytes bounds what is read of the end of a log file for those
// lines: twenty lines of the binary's log are a few kilobytes.
const maxLogTailBytes = 64 << 10

// maxOutputBytes bounds what one manager command's output is kept to.
// systemctl and launchctl answer with a few kilobytes; a megabyte keeps
// a runaway one from growing the process.
const maxOutputBytes = 1 << 20

// processWaitDelay is how long a command killed at its timeout gets to
// close its output.
const processWaitDelay = 5 * time.Second

// marker is in the first lines of every file install writes. A file at
// the service's path without it was written by someone else and is never
// changed or removed.
const marker = "Written by flightdeck service install"

// Runner runs a command of the service manager (systemctl, launchctl,
// loginctl, journalctl) and returns what it wrote. A command that is not
// on this machine is an error that wraps exec.ErrNotFound.
type Runner func(ctx context.Context, name string, args ...string) (stdout, stderr []byte, err error)

// IO is what one run of the command reads and writes, and every part of
// the system it reaches, so a test replaces each.
type IO struct {
	Stdout io.Writer
	Stderr io.Writer
	// Getenv reads a variable of the shell the command runs in.
	Getenv func(string) string
	// GOOS is the operating system: "linux" and "darwin" have a manager.
	GOOS string
	// Home is the user's home directory.
	Home string
	// UID and EUID are the user's ids (os.Getuid, os.Geteuid); EUID 0 is
	// root, whom install refuses.
	UID, EUID int
	// User is the user's login name, for the lingering command.
	User string
	// WSL is true under the Windows Subsystem for Linux.
	WSL bool
	// TempDir is the system's temporary directory (os.TempDir).
	TempDir string
	// Executable returns the running binary's path (os.Executable).
	Executable func() (string, error)
	// Run runs the manager's commands.
	Run Runner
	// Answers asks the instance listening on listen whether it serves,
	// and returns the URL that answered.
	Answers func(ctx context.Context, listen string) (string, error)
	// AgentNotes returns what the start-up check of the coding agents
	// says for an instance on listen; nil asks nothing.
	AgentNotes func(ctx context.Context, listen string) []string
	// ReadyTimeout and PollInterval bound and pace the wait for the
	// service to answer.
	ReadyTimeout time.Duration
	PollInterval time.Duration
}

// System is the IO of the binary: this process's environment, user and
// files, the real service manager and the health check of `flightdeck
// health`.
func System(stdout, stderr io.Writer) IO {
	home, _ := os.UserHomeDir()
	name := os.Getenv("USER")
	if u, err := user.Current(); err == nil && u.Username != "" {
		name = u.Username
	}
	return IO{
		Stdout:       stdout,
		Stderr:       stderr,
		Getenv:       os.Getenv,
		GOOS:         runtime.GOOS,
		Home:         home,
		UID:          os.Getuid(),
		EUID:         os.Geteuid(),
		User:         name,
		WSL:          isWSL(),
		TempDir:      os.TempDir(),
		Executable:   os.Executable,
		Run:          execRunner(managerEnv()),
		Answers:      answers,
		ReadyTimeout: readyTimeout,
		PollInterval: pollInterval,
	}
}

// isWSL reports whether this Linux runs under the Windows Subsystem for
// Linux, whose kernel names Microsoft and which sets WSL_DISTRO_NAME.
func isWSL() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	if os.Getenv("WSL_DISTRO_NAME") != "" {
		return true
	}
	data, err := os.ReadFile("/proc/sys/kernel/osrelease")
	return err == nil && strings.Contains(strings.ToLower(string(data)), "microsoft")
}

// managerEnv is what the manager's commands get beside this process's
// environment. systemctl --user finds the user manager through
// XDG_RUNTIME_DIR, which a shell reached through su or sudo -u lacks
// although the manager runs: its socket is then still at the standard
// place.
func managerEnv() []string {
	if runtime.GOOS != "linux" || os.Getenv("XDG_RUNTIME_DIR") != "" {
		return nil
	}
	dir := "/run/user/" + strconv.Itoa(os.Getuid())
	if _, err := os.Stat(filepath.Join(dir, "bus")); err != nil {
		return nil
	}
	return []string{"XDG_RUNTIME_DIR=" + dir}
}

func execRunner(extraEnv []string) Runner {
	return func(ctx context.Context, name string, args ...string) ([]byte, []byte, error) {
		ctx, cancel := context.WithTimeout(ctx, managerTimeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, name, args...)
		if len(extraEnv) > 0 {
			cmd.Env = append(os.Environ(), extraEnv...)
		}
		var stdout, stderr limitedBuffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		cmd.WaitDelay = processWaitDelay
		err := cmd.Run()
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return stdout.Bytes(), stderr.Bytes(), fmt.Errorf("%s did not finish within %s", name, managerTimeout)
		}
		return stdout.Bytes(), stderr.Bytes(), err
	}
}

// limitedBuffer keeps the first maxOutputBytes written to it.
type limitedBuffer struct{ bytes.Buffer }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := maxOutputBytes - b.Len(); room > 0 {
		b.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

// answers is the health check of `flightdeck health` for listen.
func answers(ctx context.Context, listen string) (string, error) {
	target, err := health.TargetFor(listen, "")
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, health.Timeout)
	defer cancel()
	return health.Check(ctx, target)
}

// ---- the service's settings ------------------------------------------

// Config is what the service runs: the binary and the server flags
// install bakes in.
type Config struct {
	// Binary is the binary's absolute path.
	Binary string
	// Listen is the resolved listen address, host:port.
	Listen string
	// DataDir is the data dir, absolute.
	DataDir string
	// DatabaseURLFile is the file the database URL is read from, absolute;
	// empty for the SQLite file in the data dir.
	DatabaseURLFile string
	// AllowedHosts are the --allowed-hosts entries.
	AllowedHosts []string
	// Metrics starts the metrics listeners.
	Metrics bool
}

// Argv is the command line the service runs: the binary and its flags,
// the listen address spelled as a person would give it.
func (c Config) Argv() []string {
	argv := []string{c.Binary}
	host, port, err := net.SplitHostPort(c.Listen)
	switch {
	case err == nil && host == cli.LoopbackHost:
		argv = append(argv, "--port", port)
	case err == nil && host == cli.PublicHost:
		argv = append(argv, "--public", "--port", port)
	default:
		argv = append(argv, "--listen", c.Listen)
	}
	argv = append(argv, "--data-dir", c.DataDir)
	if c.DatabaseURLFile != "" {
		argv = append(argv, "--database-url-file", c.DatabaseURLFile)
	}
	if len(c.AllowedHosts) > 0 {
		argv = append(argv, "--allowed-hosts", strings.Join(c.AllowedHosts, ","))
	}
	if c.Metrics {
		argv = append(argv, "--metrics")
	}
	return argv
}

// configOf reads a Config back from the command line a service file runs.
// It knows the flags Argv writes and nothing else: a file edited by hand
// to run something else is reported as such.
func configOf(argv []string) (Config, error) {
	if len(argv) == 0 || !filepath.IsAbs(argv[0]) {
		return Config{}, errors.New("the service file runs no absolute path")
	}
	fs := flag.NewFlagSet("service", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	port := fs.String("port", cli.DefaultPort, "")
	public := fs.Bool("public", false, "")
	listen := fs.String("listen", "", "")
	dataDir := fs.String("data-dir", "", "")
	urlFile := fs.String("database-url-file", "", "")
	hosts := fs.String("allowed-hosts", "", "")
	metrics := fs.Bool("metrics", false, "")
	if err := fs.Parse(argv[1:]); err != nil {
		return Config{}, fmt.Errorf("the service file's command line: %w", err)
	}
	if fs.NArg() > 0 {
		return Config{}, fmt.Errorf("the service file's command line has an argument flightdeck takes no: %q", fs.Arg(0))
	}
	c := Config{Binary: argv[0], DataDir: *dataDir, DatabaseURLFile: *urlFile, Metrics: *metrics}
	if *hosts != "" {
		c.AllowedHosts = strings.Split(*hosts, ",")
	}
	switch {
	case *listen != "":
		c.Listen = *listen
	case *public:
		c.Listen = net.JoinHostPort(cli.PublicHost, *port)
	default:
		c.Listen = net.JoinHostPort(cli.LoopbackHost, *port)
	}
	if c.DataDir == "" {
		return Config{}, errors.New("the service file's command line names no --data-dir")
	}
	return c, nil
}

// checkValues refuses a value that neither file format carries intact: a
// control character (a newline would end the unit's line; XML 1.0 has no
// way to write most of them at all) or a byte sequence that is not UTF-8.
func checkValues(argv []string) error {
	for _, v := range argv {
		if !utf8.ValidString(v) {
			return fmt.Errorf("%q is not UTF-8, which the service file cannot hold: choose a path whose name is", v)
		}
		if strings.IndexFunc(v, unicode.IsControl) >= 0 {
			return fmt.Errorf("%q holds a control character, which the service file cannot hold: choose a path without one", v)
		}
	}
	return nil
}

// DashboardURL is the address to open for an instance listening on
// listen: localhost for a loopback listen, <this-host> for every
// interface, the address itself otherwise.
func DashboardURL(listen string) string {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return "http://" + listen
	}
	ip := net.ParseIP(host)
	switch {
	case host == "" || (ip != nil && ip.IsUnspecified()):
		host = "<this-host>"
	case (ip != nil && ip.IsLoopback()) || strings.EqualFold(strings.TrimSuffix(host, "."), "localhost"):
		host = "localhost"
	}
	return "http://" + net.JoinHostPort(host, port)
}

// ---- the service managers --------------------------------------------

// state is what the manager says of the service.
type state struct {
	// loaded: the manager knows the service.
	loaded bool
	// running: its process runs, as pid.
	running bool
	pid     int
	// enabled: it starts at login.
	enabled bool
	// failed: it exited with an error and waits to be started again, or
	// the manager gave up on it.
	failed bool
	// detail is the manager's own word for the state.
	detail string
}

// manager is one system's service manager.
type manager interface {
	// kind names the service to the user: "systemd user unit".
	kind() string
	// path is the file the service is defined in.
	path() string
	// available reports whether the manager can be asked here; an
	// *unsupportedError says why not and what to do instead.
	available(ctx context.Context) error
	// render returns the file that runs c.
	render(c Config) []byte
	// argv reads the command line back from a file render wrote.
	argv(content []byte) ([]string, error)
	// state reads the service's state.
	state(ctx context.Context) (state, error)
	// load makes the manager read the file, enable it and (re)start the
	// service, whether or not it was loaded.
	load(ctx context.Context) error
	// restart restarts a loaded service.
	restart(ctx context.Context) error
	// unload stops the service and makes the manager forget it; the
	// file stays.
	unload(ctx context.Context) error
	// forget is what the manager needs once the file is gone.
	forget(ctx context.Context)
	// commands lists the manager's commands install (load) or remove
	// runs, for --dry-run.
	commands(load bool) []string
	// logHint says where the log of the service running c is: the
	// command that shows it, or the file.
	logHint(c Config) string
	// recentLog returns the last lines of that log since since.
	recentLog(ctx context.Context, c Config, since time.Time) string
	// homebrewLoaded reports whether Homebrew's own flightdeck service is
	// loaded.
	homebrewLoaded(ctx context.Context) bool
	// notes are lines about when the service runs on this machine (the
	// lingering command), printed by install and status.
	notes(ctx context.Context) []string
}

// unsupportedError is a manager that cannot be asked on this machine.
type unsupportedError struct{ msg string }

func (e *unsupportedError) Error() string { return e.msg }

func unsupported(format string, a ...any) error {
	return &unsupportedError{msg: fmt.Sprintf(format, a...)}
}

// managerFor returns the manager of rt's system.
func managerFor(rt IO) (manager, error) {
	switch rt.GOOS {
	case "linux":
		return &systemd{rt: rt}, nil
	case "darwin":
		return &launchd{rt: rt}, nil
	case "windows":
		return nil, unsupported("flightdeck service is not available on Windows yet; until it is, run flightdeck in a terminal, " +
			"or in Docker Desktop with --restart unless-stopped (guides/windows.md)")
	}
	return nil, unsupported("flightdeck service runs a systemd user unit on Linux or a launchd agent on macOS, and this system is %s; "+
		"start flightdeck with its own service manager, or in Docker with --restart unless-stopped", rt.GOOS)
}

// commandError describes a manager command that failed: the command and
// the first line it wrote to stderr, or the error.
func commandError(name string, args []string, stderr []byte, err error) error {
	line := firstLine(stderr)
	if line == "" {
		line = err.Error()
	}
	return fmt.Errorf("%s %s: %s", name, strings.Join(args, " "), line)
}

func firstLine(b []byte) string {
	s := strings.TrimSpace(string(b))
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// ---- files ------------------------------------------------------------

// readFile returns the content of path and whether it exists.
func readFile(path string) ([]byte, bool, error) {
	data, err := os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil, false, nil
	case err != nil:
		return nil, false, fmt.Errorf("read %s: %w", path, err)
	}
	return data, true, nil
}

// writeFile writes data to path with mode 0644 through a temporary file
// in the same directory, so the manager never reads half of it, creating
// the directory when it is missing.
func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	_, werr := tmp.Write(data)
	if cerr := tmp.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Chmod(tmp.Name(), 0o644)
	}
	if werr == nil {
		werr = os.Rename(tmp.Name(), path)
	}
	if werr != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("write %s: %w", path, werr)
	}
	return nil
}

func ours(content []byte) bool { return bytes.Contains(content, []byte(marker)) }

// lockPath is the data dir's lock file.
func lockPath(c Config) string { return filepath.Join(c.DataDir, datadir.LockFile) }

// homeRelative shows path with the home directory as ~.
func homeRelative(rt IO, path string) string {
	if rt.Home != "" && strings.HasPrefix(path, rt.Home+string(filepath.Separator)) {
		return "~" + path[len(rt.Home):]
	}
	return path
}

// shellQuote spells argv as a shell command a person can copy: each
// argument as it is when it holds nothing a shell reads specially, else
// in single quotes.
func shellQuote(argv []string) string {
	parts := make([]string, len(argv))
	for i, a := range argv {
		if a != "" && strings.Trim(a, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./,:=@+") == "" {
			parts[i] = a
			continue
		}
		parts[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
	}
	return strings.Join(parts, " ")
}
