// Package connect connects coding agents on this machine to a Flightdeck
// server: `flightdeck connect`. Each agent is a Connector in the
// registry; the command, the installers' query and the listing reach
// agents only through it, so another agent is one more Connector.
package connect

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
)

// Connector is one coding agent Flightdeck can connect. Every
// implementation keeps the contract ARCHITECTURE.md states (Operational
// Concerns > Connecting coding agents): Detect and Status change
// nothing, a plan lists only the steps still missing, no secret is put
// on a command line, and every external command is bounded.
type Connector interface {
	// ID is the stable name users type: `flightdeck connect <id>`.
	ID() string
	// Name is the agent's display name.
	Name() string
	// Detect finds the agent's command on this machine. A missing
	// command is a Detection with Found false, not an error; an error
	// means the command is there and did not answer.
	Detect(ctx context.Context) (Detection, error)
	// Status reads whether Flightdeck's integration is installed and
	// where it reports. It is only called for a detected agent.
	Status(ctx context.Context) (Status, error)
	// PlanConnect returns the steps that connect the agent as target
	// asks, reading only. No step means it is connected as asked.
	PlanConnect(ctx context.Context, target Target) (Plan, error)
	// PlanDisconnect returns the steps that remove the integration,
	// reading only. No step means it is not connected.
	PlanDisconnect(ctx context.Context) (Plan, error)
}

// Detection is what Detect found.
type Detection struct {
	// Found is true when the agent's command is on PATH.
	Found bool
	// Path is the command's absolute path.
	Path string
	// Version is the first line the command printed for its version.
	Version string
	// Missing says why Found is false, for the listing.
	Missing string
}

// Status is what Status read.
type Status struct {
	// Installed is true when the integration is installed for the user.
	Installed bool
	// Enabled is true when it is also turned on: Installed and Enabled
	// together are "connected".
	Enabled bool
	// Version is the integration's version.
	Version string
	// Server is the server it saved; "" means the integration's
	// default, the local server.
	Server string
	// TokenSaved is true when a token is saved. Its value is never read.
	TokenSaved bool
}

// Connected reports whether the agent reports to Flightdeck.
func (s Status) Connected() bool { return s.Installed && s.Enabled }

// Target is what `flightdeck connect <id>` asks for.
type Target struct {
	// Server is the server to save, checked by CheckServer; "" keeps
	// the saved one, or the local default on a new connection.
	Server string
	// Local is true when Server's host is this machine's loopback.
	Local bool
	// Token is the token to save with Server; "" saves none. It is set
	// only together with Server.
	Token string
}

// Step is one change a plan makes.
type Step struct {
	// Summary says what the step changes, for the confirmation.
	Summary string
	// Run makes the change and returns the line that reports it.
	Run func(ctx context.Context) (string, error)
}

// Plan is the ordered steps of a connect or a disconnect.
type Plan struct {
	// Steps run in order; the first failure stops the rest.
	Steps []Step
	// Notice says what the user agrees to by connecting: what the
	// integration records and where it sends it. It is shown with the
	// steps, before the question and by --dry-run.
	Notice string
	// Caution, when set, is a step the user must confirm on a terminal:
	// --yes does not accept it and a run without a terminal refuses the
	// plan, naming what to do instead.
	Caution string
	// Unchanged is the line printed when there is no step.
	Unchanged string
	// Done is the line printed once every step ran.
	Done string
}

// Describe writes what the plan would change, for the confirmation and
// for --dry-run: the title, a line per step, the caution and the notice.
func (p Plan) Describe(w io.Writer, title string) {
	if len(p.Steps) == 0 {
		_, _ = fmt.Fprintln(w, p.Unchanged)
		return
	}
	_, _ = fmt.Fprintf(w, "%s:\n", title)
	for _, step := range p.Steps {
		_, _ = fmt.Fprintf(w, "  - %s\n", step.Summary)
	}
	if p.Caution != "" {
		_, _ = fmt.Fprintf(w, "Caution: %s\n", p.Caution)
	}
	if p.Notice != "" {
		_, _ = fmt.Fprintln(w, p.Notice)
	}
}

// Apply runs the plan's steps, reporting each one's line. A failed step
// stops the plan; its error names the step.
func (p Plan) Apply(ctx context.Context, report func(string)) error {
	if len(p.Steps) == 0 {
		report(p.Unchanged)
		return nil
	}
	for _, step := range p.Steps {
		line, err := step.Run(ctx)
		if err != nil {
			return err
		}
		if line != "" {
			report(line)
		}
	}
	report(p.Done)
	return nil
}

// ErrNotFound marks a connect or a remove for an agent whose command is
// not on this machine.
var ErrNotFound = errors.New("agent not found on this machine")

