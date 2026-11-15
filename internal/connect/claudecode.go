package connect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

// The Claude Code connector drives the `claude` CLI: the plugin comes
// from the marketplace this repository publishes, and the server and
// token are the plugin's userConfig options.
const (
	claudeCodeID   = "claude-code"
	claudeCodeName = "Claude Code"
	// claudeCommand is the CLI's name; exec.LookPath finds claude.exe or
	// claude.cmd through PATHEXT on Windows.
	claudeCommand = "claude"
	// marketplaceName is the name .claude-plugin/marketplace.json
	// declares, and marketplaceSource the repository Claude Code clones
	// it from.
	marketplaceName   = "flightdeck-plugins"
	marketplaceSource = "flightdeckhq/flightdeck"
	pluginName        = "flightdeck"
	pluginID          = pluginName + "@" + marketplaceName
	// pluginScope is where the plugin is installed: for the user, so
	// every project's sessions report.
	pluginScope = "user"
	// defaultServer is where the plugin reports with no server saved.
	defaultServer = "http://localhost:4000"
)

// The bounds of the `claude` commands.
const (
	// claudeVersionTimeout bounds `claude --version`, which answers in
	// well under a second; ten covers a cold start on a slow disk.
	claudeVersionTimeout = 10 * time.Second
	// claudeLocalTimeout bounds the commands that read or write Claude
	// Code's own files (list, configure, enable, uninstall). They take a
	// second or two, but the CLI may first refresh the account's managed
	// settings over the network.
	claudeLocalTimeout = 30 * time.Second
	// claudeCloneTimeout bounds the two commands that clone the
	// repository (marketplace add, install). Claude Code bounds its own
	// clone at 120 seconds and reports why it failed; this is above it so
	// that message is the one the user sees, and only a CLI that hangs
	// meets this one.
	claudeCloneTimeout = 180 * time.Second
)

// ClaudeCode is the Claude Code connector.
type ClaudeCode struct {
	lookPath func(string) (string, error)
	run      RunFunc
}

// NewClaudeCode returns the connector, finding `claude` with lookPath
// and running it with run.
func NewClaudeCode(lookPath func(string) (string, error), run RunFunc) *ClaudeCode {
	return &ClaudeCode{lookPath: lookPath, run: run}
}

// ID implements Connector.
func (c *ClaudeCode) ID() string { return claudeCodeID }

// Name implements Connector.
func (c *ClaudeCode) Name() string { return claudeCodeName }

// Detect implements Connector.
func (c *ClaudeCode) Detect(ctx context.Context) (Detection, error) {
	path, err := c.lookPath(claudeCommand)
	if err != nil {
		return Detection{Missing: "no " + claudeCommand + " command on PATH"}, nil
	}
	stdout, stderr, err := c.run(ctx, claudeVersionTimeout, nil, path, "--version")
	if err != nil {
		return Detection{Found: true, Path: path}, stepError("claude --version", claudeVersionTimeout, stdout, stderr, err, "")
	}
	return Detection{Found: true, Path: path, Version: firstLine(string(stdout))}, nil
}

// installedPlugin is one entry of `claude plugin list --json`.
type installedPlugin struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Scope   string `json:"scope"`
	Enabled bool   `json:"enabled"`
}

// pluginOptions is `claude plugin configure <id> --json`: the values of
// the options that are not sensitive, and which options are saved.
type pluginOptions struct {
	Inputs     map[string]string `json:"inputs"`
	Configured []string          `json:"configured"`
}

// cliResult is the one result line a `--json` change command prints.
type cliResult struct {
	Outcome string `json:"outcome"`
	Message string `json:"message"`
}

// Status implements Connector.
func (c *ClaudeCode) Status(ctx context.Context) (Status, error) {
	path, err := c.cli()
	if err != nil {
		return Status{}, err
	}
	return c.status(ctx, path)
}

