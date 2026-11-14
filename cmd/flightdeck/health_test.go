package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// `flightdeck health` against the real binary: the command a container
// health check runs. The server child listens on every interface, so
// it is in the mode that mints a token, which the health command must
// neither need nor print.

// healthCommandTimeout bounds one run of the health command. The
// command bounds itself at three seconds (health.Timeout); a run that
// outlives ten times that has hung.
const healthCommandTimeout = 30 * time.Second

// runHealthCommand runs `flightdeck health` with args and env added to
// a scrubbed environment, and returns its exit status and its output.
func runHealthCommand(t *testing.T, env []string, args ...string) (int, string) {
	t.Helper()
	cmd, out := command(append([]string{"health"}, args...)...)
	cmd.Env = append(cmd.Env, env...)
	ctx, cancel := context.WithTimeout(context.Background(), healthCommandTimeout)
	defer cancel()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		var exit *exec.ExitError
		switch {
		case err == nil:
			return 0, out.String()
		case errors.As(err, &exit):
			return exit.ExitCode(), out.String()
		default:
			t.Fatalf("flightdeck health %v: %v\n%s", args, err, out.String())
		}
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		<-done
		t.Fatalf("flightdeck health %v did not exit within %s:\n%s", args, healthCommandTimeout, out.String())
	}
	return -1, ""
}

func TestBinary_HealthCommand(t *testing.T) {
	port := freePort(t)
	dataDir := filepath.Join(tempDir(t), "data")
	c := start(t, "0.0.0.0:"+port, port, dataDir)
	token := c.dashboardToken(t)
	if !strings.HasPrefix(token, "ftd_") {
		t.Fatalf("a listen on every interface serves the token %q, want a minted ftd_ token", token)
	}
	healthy := "healthy: http://127.0.0.1:" + port + " answers /api/health and /ingest/health\n"

	t.Run("the server's own flags", func(t *testing.T) {
		code, out := runHealthCommand(t, nil, "--listen", "0.0.0.0:"+port)
		if code != 0 || out != healthy {
			t.Fatalf("exit %d, output %q; want 0 and %q", code, out, healthy)
		}
	})
	t.Run("no arguments, the server's environment", func(t *testing.T) {
		// What a container health check runs: the command alone, in
		// the environment the server was configured through. The data
		// dir named there must not be touched.
		untouched := filepath.Join(tempDir(t), "not-created")
		code, out := runHealthCommand(t, []string{"FLIGHTDECK_LISTEN=:" + port, "FLIGHTDECK_DATA_DIR=" + untouched})
		if code != 0 || out != healthy {
			t.Fatalf("exit %d, output %q; want 0 and %q", code, out, healthy)
		}
		if _, err := os.Stat(untouched); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("the health command created its data dir (stat: %v); it must touch nothing", err)
		}
	})
	t.Run("a loopback address of the same port", func(t *testing.T) {
		code, out := runHealthCommand(t, nil, "--listen", "127.0.0.1:"+port)
		if code != 0 || out != healthy {
			t.Fatalf("exit %d, output %q; want 0 and %q", code, out, healthy)
		}
	})
	t.Run("it neither needs nor prints the token", func(t *testing.T) {
		_, out := runHealthCommand(t, nil, "--listen", ":"+port)
		if strings.Contains(out, token) || strings.Contains(out, "ftd_") {
			t.Fatalf("the health command printed a token: %q", out)
		}
	})
	t.Run("nothing listens", func(t *testing.T) {
		idle := freePort(t)
		code, out := runHealthCommand(t, nil, "--listen", "127.0.0.1:"+idle)
		want := "unhealthy: http://127.0.0.1:" + idle + "/api/health: "
		if code != 1 || !strings.HasPrefix(out, want) || strings.Count(out, "\n") != 1 {
			t.Fatalf("exit %d, output %q; want 1 and one line starting %q", code, out, want)
		}
	})
	t.Run("a mistyped flag is unhealthy, not a usage status, in one line", func(t *testing.T) {
		// Docker reserves exit status 2 of a health check command, and
		// keeps the output in the container's health log.
		code, out := runHealthCommand(t, nil, "--no-such-flag")
		if code != 1 || strings.Count(out, "\n") != 1 || !strings.Contains(out, "no-such-flag") {
			t.Fatalf("exit %d, output %q; want 1 and one line naming the flag", code, out)
		}
	})

	// The instance goes away: the same command now fails.
	if err := c.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	err := <-c.done
	c.done <- err
	code, out := runHealthCommand(t, nil, "--listen", "0.0.0.0:"+port)
	want := "unhealthy: http://127.0.0.1:" + port + "/api/health: "
	if code != 1 || !strings.HasPrefix(out, want) {
		t.Fatalf("after the instance ended: exit %d, output %q; want 1 and a line starting %q", code, out, want)
	}
}