// ErrUsage marks a value the user gave that the command refuses: the
// usage exit status, not a failure of the agent's CLI.
var ErrUsage = errors.New("usage")

// usageError is an ErrUsage with its own message.
func usageError(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrUsage}, args...)...)
}

// Registry is the connectors the command knows, in listing order.
type Registry []Connector

// Lookup returns the connector with that id.
func (r Registry) Lookup(id string) (Connector, bool) {
	for _, c := range r {
		if c.ID() == id {
			return c, true
		}
	}
	return nil, false
}

// IDs returns every connector's id, for a usage message.
func (r Registry) IDs() []string {
	ids := make([]string, 0, len(r))
	for _, c := range r {
		ids = append(ids, c.ID())
	}
	return ids
}

// Default is the registry of the binary: every agent it can connect.
func Default() Registry { return DefaultIn(nil) }

// DefaultIn is Default with every agent command run in env, its whole
// environment; nil is this process's environment, as Exec runs it.
func DefaultIn(env []string) Registry {
	return Registry{NewClaudeCode(exec.LookPath, ExecIn(env))}
}

// ---- external commands -------------------------------------------------

// processWaitDelay is how long a command killed at its timeout gets to
// close its output. The kill ends the CLI's whole process group, so its
// children (a git clone) close the pipes with it; five seconds is the
// bound for one that escaped the group, after which the step fails all
// the same.
const processWaitDelay = 5 * time.Second

// maxOutputBytes bounds what one command's stdout or stderr is kept to.
// The CLIs answer with a few kilobytes of JSON; a megabyte is far past
// any real answer and keeps a runaway one from growing the process.
const maxOutputBytes = 1 << 20

// RunFunc runs an agent's CLI: path with args, stdin as its input (nil
// for none), killed after timeout. It returns what the command wrote
// and an error when it could not run, did not finish in time or exited
// non-zero.
type RunFunc func(ctx context.Context, timeout time.Duration, stdin []byte, path string, args ...string) (stdout, stderr []byte, err error)

// ErrTimeout marks a command that did not finish within its timeout.
var ErrTimeout = errors.New("did not finish in time")

// Exec is the RunFunc of the binary: the command in this process's
// environment, so the agent's own variables (CLAUDE_CONFIG_DIR) apply.
func Exec(ctx context.Context, timeout time.Duration, stdin []byte, path string, args ...string) ([]byte, []byte, error) {
	return execIn(ctx, nil, timeout, stdin, path, args...)
}

// ExecIn is the RunFunc that runs each command with env as its whole
// environment, nil being this process's own (Exec): the server runs the
// agents' commands without the settings and secrets it holds.
func ExecIn(env []string) RunFunc {
	return func(ctx context.Context, timeout time.Duration, stdin []byte, path string, args ...string) ([]byte, []byte, error) {
		return execIn(ctx, env, timeout, stdin, path, args...)
	}
}

func execIn(ctx context.Context, env []string, timeout time.Duration, stdin []byte, path string, args ...string) ([]byte, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = env
	var stdout, stderr limitedBuffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	// No stdin at all unless the step carries values: a CLI that would
	// ask a question reads end of file and fails, instead of waiting.
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	cmd.WaitDelay = processWaitDelay
	// The CLI runs in a process group of its own, and the timeout ends
	// the whole group (on Windows the process tree), so a child it
	// started (a git clone) does not outlive the step.
	killTreeOnCancel(cmd)
	err := cmd.Run()
	if ctx.Err() != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return stdout.Bytes(), stderr.Bytes(), fmt.Errorf("%w: %s", ErrTimeout, timeout)
	}
	return stdout.Bytes(), stderr.Bytes(), err
}

// limitedBuffer keeps the first maxOutputBytes written to it and drops
// the rest, so a command's output never blocks it and never grows
// without bound.
type limitedBuffer struct{ bytes.Buffer }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := maxOutputBytes - b.Len(); room > 0 {
		if len(p) > room {
			b.Buffer.Write(p[:room])
		} else {
			b.Buffer.Write(p)
		}
	}
	return len(p), nil
}

// ---- the values a user gives ------------------------------------------

// DevToken is the development token a loopback flightdeck accepts.
const DevToken = "tok_dev"

// Minted access tokens: "ftd_" and 32 lower-case hex digits (see
// ARCHITECTURE.md, API > Authentication > Token format).
const (
	tokenPrefix    = "ftd_"
	tokenHexDigits = 32
)

// maxTokenFileBytes bounds a token file. A token is 36 bytes; four
// kibibytes leaves room for white space and a line ending of any kind,
// and a larger file is not a token file (a key, a log given by mistake).
const maxTokenFileBytes = 4096

