package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// The Claude Code plugin against the real binary. The start-up block
// tells the user one value for FLIGHTDECK_SERVER, "for the sensor and
// the plugin"; this runs the plugin's hook entry point (plugin/hooks/
// scripts/observe_cli.mjs, the process Claude Code starts for every
// hook) with that printed value and with the other forms of the same
// address, and requires the session to be stored each time. A stub
// server cannot stand in here: it would accept whatever path and body
// the plugin sent.

// hookTimeout bounds one run of the plugin's hook process. The
// SessionStart hook's own timeout in plugin/hooks/hooks.json is thirty
// seconds, after which Claude Code would cancel it; a run that takes
// longer has failed either way.
const hookTimeout = 30 * time.Second

// ingestionLine matches the start-up block's line that names the value
// of FLIGHTDECK_SERVER.
var ingestionLine = regexp.MustCompile(`(?m)^\s*Ingestion\s+(\S+)\s+\(FLIGHTDECK_SERVER for the sensor and the plugin\)\s*$`)

// nodeOrSkip returns the node executable. The plugin needs Node; a
// developer machine without it skips the test, CI must have it.
func nodeOrSkip(t *testing.T) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		if os.Getenv("CI") != "" {
			t.Fatalf("node is not on PATH; the plugin's test against the binary must run in CI: %v", err)
		}
		t.Skip("node is not on PATH; the plugin's hooks need it")
	}
	return node
}

// hookResult is what one run of the plugin's hook process left.
type hookResult struct {
	stdout, stderr string
	err            error
}

// runSessionStartHook runs the plugin's hook entry point for a
// SessionStart event, as Claude Code does, with server and token as its
// configuration and sessionID as the Flightdeck session to report.
func runSessionStartHook(t *testing.T, node, server, token, sessionID string) hookResult {
	t.Helper()
	script, err := filepath.Abs(filepath.Join("..", "..", "plugin", "hooks", "scripts", "observe_cli.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	event, err := json.Marshal(map[string]string{
		"hook_event_name": "SessionStart",
		"session_id":      "claude-" + sessionID,
		"cwd":             work,
		"source":          "startup",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), hookTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, node, script)
	cmd.Dir = work
	cmd.Stdin = bytes.NewReader(event)
	// The hook's own environment: nothing of the developer's Claude Code
	// session or Flightdeck settings, a state directory and a home of
	// its own (the plugin reads ~/.claude.json for MCP servers).
	env := []string{
		"FLIGHTDECK_SERVER=" + server,
		"FLIGHTDECK_TOKEN=" + token,
		"CLAUDE_SESSION_ID=" + sessionID,
		"CLAUDE_PLUGIN_DATA=" + filepath.Join(work, "plugin-data"),
		"HOME=" + work,
		"USERPROFILE=" + work,
	}
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		switch {
		case strings.HasPrefix(name, "FLIGHTDECK_"), strings.HasPrefix(name, "CLAUDE"),
			name == "HOME", name == "USERPROFILE":
		default:
			env = append(env, kv)
		}
	}
	cmd.Env = env
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err = cmd.Run()
	return hookResult{stdout: stdout.String(), stderr: stderr.String(), err: err}
}

