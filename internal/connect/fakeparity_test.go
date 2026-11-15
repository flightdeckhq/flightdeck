//go:build !windows

package connect

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// The connect tests drive one stand-in claude per platform and hold both
// to the same assertions: scripts/fake-claude.sh on Unix, the Go
// fakeclaude on Windows. A platform runs only its own, so this test runs
// both side by side through one sequence of the commands the connector
// runs, with FAKE_CLAUDE_FAIL and FAKE_CLAUDE_VERSION (the hangs are a
// matter of timing, which the timeout tests check on each platform's
// own), through the connector's own runner (Exec), each in a state
// directory of its own. After every command the two must have
// printed the same stdout and stderr, exited with the same status and
// left the same calls.log and state files, so a change to one stand-in
// that the other lacks fails here. The file is built on Unix only:
// Windows has no POSIX shell to run the script, which is why fakeclaude
// exists.

// standInStep is one step of the sequence: state files both stand-ins
// get first (set, in fakeClaude.set's form), or a command with its stdin
// (nil for none) and the FAKE_CLAUDE_* faults it runs with.
type standInStep struct {
	set   []string
	args  []string
	stdin []byte
	env   map[string]string
}

func (s standInStep) String() string {
	d := "`" + strings.TrimSpace("claude "+strings.Join(s.args, " ")) + "`"
	if s.stdin != nil {
		d += " with stdin " + string(s.stdin)
	}
	for _, v := range []string{"FAKE_CLAUDE_FAIL", "FAKE_CLAUDE_VERSION"} {
		if s.env[v] != "" {
			d += fmt.Sprintf(" and %s=%s", v, s.env[v])
		}
	}
	return d
}

// standInRun is what one stand-in did for one command, with its state
// directory's path written as $FAKE_CLAUDE_STATE.
type standInRun struct {
	stdout, stderr string
	status         int
	files          map[string]string
}

func (r standInRun) String() string {
	return fmt.Sprintf("status %d\nstdout:\n%s\nstderr:\n%s\nstate files: %q", r.status, r.stdout, r.stderr, r.files)
}

func TestFakeClaude_TheTwoStandInsAgree(t *testing.T) {
	shell := newFakeClaude(t)
	goStandIn := &fakeClaude{exe: goFakeClaude(t), state: t.TempDir()}

	commands := 0
	for _, step := range standInSequence() {
		if step.set != nil {
			shell.set(t, step.set...)
			goStandIn.set(t, step.set...)
			continue
		}
		commands++
		fromShell, fromGo := runStandIn(t, shell, step), runStandIn(t, goStandIn, step)
		if fromShell.status != fromGo.status || fromShell.stdout != fromGo.stdout || fromShell.stderr != fromGo.stderr ||
			!maps.Equal(fromShell.files, fromGo.files) {
			t.Fatalf("%s: the stand-ins differ\n--- scripts/fake-claude.sh: %s\n--- fakeclaude: %s", step, fromShell, fromGo)
		}
	}
	// Both logged every command (their logs are equal), so none of the
	// sequence was skipped by both alike. A call with no arguments logs
	// "argv:" alone.
	logged := 0
	for _, line := range strings.Split(shell.read(t, "calls.log"), "\n") {
		if strings.HasPrefix(line, "argv:") {
			logged++
		}
	}
	if logged != commands {
		t.Fatalf("the stand-ins logged %d calls for the %d commands run", logged, commands)
	}
}

// runStandIn runs one command of the sequence on the stand-in f.
func runStandIn(t *testing.T, f *fakeClaude, step standInStep) standInRun {
	t.Helper()
	t.Setenv("FAKE_CLAUDE_STATE", f.state)
	for _, v := range []string{"FAKE_CLAUDE_FAIL", "FAKE_CLAUDE_VERSION"} {
		t.Setenv(v, step.env[v])
	}
	stdout, stderr, err := Exec(context.Background(), claudeLocalTimeout, step.stdin, f.exe, step.args...)
	status := 0
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			t.Fatalf("%s on %s: %v", step, f.exe, err)
		}
		status = exit.ExitCode()
	}
	local := func(s string) string { return strings.ReplaceAll(s, f.state, "$FAKE_CLAUDE_STATE") }
	entries, err := os.ReadDir(f.state)
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, e := range entries {
		files[e.Name()] = local(f.read(t, e.Name()))
	}
	return standInRun{stdout: local(string(stdout)), stderr: local(string(stderr)), status: status, files: files}
}