func (c *ClaudeCode) status(ctx context.Context, path string) (Status, error) {
	stdout, stderr, err := c.run(ctx, claudeLocalTimeout, nil, path, "plugin", "list", "--json")
	if err != nil {
		return Status{}, stepError("claude plugin list --json", claudeLocalTimeout, stdout, stderr, err, "")
	}
	var plugins []installedPlugin
	if err := json.Unmarshal(stdout, &plugins); err != nil {
		return Status{}, fmt.Errorf("`claude plugin list --json` printed no plugin list this command can read: %v", err)
	}
	i := slices.IndexFunc(plugins, func(p installedPlugin) bool { return p.ID == pluginID && p.Scope == pluginScope })
	if i < 0 {
		return Status{}, nil
	}
	st := Status{Installed: true, Enabled: plugins[i].Enabled, Version: plugins[i].Version}
	stdout, stderr, err = c.run(ctx, claudeLocalTimeout, nil, path, "plugin", "configure", pluginID, "--json")
	if err != nil {
		return Status{}, stepError("claude plugin configure "+pluginID+" --json", claudeLocalTimeout, stdout, stderr, err, "")
	}
	var opts pluginOptions
	if err := json.Unmarshal(stdout, &opts); err != nil {
		return Status{}, fmt.Errorf("`claude plugin configure %s --json` printed no options this command can read: %v", pluginID, err)
	}
	st.Server = strings.TrimSpace(opts.Inputs["server"])
	st.TokenSaved = slices.Contains(opts.Configured, "token")
	return st, nil
}

// cli finds `claude`, or reports the agent missing.
func (c *ClaudeCode) cli() (string, error) {
	path, err := c.lookPath(claudeCommand)
	if err != nil {
		return "", fmt.Errorf("%w: no %s command on PATH", ErrNotFound, claudeCommand)
	}
	return path, nil
}

// PlanConnect implements Connector.
func (c *ClaudeCode) PlanConnect(ctx context.Context, target Target) (Plan, error) {
	path, err := c.cli()
	if err != nil {
		return Plan{}, err
	}
	st, err := c.status(ctx, path)
	if err != nil {
		return Plan{}, err
	}
	keepsToken := st.TokenSaved && st.Server == target.Server
	if target.Server != "" && !target.Local && target.Token == "" && !keepsToken {
		return Plan{}, usageError("%s is not on this machine, so it needs an access token (the dashboard's Settings > Access tokens, "+
			"or the one the server printed at its first start): give it with --token-file PATH or FLIGHTDECK_TOKEN", target.Server)
	}

	var steps []Step
	if !st.Installed {
		declared, err := c.marketplaceDeclared(ctx, path)
		if err != nil {
			return Plan{}, err
		}
		if !declared {
			steps = append(steps, Step{
				Summary: fmt.Sprintf("add the %s marketplace (github.com/%s) to Claude Code", marketplaceName, marketplaceSource),
				Run: func(ctx context.Context) (string, error) {
					if err := c.change(ctx, claudeCloneTimeout, nil, "", path, "plugin", "marketplace", "add", marketplaceSource, "--json"); err != nil {
						return "", err
					}
					return fmt.Sprintf("Added the %s marketplace to Claude Code.", marketplaceName), nil
				},
			})
		}
		steps = append(steps, Step{
			Summary: fmt.Sprintf("install the %s plugin for your user", pluginName),
			Run: func(ctx context.Context) (string, error) {
				if err := c.change(ctx, claudeCloneTimeout, nil, "", path, "plugin", "install", pluginID, "--scope", pluginScope, "--json"); err != nil {
					return "", err
				}
				return fmt.Sprintf("Installed the %s plugin for your user.", pluginName), nil
			},
		})
	} else if !st.Enabled {
		steps = append(steps, Step{
			Summary: fmt.Sprintf("turn the installed %s plugin back on", pluginName),
			Run: func(ctx context.Context) (string, error) {
				if err := c.change(ctx, claudeLocalTimeout, nil, "", path, "plugin", "enable", pluginID); err != nil {
					return "", err
				}
				return fmt.Sprintf("Turned the %s plugin on.", pluginName), nil
			},
		})
	}

	values := map[string]string{}
	server := st.Server
	if target.Server != "" && target.Server != st.Server {
		values["server"] = target.Server
		server = target.Server
	}
	switch {
	case target.Token != "":
		values["token"] = target.Token
	case target.Local && st.TokenSaved && target.Server != st.Server:
		// Claude Code cannot remove a saved token, and the one saved is
		// another server's: the development token takes its place, so it
		// is never sent to whatever listens on this machine.
		values["token"] = DevToken
	}
	if len(values) > 0 {
		summary, line := saveWording(values)
		steps = append(steps, Step{
			Summary: summary,
			Run: func(ctx context.Context) (string, error) {
				if err := c.configure(ctx, path, values); err != nil {
					return "", err
				}
				return line, nil
			},
		})
	}

	where := describeServer(server)
	version := ""
	if st.Version != "" {
		version = " " + st.Version
	}
	return Plan{
		Steps:     steps,
		Unchanged: fmt.Sprintf("Claude Code is already connected to Flightdeck (plugin %s%s, reporting to %s); nothing changed.", pluginName, version, where),
		Done: fmt.Sprintf("Claude Code is connected: sessions started from now on report to %s; sessions already open report once restarted.",
			where),
	}, nil
}