// CheckServer checks a --server value and returns it trimmed, with
// whether its host is this machine's loopback. No message repeats the
// value: one that is refused may hold a token or a password.
func CheckServer(raw string) (string, bool, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", false, usageError("--server is empty; give the server's URL, for example https://flightdeck.example.com")
	}
	lower := strings.ToLower(value)
	if strings.HasPrefix(lower, "ftd_") || strings.HasPrefix(lower, "tok_") {
		return "", false, usageError("--server got a value that looks like an access token; give the token with --token-file or FLIGHTDECK_TOKEN, and the server's URL with --server")
	}
	if strings.ContainsRune(value, '\\') || strings.IndexFunc(value, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return "", false, usageError("--server must be a URL with no spaces or backslashes, for example https://flightdeck.example.com")
	}
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Opaque != "" {
		return "", false, usageError("--server takes the server's http:// or https:// URL, for example https://flightdeck.example.com, or the ingestion URL its start-up block prints")
	}
	if u.User != nil {
		return "", false, usageError("--server carries credentials (user:password@); they would be saved in plain text and the plugin ignores them: give the token with --token-file or FLIGHTDECK_TOKEN")
	}
	host := u.Hostname()
	if host == "" {
		return "", false, usageError("--server names no host, for example https://flightdeck.example.com")
	}
	return value, isLoopbackHost(host), nil
}

// isLoopbackHost reports whether host is this machine's loopback, where
// a flightdeck accepts the development token: localhost or a loopback
// address. Any other name is resolved elsewhere and is not assumed to be.
func isLoopbackHost(host string) bool {
	if strings.EqualFold(strings.TrimSuffix(host, "."), "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// errTokenForm describes the token a connect saves. It never carries
// the value it refused.
var errTokenForm = usageError(`the token must be an access token, "ftd_" followed by 32 lower-case hex digits ` +
	`(Settings > Access tokens, or the one the server printed at its first start), or the development token ` + DevToken)

// CheckToken reports whether token has the form of an access token.
func CheckToken(token string) error {
	if token == DevToken {
		return nil
	}
	digits, found := strings.CutPrefix(token, tokenPrefix)
	if !found || len(digits) != tokenHexDigits || strings.Trim(digits, "0123456789abcdef") != "" {
		return errTokenForm
	}
	return nil
}

// ReadTokenFile returns the token a --token-file holds, without its
// surrounding white space. The message names the file, never its
// content.
func ReadTokenFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", usageError("--token-file: %v", err)
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, maxTokenFileBytes+1))
	if err != nil {
		return "", usageError("--token-file: read %s: %v", path, err)
	}
	if len(data) > maxTokenFileBytes {
		return "", usageError("--token-file: %s is larger than a token file (%d bytes at most)", path, maxTokenFileBytes)
	}
	token := strings.TrimSpace(decodeText(data))
	if token == "" {
		return "", usageError("--token-file: %s is empty", path)
	}
	return token, nil
}

// decodeText reads a token file's bytes as text: UTF-8, with or without
// a byte-order mark, or UTF-16 with its mark, which Windows PowerShell
// 5.1 writes for `"ftd_..." > token.txt`.
func decodeText(data []byte) string {
	switch {
	case bytes.HasPrefix(data, []byte{0xEF, 0xBB, 0xBF}):
		return string(data[3:])
	case bytes.HasPrefix(data, []byte{0xFF, 0xFE}), bytes.HasPrefix(data, []byte{0xFE, 0xFF}):
		little := data[0] == 0xFF
		body := data[2:]
		units := make([]uint16, 0, len(body)/2)
		for i := 0; i+1 < len(body); i += 2 {
			if little {
				units = append(units, uint16(body[i])|uint16(body[i+1])<<8)
			} else {
				units = append(units, uint16(body[i])<<8|uint16(body[i+1]))
			}
		}
		return string(utf16.Decode(units))
	}
	return string(data)
}

// TokenFileWarning returns a warning when other users of the machine
// can read the token file (a group or world permission bit), "" when
// not or where the file system keeps no such bits (Windows). The file
// is read all the same: a mounted secret is often 0644 in a container
// that has no other user.
func TokenFileWarning(path string) string {
	if runtime.GOOS == "windows" {
		return ""
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm()&0o077 == 0 {
		return ""
	}
	return fmt.Sprintf("warning: %s can be read by other users (mode %04o); chmod 600 it", path, info.Mode().Perm())
}

// printable drops control characters from a value read from an agent's
// configuration before it is printed, so a saved value cannot move the
// cursor, ring the bell or split a line of --detected.
func printable(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
}