// standInSequence is every command the connector runs, in the states it
// meets them in, the faults the tests set and a few values on stdin the
// connector does not send but a stand-in could read differently.
func standInSequence() []standInStep {
	var (
		version         = []string{"--version"}
		list            = []string{"plugin", "list", "--json"}
		marketplaceList = []string{"plugin", "marketplace", "list", "--json"}
		marketplaceAdd  = []string{"plugin", "marketplace", "add", marketplaceSource, "--json"}
		install         = []string{"plugin", "install", pluginID, "--scope", pluginScope, "--json"}
		enable          = []string{"plugin", "enable", pluginID}
		configureRead   = []string{"plugin", "configure", pluginID, "--json"}
		configure       = []string{"plugin", "configure", pluginID, "--values-stdin", "--json"}
		uninstall       = []string{"plugin", "uninstall", pluginID, "--scope", pluginScope, "--json"}
	)
	values := func(body string) []byte { return []byte(body) }
	steps := []standInStep{
		{args: version},
		{args: version, env: map[string]string{"FAKE_CLAUDE_VERSION": "2.2.0 (Claude Code)"}},
		// Nothing declared, nothing installed: the reads answer empty,
		// the changes fail.
		{args: list},
		{args: marketplaceList},
		{args: install},
		{args: enable},
		{args: configureRead},
		{args: configure, stdin: values(`{"server":"https://fd.example.com"}`)},
		{args: uninstall},
		// A connect with --server and a token.
		{args: marketplaceAdd},
		{args: marketplaceList},
		{args: install},
		{args: list},
		{args: enable},
		{args: configure, stdin: values(`{"server":"https://fd.example.com","token":"` + testToken + `"}`)},
		{args: configureRead},
		// An empty token keeps the saved one.
		{args: configure, stdin: values(`{"server":"http://localhost:4100","token":""}`)},
		{args: configureRead},
		// The word server as another member's value is not the server
		// option; an empty server is saved empty; of a repeated member
		// the last counts, as a JSON parser keeps it.
		{args: configure, stdin: values(`{"token":"server"}`)},
		{args: configureRead},
		{args: configure, stdin: values(`{"server":""}`)},
		{args: configureRead},
		{args: configure, stdin: values(`{"server":"https://a.example.com","server":"https://b.example.com"}`)},
		{args: configureRead},
		// No stdin at all.
		{args: configure},
		// A plugin turned off, then on.
		{set: []string{"disabled"}},
		{args: list},
		{args: enable},
		{args: list},
		// A marketplace of that name from a local directory.
		{set: []string{`marketplace="source":"directory","path":"/src/flightdeck"`}},
		{args: marketplaceList},
	}
	// Each step as FAKE_CLAUDE_FAIL makes it fail.
	for _, fault := range []struct {
		step  string
		args  []string
		stdin []byte
	}{
		{"version", version, nil},
		{"list", list, nil},
		{"marketplace-list", marketplaceList, nil},
		{"marketplace-add", marketplaceAdd, nil},
		{"install", install, nil},
		{"enable", enable, nil},
		{"configure-read", configureRead, nil},
		{"configure", configure, values(`{"server":"https://fd.example.com","token":"` + testToken + `"}`)},
		{"uninstall", uninstall, nil},
	} {
		steps = append(steps, standInStep{args: fault.args, stdin: fault.stdin, env: map[string]string{"FAKE_CLAUDE_FAIL": fault.step}})
	}
	return append(steps,
		// A disconnect, then again with nothing installed.
		standInStep{args: uninstall},
		standInStep{args: uninstall},
		standInStep{args: list},
		standInStep{args: configureRead},
		// Commands the connector does not run.
		standInStep{},
		standInStep{args: []string{"plugin", "update", pluginID}},
	)
}