// PlanDisconnect implements Connector.
func (c *ClaudeCode) PlanDisconnect(ctx context.Context) (Plan, error) {
	path, err := c.cli()
	if err != nil {
		return Plan{}, err
	}
	st, err := c.status(ctx, path)
	if err != nil {
		return Plan{}, err
	}
	plan := Plan{
		Unchanged: fmt.Sprintf("Claude Code has no %s plugin installed for your user; nothing changed.", pluginName),
		Done:      "Claude Code is disconnected: sessions started from now on do not report to Flightdeck.",
	}
	if !st.Installed {
		return plan, nil
	}
	plan.Steps = []Step{{
		Summary: fmt.Sprintf("uninstall the %s plugin with its saved server and token (the %s marketplace stays)", pluginName, marketplaceName),
		Run: func(ctx context.Context) (string, error) {
			if err := c.change(ctx, claudeLocalTimeout, nil, "", path, "plugin", "uninstall", pluginID, "--scope", pluginScope, "--json"); err != nil {
				return "", err
			}
			return fmt.Sprintf("Uninstalled the %s plugin.", pluginName), nil
		},
	}}
	return plan, nil
}

// marketplaceDeclared reports whether Claude Code has a marketplace
// named flightdeck-plugins, whatever its source: a contributor's local
// checkout declared under that name is used as it is.
func (c *ClaudeCode) marketplaceDeclared(ctx context.Context, path string) (bool, error) {
	stdout, stderr, err := c.run(ctx, claudeLocalTimeout, nil, path, "plugin", "marketplace", "list", "--json")
	if err != nil {
		return false, stepError("claude plugin marketplace list --json", claudeLocalTimeout, stdout, stderr, err, "")
	}
	var markets []declaredMarketplace
	if err := json.Unmarshal(stdout, &markets); err != nil {
		return false, fmt.Errorf("`claude plugin marketplace list --json` printed no marketplace list this command can read: %v", err)
	}
	return slices.ContainsFunc(markets, func(m declaredMarketplace) bool { return m.Name == marketplaceName }), nil
}

// declaredMarketplace is one entry of `claude plugin marketplace list --json`.
type declaredMarketplace struct {
	Name string `json:"name"`
}

// change runs a `claude plugin` command that changes something and
// requires it to succeed: exit status 0 and, when it printed a --json
// result line, an "ok" outcome. secret, when set, is cut from any
// message the CLI printed.
func (c *ClaudeCode) change(ctx context.Context, timeout time.Duration, stdin []byte, secret, path string, args ...string) error {
	stdout, stderr, err := c.run(ctx, timeout, stdin, path, args...)
	step := "claude " + strings.Join(args, " ")
	if err != nil {
		return stepError(step, timeout, stdout, stderr, err, secret)
	}
	if result, ok := resultLine(stdout); ok && result.Outcome != "" && result.Outcome != "ok" {
		return stepError(step, timeout, stdout, stderr, fmt.Errorf("outcome %q", result.Outcome), secret)
	}
	return nil
}