func TestBinary_ThePluginStoresASessionWithEveryFormOfTheServerAddress(t *testing.T) {
	node := nodeOrSkip(t)
	port := freePort(t)
	c := start(t, "127.0.0.1:"+port, port, filepath.Join(tempDir(t), "data"))

	// One event through ingestion first, by a client with no deadline
	// of its own. The plugin gives a POST two seconds, and the first
	// event an instance takes is its slowest: the token is looked up,
	// the session is attached and the stream takes its first message
	// with nothing cached. A race-built child on a loaded CI runner
	// spends more than those two seconds on it; the later ones take
	// milliseconds. The plugin's own answer to a slow first POST is the
	// next hook, which sends the session_start again.
	warm := newUUID(t)
	c.postEvent(t, "tok_dev", warm, newUUID(t), "plugin-test-warm-up", "session_start")
	waitFor(t, "the warm-up session is stored", storeTimeout, func() bool {
		return c.get(t, "/api/v1/sessions/"+warm, "tok_dev", nil) == http.StatusOK
	})

	printed := ingestionLine.FindStringSubmatch(c.out.String())
	if printed == nil {
		t.Fatalf("the start-up block has no Ingestion line naming FLIGHTDECK_SERVER:\n%s", c.out.String())
	}
	forms := []struct{ name, server string }{
		{"the value the start-up block prints", printed[1]},
		{"the ingestion URL", c.base + "/ingest"},
		{"the ingestion URL with a trailing slash", c.base + "/ingest/"},
		{"the base URL", c.base},
		{"the base URL with a trailing slash", c.base + "/"},
	}
	for _, form := range forms {
		t.Run(form.name, func(t *testing.T) {
			sessionID := newUUID(t)
			got := runSessionStartHook(t, node, form.server, "tok_dev", sessionID)
			if got.err != nil {
				t.Fatalf("FLIGHTDECK_SERVER=%s: the hook failed: %v\nstderr: %s", form.server, got.err, got.stderr)
			}
			if strings.Contains(got.stderr, "cannot reach") {
				t.Fatalf("FLIGHTDECK_SERVER=%s: the hook's POST was not accepted: %s", form.server, got.stderr)
			}
			if got.stdout != "" {
				t.Errorf("FLIGHTDECK_SERVER=%s: an accepted session start printed %q", form.server, got.stdout)
			}
			var session struct {
				Session struct {
					SessionID  string `json:"session_id"`
					ClientType string `json:"client_type"`
					AgentType  string `json:"agent_type"`
				} `json:"session"`
			}
			waitFor(t, "the plugin's session is stored (FLIGHTDECK_SERVER="+form.server+")", storeTimeout, func() bool {
				return c.get(t, "/api/v1/sessions/"+sessionID, "tok_dev", &session) == http.StatusOK
			})
			if session.Session.SessionID != sessionID || session.Session.ClientType != "claude_code" || session.Session.AgentType != "coding" {
				t.Errorf("FLIGHTDECK_SERVER=%s: stored session = %+v, want %s as a claude_code coding session", form.server, session.Session, sessionID)
			}
		})
	}

	t.Run("an address with no ingestion API is reported to the user", func(t *testing.T) {
		sessionID := newUUID(t)
		server := c.base + "/not-flightdeck"
		got := runSessionStartHook(t, node, server, "tok_dev", sessionID)
		if got.err != nil {
			t.Fatalf("the hook must exit 0 whatever the server answers (it fails open): %v\nstderr: %s", got.err, got.stderr)
		}
		var output struct {
			SystemMessage string `json:"systemMessage"`
		}
		if err := json.Unmarshal([]byte(got.stdout), &output); err != nil {
			t.Fatalf("the hook's stdout is not one JSON object: %v\nstdout: %q\nstderr: %s", err, got.stdout, got.stderr)
		}
		want := "Flightdeck: " + server + " has no ingestion API at " + server + "/ingest/v1/events"
		if !strings.HasPrefix(output.SystemMessage, want) {
			t.Errorf("systemMessage = %q, want it to start with %q", output.SystemMessage, want)
		}
		if !strings.Contains(got.stderr, "[flightdeck] cannot reach "+server+": HTTP ") {
			t.Errorf("stderr does not carry the failed-POST line: %q", got.stderr)
		}
		if code := c.get(t, "/api/v1/sessions/"+sessionID, "tok_dev", nil); code != http.StatusNotFound {
			t.Errorf("GET the session answered %d, want 404: nothing was posted to the ingestion API", code)
		}
	})

	t.Run("a refused token is reported without the token", func(t *testing.T) {
		const wrongToken = "ftd_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
		got := runSessionStartHook(t, node, c.base+"/ingest", wrongToken, newUUID(t))
		if got.err != nil {
			t.Fatalf("the hook must exit 0 (it fails open): %v\nstderr: %s", got.err, got.stderr)
		}
		if !strings.Contains(got.stdout, "refused the access token (HTTP 401)") {
			t.Errorf("stdout does not report the refused token: %q", got.stdout)
		}
		if strings.Contains(got.stdout, wrongToken) || strings.Contains(got.stderr, wrongToken) {
			t.Errorf("the token appears in the hook's output:\nstdout: %s\nstderr: %s", got.stdout, got.stderr)
		}
	})
}
