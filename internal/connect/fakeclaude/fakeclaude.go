// Package fakeclaude is a stand-in for Claude Code's `claude` CLI that the
// connect tests run on Windows, where scripts/fake-claude.sh (the POSIX
// stand-in the Unix tests and the install gate run) cannot. A test copies
// its own test binary into a directory on PATH as claude.exe; the binary's
// TestMain sees that name (Is) and runs Main instead of the tests. It
// answers the commands the Claude Code connector runs with the same
// output, state files, log and faults as the shell stand-in, whose header
// documents them. The two are held to the same assertions, the shell one
// by the Unix runs and this one by the Windows run, and on Unix
// internal/connect's TestFakeClaude_TheTwoStandInsAgree runs both through
// one command sequence and compares what they print, exit with, log and
// keep.
package fakeclaude

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Name is the executable name a test gives its copy of the test binary.
const Name = "claude"

// sleepArg is the first argument of the child the stand-in starts for
// FAKE_CLAUDE_HANG_CHILD: the same executable, which only sleeps.
const sleepArg = "__fake_claude_sleep__"

// defaultHang is how long a hung step sleeps unless FAKE_CLAUDE_HANG_SECS
// says otherwise, as the shell stand-in's default: far past any step's
// timeout, so only the kill ends it.
const defaultHang = 600 * time.Second

const plugin = "flightdeck@flightdeck-plugins"

// Is reports whether the running executable is a test binary's copy
// named claude, which runs Main and not the tests.
func Is() bool {
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	base := strings.TrimSuffix(strings.ToLower(filepath.Base(exe)), ".exe")
	return base == Name
}

// Main runs the stand-in with args (the words after the program name),
// and returns its exit status.
func Main(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 2 && args[0] == sleepArg {
		secs, err := strconv.Atoi(args[1])
		if err != nil {
			// The stand-in itself starts this child with a number; anything
			// else is a mistake in the test, not a hang to simulate.
			_, _ = fmt.Fprintln(stderr, "fake claude: the sleeper takes a number of seconds:", err)
			return 2
		}
		time.Sleep(time.Duration(secs) * time.Second)
		return 0
	}
	state := os.Getenv("FAKE_CLAUDE_STATE")
	if state == "" {
		_, _ = fmt.Fprintln(stderr, "fake claude: FAKE_CLAUDE_STATE must name the stand-in state directory")
		return 2
	}
	if err := os.MkdirAll(state, 0o700); err != nil {
		_, _ = fmt.Fprintln(stderr, "fake claude:", err)
		return 2
	}
	s := &stand{state: state, out: stdout, errw: stderr}
	// "argv:" and a space before each argument, as the shell stand-in
	// writes it: a call with no arguments logs "argv:" alone.
	argv := "argv:"
	for _, arg := range args {
		argv += " " + arg
	}
	s.log(argv)

	steps := map[string]string{
		"--version":                      "version",
		"plugin list --json":             "list",
		"plugin marketplace list --json": "marketplace-list",
		"plugin marketplace add flightdeckhq/flightdeck --json": "marketplace-add",
		"plugin install " + plugin + " --scope user --json":     "install",
		"plugin enable " + plugin:                               "enable",
		"plugin configure " + plugin + " --json":                "configure-read",
		"plugin configure " + plugin + " --values-stdin --json": "configure",
		"plugin uninstall " + plugin + " --scope user --json":   "uninstall",
	}
	step, ok := steps[strings.Join(args, " ")]
	if !ok {
		_, _ = fmt.Fprintf(stderr, "fake claude: unexpected command: %s\n", strings.Join(args, " "))
		return 64
	}
	s.step = step

	hang := defaultHang
	if secs, err := strconv.Atoi(os.Getenv("FAKE_CLAUDE_HANG_SECS")); err == nil {
		hang = time.Duration(secs) * time.Second
	}
	if listed(os.Getenv("FAKE_CLAUDE_HANG"), step) {
		time.Sleep(hang)
		return 0
	}
	if listed(os.Getenv("FAKE_CLAUDE_HANG_CHILD"), step) {
		// A child that holds the output open, as a CLI's hung git clone
		// does: it inherits the stand-in's stdout and stderr.
		exe, err := os.Executable()
		if err != nil {
			_, _ = fmt.Fprintln(stderr, "fake claude:", err)
			return 2
		}
		child := exec.Command(exe, sleepArg, strconv.Itoa(int(hang/time.Second)))
		child.Stdout, child.Stderr = stdout, stderr
		if err := child.Start(); err != nil {
			_, _ = fmt.Fprintln(stderr, "fake claude:", err)
			return 2
		}
		s.write("child.pid", strconv.Itoa(child.Process.Pid)+"\n")
		_ = child.Wait()
	}
	if listed(os.Getenv("FAKE_CLAUDE_FAIL"), step) {
		return s.fail("simulated " + step + " failure")
	}
	return s.run(stdin)
}