// configure saves values in the plugin's options. They go on stdin as
// one JSON object, never on the command line, which every user of the
// machine can read.
func (c *ClaudeCode) configure(ctx context.Context, path string, values map[string]string) error {
	body, err := json.Marshal(values)
	if err != nil {
		return err
	}
	args := []string{"plugin", "configure", pluginID, "--values-stdin", "--json"}
	stdout, stderr, err := c.run(ctx, claudeLocalTimeout, body, path, args...)
	step := "claude " + strings.Join(args, " ")
	if err != nil {
		return stepError(step, claudeLocalTimeout, stdout, stderr, err, values["token"])
	}
	var saved struct {
		Saved []string `json:"saved"`
	}
	if err := json.Unmarshal(stdout, &saved); err != nil {
		return fmt.Errorf("`%s` printed no result this command can read: %v", step, err)
	}
	for key := range values {
		if !slices.Contains(saved.Saved, key) {
			return fmt.Errorf("`%s` did not save the %s option", step, key)
		}
	}
	return nil
}

// saveWording says what saving values changes, as a confirmation line
// and as the line reported once it is done. A token is never shown.
func saveWording(values map[string]string) (summary, done string) {
	server, hasServer := values["server"]
	token, hasToken := values["token"]
	switch {
	case hasServer && hasToken && token == DevToken:
		return fmt.Sprintf("save the server %s with the development token in the plugin's options (replacing the token saved for another server)", server),
			fmt.Sprintf("Saved the server %s and the development token in the plugin's options.", server)
	case hasServer && hasToken:
		return fmt.Sprintf("save the server %s and its token in the plugin's options", server),
			fmt.Sprintf("Saved the server %s and its token in the plugin's options.", server)
	case hasServer:
		return fmt.Sprintf("save the server %s in the plugin's options", server),
			fmt.Sprintf("Saved the server %s in the plugin's options.", server)
	default:
		return "save the token in the plugin's options", "Saved the token in the plugin's options."
	}
}

// describeServer names the server the plugin reports to.
func describeServer(server string) string {
	if server == "" {
		return "the local server at " + defaultServer
	}
	return server
}

// resultLine returns the last line of stdout that is a JSON object: the
// result a `--json` change command prints after any progress text.
func resultLine(stdout []byte) (cliResult, bool) {
	lines := strings.Split(strings.TrimSpace(string(stdout)), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var r cliResult
		if json.Unmarshal([]byte(line), &r) == nil {
			return r, true
		}
	}
	// A pretty-printed object (configure --json) is the whole output.
	var r cliResult
	if json.Unmarshal(bytes.TrimSpace(stdout), &r) == nil {
		return r, true
	}
	return cliResult{}, false
}

// stepError describes a failed `claude` command in one line: the
// command, and the CLI's own reason (its --json message, else the last
// line it wrote on stderr). secret, when set, never appears in it.
func stepError(step string, timeout time.Duration, stdout, stderr []byte, err error, secret string) error {
	if errors.Is(err, ErrTimeout) {
		return fmt.Errorf("`%s` did not finish within %s and was stopped", step, timeout)
	}
	reason := ""
	if result, ok := resultLine(stdout); ok && result.Message != "" {
		reason = lastLine(result.Message)
	}
	if reason == "" {
		reason = lastLine(string(stderr))
	}
	if reason == "" {
		reason = err.Error()
	}
	if secret != "" {
		reason = strings.ReplaceAll(reason, secret, "[the token]")
	}
	return fmt.Errorf("`%s` failed: %s", step, reason)
}

// firstLine returns the first non-blank line of s, trimmed.
func firstLine(s string) string {
	for line := range strings.SplitSeq(s, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			return line
		}
	}
	return ""
}

// lastLine returns the last non-blank line of s, trimmed.
func lastLine(s string) string {
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			return line
		}
	}
	return ""
}
