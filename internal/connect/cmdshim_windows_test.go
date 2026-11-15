//go:build windows

package connect

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Claude Code installed with npm puts claude.cmd on PATH, a batch file
// that cmd.exe runs and that starts the CLI. The connector must find it
// through PATHEXT, give it values on stdin through cmd.exe, and on a
// timeout end cmd.exe, the CLI and the CLI's own children together: here
// the CLI is the Go stand-in, started by a real claude.cmd. npm puts the
// shim in the user's profile, and a profile's path often has a space in
// it (C:\Users\Jane Doe\AppData\Roaming\npm\claude.cmd), which the path
// cmd.exe is given must survive.
func TestClaudeCode_AClaudeCmdShim(t *testing.T) {
	exe := goFakeClaude(t)
	for _, tc := range []struct{ name, dir string }{
		{"a shim directory without a space", t.TempDir()},
		{"a shim directory with a space", filepath.Join(t.TempDir(), "Jane Doe", "npm")},
	} {
		t.Run(tc.name, func(t *testing.T) { testClaudeCmdShim(t, exe, tc.dir) })
	}
}

// testClaudeCmdShim writes claude.cmd into shimDir, starting exe, and
// drives the connector through it.
func testClaudeCmdShim(t *testing.T, exe, shimDir string) {
	if err := os.MkdirAll(shimDir, 0o755); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(shimDir, "claude.cmd")
	if err := os.WriteFile(shim, []byte("@echo off\r\n\""+exe+"\" %*\r\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Only the shim's directory: the stand-in's own claude.exe is not on
	// PATH, or PATHEXT would find it before the .cmd.
	t.Setenv("PATH", shimDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	for _, v := range []string{"FAKE_CLAUDE_FAIL", "FAKE_CLAUDE_HANG", "FAKE_CLAUDE_HANG_CHILD", "FAKE_CLAUDE_HANG_SECS", "FAKE_CLAUDE_VERSION"} {
		t.Setenv(v, "")
	}

	t.Run("found through PATHEXT, values on stdin through cmd.exe", func(t *testing.T) {
		state := t.TempDir()
		t.Setenv("FAKE_CLAUDE_STATE", state)
		c := NewClaudeCode(exec.LookPath, Exec)
		det, err := c.Detect(context.Background())
		if err != nil || !det.Found || !strings.EqualFold(det.Path, shim) || det.Version != "2.1.325 (Claude Code)" {
			t.Fatalf("Detect = %+v, %v; want %s and the stand-in's version", det, err, shim)
		}
		if _, err := applyConnect(t, c, Target{Server: "https://fd.example.com", Token: testToken}); err != nil {
			t.Fatal(err)
		}
		saved, _ := os.ReadFile(filepath.Join(state, "token"))
		log, _ := os.ReadFile(filepath.Join(state, "calls.log"))
		if string(saved) != testToken || !strings.Contains(string(log), `stdin: {"server":"https://fd.example.com","token":"`+testToken+`"}`) {
			t.Fatalf("the token did not reach the CLI on stdin; saved %q, log:\n%s", saved, log)
		}
		for _, line := range strings.Split(string(log), "\n") {
			if strings.HasPrefix(line, "argv: ") && strings.Contains(line, testToken) {
				t.Fatalf("the token is on a command line: %q", line)
			}
		}
	})

	t.Run("a timeout ends cmd.exe, the CLI and its child", func(t *testing.T) {
		state := t.TempDir()
		t.Setenv("FAKE_CLAUDE_STATE", state)
		t.Setenv("FAKE_CLAUDE_HANG_CHILD", "marketplace-add")
		t.Setenv("FAKE_CLAUDE_HANG_SECS", "60")
		start := time.Now()
		_, err := applyConnect(t, NewClaudeCode(exec.LookPath, shortTimeouts), Target{})
		if err == nil || !strings.Contains(err.Error(), "did not finish within") {
			t.Fatalf("err = %v; want the step stopped", err)
		}
		if elapsed := time.Since(start); elapsed > testStepTimeout+processWaitDelay/2 {
			t.Errorf("the step took %s: something kept the output open", elapsed)
		}
		raw, _ := os.ReadFile(filepath.Join(state, "child.pid"))
		pid, perr := strconv.Atoi(strings.TrimSpace(string(raw)))
		if perr != nil {
			t.Fatalf("the stand-in recorded no child: %v", perr)
		}
		deadline := time.Now().Add(5 * time.Second)
		for processAlive(pid) {
			if time.Now().After(deadline) {
				t.Fatalf("the CLI's child %d still runs after the step was stopped", pid)
			}
			time.Sleep(50 * time.Millisecond)
		}
	})
}
