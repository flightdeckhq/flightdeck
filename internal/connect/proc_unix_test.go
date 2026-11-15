//go:build !windows

package connect

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestClaudeCode_TheTimeoutEndsTheCLIsChildren(t *testing.T) {
	f := newFakeClaude(t)
	t.Setenv("FAKE_CLAUDE_HANG_CHILD", "marketplace-add")
	t.Setenv("FAKE_CLAUDE_HANG_SECS", "60")
	start := time.Now()
	_, err := applyConnect(t, NewClaudeCode(exec.LookPath, shortTimeouts), Target{})
	if err == nil || !strings.Contains(err.Error(), "did not finish within") {
		t.Fatalf("err = %v; want the step stopped", err)
	}
	// The group is killed with the CLI, so nothing holds the output open
	// and the step ends at its timeout, not after the wait for a child.
	if elapsed := time.Since(start); elapsed > testStepTimeout+processWaitDelay/2 {
		t.Errorf("the step took %s: the child kept the output open", elapsed)
	}
	pid, perr := strconv.Atoi(strings.TrimSpace(f.read(t, "child.pid")))
	if perr != nil {
		t.Fatalf("the stand-in recorded no child: %v", perr)
	}
	// The child is gone, not left to run out its sixty seconds.
	deadline := time.Now().Add(5 * time.Second)
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			t.Fatalf("the child %d still runs after the step was stopped", pid)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