// stand is one run of the stand-in.
type stand struct {
	state, step string
	out, errw   io.Writer
}

func listed(list, step string) bool {
	return strings.Contains(","+list+",", ","+step+",")
}

func (s *stand) path(name string) string { return filepath.Join(s.state, name) }

func (s *stand) has(name string) bool {
	_, err := os.Stat(s.path(name))
	return err == nil
}

func (s *stand) read(name string) string {
	data, _ := os.ReadFile(s.path(name))
	return string(data)
}

func (s *stand) write(name, content string) {
	_ = os.WriteFile(s.path(name), []byte(content), 0o600)
}

func (s *stand) remove(names ...string) {
	for _, name := range names {
		_ = os.Remove(s.path(name))
	}
}

func (s *stand) log(line string) {
	f, err := os.OpenFile(s.path("calls.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	_, _ = fmt.Fprintln(f, line)
}

func (s *stand) printf(format string, args ...any) { _, _ = fmt.Fprintf(s.out, format, args...) }

// fail answers as Claude Code fails: a --json result line with outcome
// "failed", a line on stderr, exit status 1. message is written into the
// JSON as it is, so it carries its own escapes.
func (s *stand) fail(message string) int {
	s.printf("{\"command\":%q,\"outcome\":\"failed\",\"plugin\":%q,\"message\":\"%s\"}\n", s.step, plugin, message)
	_, _ = fmt.Fprintf(s.errw, "x Failed: %s\n", message)
	return 1
}

// jsonValue reads a string member from the one-line JSON object the
// connector sends, as the shell stand-in's sed does: the pattern's last
// match, as sed's greedy prefix finds it (and as a JSON parser keeps the
// last of a repeated member). ok reports whether the object has such a
// member, an empty value included.
func jsonValue(body, key string) (value string, ok bool) {
	pattern := regexp.MustCompile(`"` + regexp.QuoteMeta(key) + `" *: *"([^"]*)"`)
	all := pattern.FindAllStringSubmatch(body, -1)
	if len(all) == 0 {
		return "", false
	}
	return all[len(all)-1][1], true
}

func (s *stand) run(stdin io.Reader) int {
	switch s.step {
	case "version":
		version := os.Getenv("FAKE_CLAUDE_VERSION")
		if version == "" {
			version = "2.1.325 (Claude Code)"
		}
		s.printf("%s\n", version)
	case "list":
		other := `{"id":"other@elsewhere","version":"1.0.0","scope":"user","enabled":true,"projectEnabled":false,"hasUserConfig":false}`
		if s.has("installed") {
			s.printf("[\n  %s,\n  {\"id\":%q,\"version\":\"0.9.0\",\"scope\":\"user\",\"enabled\":%t,\"installPath\":%q,\"projectEnabled\":false,\"hasUserConfig\":true}\n]\n",
				other, plugin, !s.has("disabled"), filepath.Join(s.state, "cache"))
		} else {
			s.printf("[\n  %s\n]\n", other)
		}
	case "marketplace-list":
		if !s.has("marketplace") {
			s.printf("[]\n")
			break
		}
		members := s.read("marketplace")
		if members == "" {
			members = `"source":"github","repo":"flightdeckhq/flightdeck"`
		}
		s.printf("[\n  {\"name\":\"flightdeck-plugins\",%s,\"installLocation\":%q}\n]\n", members, filepath.Join(s.state, "marketplace"))
	case "marketplace-add":
		s.write("marketplace", "")
		s.printf(`{"command":"marketplace-add","outcome":"ok","marketplace":"flightdeck-plugins","message":"Cloning...\nSuccessfully added marketplace: flightdeck-plugins (declared in user settings)"}` + "\n")
	case "install":
		if !s.has("marketplace") {
			return s.fail(`Plugin \"flightdeck\" not found in marketplace \"flightdeck-plugins\"`)
		}
		s.write("installed", "")
		s.remove("disabled")
		s.printf("{\"command\":\"install\",\"outcome\":\"ok\",\"plugin\":%q,\"pluginId\":%q,\"scope\":\"user\",\"message\":\"Successfully installed plugin: %s (scope: user)\",\"unsetOptionCount\":3}\n",
			plugin, plugin, plugin)
	case "enable":
		if !s.has("installed") {
			return s.fail(`Plugin \"` + plugin + `\" is not installed`)
		}
		if !s.has("disabled") {
			return s.fail(`Plugin \"` + plugin + `\" is already enabled`)
		}
		s.remove("disabled")
		s.printf("Successfully enabled plugin: flightdeck (scope: user)\n")
	case "configure-read":
		if !s.has("installed") {
			_, _ = fmt.Fprintf(s.errw, "No installed plugin has the id %q.\n", plugin)
			return 1
		}
		server := s.read("server")
		var configured []string
		if server != "" {
			configured = append(configured, `"server"`)
		}
		if s.has("token") {
			configured = append(configured, `"token"`)
		}
		// The saved value goes into the JSON as it is: a test saves it
		// already escaped, as Claude Code prints it.
		s.printf("{\n  \"pluginId\": %q,\n  \"inputs\": {\"server\": \"%s\", \"token\": \"\", \"enforcement\": \"false\"},\n  \"configured\": [%s]\n}\n",
			plugin, server, strings.Join(configured, ","))
	case "configure":
		if !s.has("installed") {
			_, _ = fmt.Fprintf(s.errw, "No installed plugin has the id %q.\n", plugin)
			return 1
		}
		data, _ := io.ReadAll(bufio.NewReader(stdin))
		body := strings.TrimRight(string(data), "\r\n")
		s.log("stdin: " + body)
		var saved []string
		// The server option is saved when the object has a server member
		// (an empty value is saved empty): Claude Code parses the object
		// and saves the options it names, so the word "server" as another
		// member's value is not that option. The shell stand-in decides
		// it with the same pattern.
		if server, ok := jsonValue(body, "server"); ok {
			s.write("server", server)
			saved = append(saved, `"server"`)
		}
		// Claude Code keeps a saved token when it is given an empty one.
		if token, _ := jsonValue(body, "token"); token != "" {
			s.write("token", token)
			saved = append(saved, `"token"`)
		}
		s.printf("{\n  \"pluginId\": %q,\n  \"saved\": [%s]\n}\n", plugin, strings.Join(saved, ","))
	case "uninstall":
		if !s.has("installed") {
			return s.fail(`Plugin \"` + plugin + `\" not found in installed plugins`)
		}
		s.remove("installed", "disabled", "server", "token")
		s.printf("{\"command\":\"uninstall\",\"outcome\":\"ok\",\"plugin\":%q,\"pluginId\":%q,\"scope\":\"user\",\"keptData\":false,\"message\":\"Successfully uninstalled plugin: flightdeck (scope: user)\"}\n",
			plugin, plugin)
	}
	return 0
}
