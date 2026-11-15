package connect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"sync"
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
)

// The bounds of the `claude` commands.
const (
	// claudeVersionTimeout bounds `claude --version`, which answers in
	// well under a second; ten covers a cold start on a slow disk.
	claudeVersionTimeout = 10 * time.Second
	// claudeLocalTimeout bounds the commands that read or write Claude
	// Code's own files (list, configure, enable, uninstall) and the help
	// commands of the check. They take a second or two, but the CLI may
	// first refresh the account's managed settings over the network.
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
	// The version and the check side by side: each is a process start
	// of the CLI, which takes a second or more on a slow machine.
	var (
		version    string
		versionErr error
		read       = make(chan struct{})
	)
	go func() {
		defer close(read)
		version, versionErr = c.version(ctx, path)
	}()
	lacks, lacksErr := c.lacks(ctx, path)
	<-read
	if versionErr != nil {
		return Detection{Found: true, Path: path}, versionErr
	}
	det := Detection{Found: true, Path: path, Version: version}
	if lacksErr != nil {
		return det, lacksErr
	}
	if len(lacks) > 0 {
		det.Outdated = fmt.Sprintf("this version has no %s, which flightdeck connect needs: %s", strings.Join(lacks, " and no "), outdatedAdvice)
	}
	return det, nil
}

// version runs `claude --version` and returns the first line it printed,
// without control characters: it is printed in the listing and messages.
func (c *ClaudeCode) version(ctx context.Context, path string) (string, error) {
	stdout, stderr, err := c.run(ctx, claudeVersionTimeout, nil, path, "--version")
	if err != nil {
		return "", stepError("claude --version", claudeVersionTimeout, stdout, stderr, err, "")
	}
	return printable(firstLine(string(stdout))), nil
}

// fail describes a failed `claude` command as stepError does. A command
// the CLI refused as unknown is an ErrOutdated instead, naming the
// version, read now (only this path needs it), and what to do (advice):
// running it again would fail the same way.
func (c *ClaudeCode) fail(ctx context.Context, path, advice, step string, timeout time.Duration, stdout, stderr []byte, err error, secret string) error {
	described := stepError(step, timeout, stdout, stderr, err, secret)
	if errors.Is(err, ErrTimeout) || !refused(stderr) {
		return described
	}
	version, _ := c.version(ctx, path) // "" names it "this Claude Code"
	return fmt.Errorf("%w: %v, so %s is too old for flightdeck connect: %s", ErrOutdated, described, namedVersion(version), advice)
}

// claudeNeed is a command the connector runs that older Claude Code
// versions lack, and how to tell: the options the command's own help
// must name.
type claudeNeed struct {
	// help is the help command: it carries no value and changes nothing.
	help []string
	// options are what the help must name.
	options []string
	// lacks names what is missing when it does not, for the message.
	lacks string
}

// claudeNeeds is what connecting needs of `claude` beyond the commands
// every version with plugins has (plugin list, install, enable and
// uninstall with --json): reading and saving the plugin's options, and
// adding the marketplace with a result line. Claude Code 2.1.283 has
// neither; it answers `plugin configure --help` with the help of
// `claude plugin`, with exit status 0.
var claudeNeeds = []claudeNeed{
	{help: []string{"plugin", "configure", "--help"}, options: []string{"--values-stdin", "--json"}, lacks: "`claude plugin configure`"},
	{help: []string{"plugin", "marketplace", "add", "--help"}, options: []string{"--json"}, lacks: "--json on `claude plugin marketplace add`"},
}

// outdatedAdvice is what to do with a Claude Code too old to connect:
// update it, or install the plugin from inside it as the README shows.
var outdatedAdvice = fmt.Sprintf("update it with `claude update`, then run flightdeck connect %s again; "+
	"or install the plugin from inside Claude Code: /plugin marketplace add %s, then /plugin install %s",
	claudeCodeID, marketplaceSource, pluginID)

// turnOnAdvice is what to do with a Claude Code too old to connect whose
// plugin is installed (from inside it) and turned off: turn it on there,
// which needs no command it lacks, or update it.
var turnOnAdvice = fmt.Sprintf("turn the plugin on from inside Claude Code with /plugin; "+
	"or update it with `claude update`, then run flightdeck connect %s again", claudeCodeID)

// removeAdvice is what to do when a disconnect meets a Claude Code too
// old for the commands it runs: update it, or uninstall the plugin from
// inside it.
var removeAdvice = fmt.Sprintf("update it with `claude update`, then run flightdeck connect %s --remove again; "+
	"or uninstall the plugin from inside Claude Code with /plugin", claudeCodeID)

// The lines the check and the failures are read by: a help's first
// line, and Claude Code's argument parser's refusal of a command or an
// option it does not know (on stderr, exit status 1, before anything
// runs).
const (
	helpUsagePrefix      = "usage:"
	refusedCommandPrefix = "error: unknown command '"
	refusedOptionPrefix  = "error: unknown option '"
)

// ansiCSI matches a terminal colour sequence (SGR), which a CLI may put
// around a help's words; the check reads the help without them.
var ansiCSI = regexp.MustCompile("\x1b\\[[0-9;]*m")

// lacks reads the help of each command in claudeNeeds and returns what
// this `claude` is missing; none means it can be connected. It asks the
// CLI rather than comparing a version number, and caches nothing. A help
// that names the options is enough, whatever else it prints; one that is
// a help (a Usage: line) and does not name them, or a CLI that refuses
// the help command as unknown, is missing them; a help command that
// fails otherwise, times out or prints no help is an error: the check
// does not guess either way. The help commands run side by side under
// one budget, claudeLocalTimeout for the whole check, so a CLI that
// hangs costs one timeout and not one per command; each runs through
// the RunFunc, whose timeout ends its whole process tree.
func (c *ClaudeCode) lacks(ctx context.Context, path string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, claudeLocalTimeout)
	defer cancel()
	type answer struct {
		lacks bool
		err   error
	}
	answers := make([]answer, len(claudeNeeds))
	var wg sync.WaitGroup
	for i, need := range claudeNeeds {
		wg.Go(func() {
			lacks, err := c.lacksOne(ctx, path, need)
			answers[i] = answer{lacks, err}
		})
	}
	wg.Wait()
	var lacks []string
	for i, a := range answers {
		if a.err != nil {
			return nil, a.err
		}
		if a.lacks {
			lacks = append(lacks, claudeNeeds[i].lacks)
		}
	}
	return lacks, nil
}

// lacksOne reads one need's help: whether this `claude` lacks it.
func (c *ClaudeCode) lacksOne(ctx context.Context, path string, need claudeNeed) (bool, error) {
	step := "claude " + strings.Join(need.help, " ")
	stdout, stderr, err := c.run(ctx, claudeLocalTimeout, nil, path, need.help...)
	help := ansiCSI.ReplaceAllString(string(stdout)+"\n"+string(stderr), "")
	switch {
	case err != nil && !errors.Is(err, ErrTimeout) && refused(stderr):
		return true, nil
	case err != nil:
		return false, stepError(step, claudeLocalTimeout, stdout, stderr, err, "")
	case namesAll(help, need.options):
		return false, nil
	case isHelp(help):
		return true, nil
	default:
		return false, fmt.Errorf("`%s` printed no help this command can read", step)
	}
}

// namesAll reports whether help names every option: as a word of its
// own, with any punctuation around it ("--json," "(--json)").
func namesAll(help string, options []string) bool {
	named := map[string]bool{}
	for _, word := range strings.Fields(help) {
		named[strings.Trim(word, ",;:.()[]<>'\"`")] = true
	}
	for _, option := range options {
		if !named[option] {
			return false
		}
	}
	return true
}

// isHelp reports whether text is a command's help: it has a Usage: line.
func isHelp(text string) bool {
	for line := range strings.SplitSeq(text, "\n") {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(line)), helpUsagePrefix) {
			return true
		}
	}
	return false
}

// refused reports whether the CLI refused its command line: the line
// Claude Code's argument parser writes on stderr for a command or an
// option it does not know (exit status 1), before running anything.
func refused(stderr []byte) bool {
	for line := range strings.SplitSeq(ansiCSI.ReplaceAllString(string(stderr), ""), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, refusedCommandPrefix) || strings.HasPrefix(line, refusedOptionPrefix) {
			return true
		}
	}
	return false
}

// outdatedError is the refusal to plan a connect on a Claude Code that
// lacks what connecting needs, with what to do (advice).
func outdatedError(version string, lacks []string, advice string) error {
	return fmt.Errorf("%w: %s is too old for flightdeck connect (it has no %s), so nothing changed: %s",
		ErrOutdated, namedVersion(version), strings.Join(lacks, " and no "), advice)
}

// namedVersion names the Claude Code a message is about: "Claude Code
// 2.1.283" from the version line "2.1.283 (Claude Code)".
func namedVersion(version string) string {
	if fields := strings.Fields(version); len(fields) > 0 {
		return claudeCodeName + " " + printable(fields[0])
	}
	return "this " + claudeCodeName
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

// Status implements Connector. On a Claude Code too old to have `claude
// plugin configure` (an outdated one) it reports the plugin from `claude
// plugin list --json`, which such a version has, with ServerUnknown: a
// plugin installed from inside Claude Code is connected all the same.
func (c *ClaudeCode) Status(ctx context.Context) (Status, error) {
	path, err := c.cli()
	if err != nil {
		return Status{}, err
	}
	plugin, found, err := c.installed(ctx, path, outdatedAdvice)
	if err != nil || !found {
		return Status{}, err
	}
	return c.options(ctx, path, plugin, true)
}

// installed returns the flightdeck plugin's entry of `claude plugin list
// --json` in user scope, and whether there is one. advice is what a
// refusal of the command says to do.
func (c *ClaudeCode) installed(ctx context.Context, path, advice string) (installedPlugin, bool, error) {
	stdout, stderr, err := c.run(ctx, claudeLocalTimeout, nil, path, "plugin", "list", "--json")
	if err != nil {
		return installedPlugin{}, false, c.fail(ctx, path, advice, "claude plugin list --json", claudeLocalTimeout, stdout, stderr, err, "")
	}
	var plugins []installedPlugin
	if err := json.Unmarshal(stdout, &plugins); err != nil {
		return installedPlugin{}, false, fmt.Errorf("`claude plugin list --json` printed no plugin list this command can read: %v", err)
	}
	i := slices.IndexFunc(plugins, func(p installedPlugin) bool { return p.ID == pluginID && p.Scope == pluginScope })
	if i < 0 {
		return installedPlugin{}, false, nil
	}
	return plugins[i], true, nil
}

// options is the status of the installed plugin, with its saved options
// from `claude plugin configure <id> --json`. A CLI that refuses that
// command (an outdated Claude Code) gives a status with ServerUnknown
// when unreadable is true, and an ErrOutdated otherwise.
func (c *ClaudeCode) options(ctx context.Context, path string, plugin installedPlugin, unreadable bool) (Status, error) {
	st := Status{Installed: true, Enabled: plugin.Enabled, Version: printable(plugin.Version)}
	stdout, stderr, err := c.run(ctx, claudeLocalTimeout, nil, path, "plugin", "configure", pluginID, "--json")
	if err != nil {
		if unreadable && !errors.Is(err, ErrTimeout) && refused(stderr) {
			st.ServerUnknown = true
			return st, nil
		}
		return Status{}, c.fail(ctx, path, outdatedAdvice, "claude plugin configure "+pluginID+" --json", claudeLocalTimeout, stdout, stderr, err, "")
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
	// The check, and beside it the plugin list, which every version with
	// plugins has: each starts the CLI, and the help commands write
	// nothing, so the list never runs beside another command that may
	// write Claude Code's files. Nothing else is read before the check
	// passes: an older Claude Code would refuse the options read and the
	// steps alike.
	var (
		plugin  installedPlugin
		found   bool
		listErr error
		listed  = make(chan struct{})
	)
	go func() {
		defer close(listed)
		plugin, found, listErr = c.installed(ctx, path, outdatedAdvice)
	}()
	lacks, err := c.lacks(ctx, path)
	<-listed
	if err != nil {
		return Plan{}, err
	}
	if len(lacks) > 0 {
		// The version only names it in the message; one that cannot be
		// read is "this Claude Code".
		version, _ := c.version(ctx, path)
		connected := listErr == nil && found && plugin.Enabled
		switch {
		case connected && target.Server == "":
			// Installed and turned on from inside Claude Code, and nothing
			// asked that needs what it lacks: connected, nothing to do.
			return Plan{Unchanged: fmt.Sprintf("%s is already connected to Flightdeck: the %s plugin %s is installed and turned on "+
				"from inside Claude Code; nothing changed. This version cannot show or change the server the plugin reports to: "+
				"update it with `claude update` to see or change it.", namedVersion(version), pluginName, printable(plugin.Version))}, nil
		case connected:
			return Plan{}, fmt.Errorf("%w: %s is connected from inside it, but too old to change the server the plugin reports to "+
				"(it has no %s), so nothing changed: update it with `claude update`, then run this command again",
				ErrOutdated, namedVersion(version), strings.Join(lacks, " and no "))
		case listErr == nil && found:
			return Plan{}, outdatedError(version, lacks, turnOnAdvice)
		}
		return Plan{}, outdatedError(version, lacks, outdatedAdvice)
	}
	if listErr != nil {
		return Plan{}, listErr
	}
	var st Status
	if found {
		if st, err = c.options(ctx, path, plugin, false); err != nil {
			return Plan{}, err
		}
	}
	if target.Server == "" && target.Choose != nil {
		target = target.Choose(ctx, st)
	}
	sameAsSaved := target.Server == "" || sameServer(target.Server, st.Server)
	keepsToken := st.TokenSaved && sameAsSaved
	if target.Server != "" && !target.Local && target.Token == "" && !keepsToken {
		return Plan{}, usageError("%s is not on this machine, so it needs an access token (the dashboard's Settings > Access tokens, "+
			"or the one the server printed at its first start): give it with --token-file PATH or FLIGHTDECK_TOKEN", target.Server)
	}

	var steps []Step
	caution := ""
	installFrom := "github.com/" + marketplaceSource
	if !st.Installed {
		declared, source, err := c.marketplaceDeclared(ctx, path)
		if err != nil {
			return Plan{}, err
		}
		if declared && source != "" {
			// A marketplace of that name from somewhere else (a local
			// checkout, a fork) would supply the plugin: the user decides,
			// on a terminal, and no --yes or script decides for them.
			installFrom = fmt.Sprintf("the %s marketplace Claude Code already has, which comes from %s", marketplaceName, source)
			caution = fmt.Sprintf("Claude Code's %s marketplace comes from %s, not github.com/%s, and the plugin would be installed from it. "+
				"Confirm it on a terminal without --yes, or install it yourself: claude plugin install %s --scope %s",
				marketplaceName, source, marketplaceSource, pluginID, pluginScope)
		}
		if !declared {
			steps = append(steps, Step{
				Summary: fmt.Sprintf("add the %s marketplace (github.com/%s) to Claude Code", marketplaceName, marketplaceSource),
				Run: func(ctx context.Context) (string, error) {
					if err := c.change(ctx, path, outdatedAdvice, claudeCloneTimeout, nil, "", "plugin", "marketplace", "add", marketplaceSource, "--json"); err != nil {
						return "", err
					}
					return fmt.Sprintf("Added the %s marketplace to Claude Code.", marketplaceName), nil
				},
			})
		}
		steps = append(steps, Step{
			Summary: fmt.Sprintf("install the %s plugin for your user from %s", pluginName, installFrom),
			Run: func(ctx context.Context) (string, error) {
				if err := c.change(ctx, path, outdatedAdvice, claudeCloneTimeout, nil, "", "plugin", "install", pluginID, "--scope", pluginScope, "--json"); err != nil {
					return "", err
				}
				return fmt.Sprintf("Installed the %s plugin for your user.", pluginName), nil
			},
		})
	} else if !st.Enabled {
		steps = append(steps, Step{
			Summary: fmt.Sprintf("turn the installed %s plugin back on", pluginName),
			Run: func(ctx context.Context) (string, error) {
				if err := c.change(ctx, path, outdatedAdvice, claudeLocalTimeout, nil, "", "plugin", "enable", pluginID); err != nil {
					return "", err
				}
				return fmt.Sprintf("Turned the %s plugin on.", pluginName), nil
			},
		})
	}

	values := map[string]string{}
	server := st.Server
	if !sameAsSaved {
		values["server"] = target.Server
		server = target.Server
	}
	switch {
	case target.Token != "":
		values["token"] = target.Token
	case target.Local && st.TokenSaved && !sameAsSaved:
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
	pluginVersion := ""
	if st.Version != "" {
		pluginVersion = " " + st.Version
	}
	return Plan{
		Steps:   steps,
		Caution: caution,
		// What the plugin records by default (plugin/README.md, Privacy):
		// prompt and response content and tool results (capturePrompts)
		// and the sanitised tool inputs (captureToolInputs).
		Notice: fmt.Sprintf("The plugin records your Claude Code sessions, including prompts, responses, tool results and sanitised tool inputs, "+
			"and sends them to %s (FLIGHTDECK_CAPTURE_PROMPTS=false keeps the content back).", where),
		Unchanged: fmt.Sprintf("Claude Code is already connected to Flightdeck (plugin %s%s, reporting to %s); nothing changed. "+
			"Pass --server to change the server.", pluginName, pluginVersion, where),
		Done: fmt.Sprintf("Claude Code is connected: sessions started from now on report to %s; sessions already open report once restarted.",
			where),
	}, nil
}

// PlanDisconnect implements Connector. It needs neither `claude plugin
// configure` nor --json on `marketplace add`, so it runs on a Claude
// Code too old to connect as well: a plugin installed from inside it can
// be removed.
func (c *ClaudeCode) PlanDisconnect(ctx context.Context) (Plan, error) {
	path, err := c.cli()
	if err != nil {
		return Plan{}, err
	}
	_, installed, err := c.installed(ctx, path, removeAdvice)
	if err != nil {
		return Plan{}, err
	}
	plan := Plan{
		Unchanged: fmt.Sprintf("Claude Code has no %s plugin installed for your user; nothing changed.", pluginName),
		Done:      "Claude Code is disconnected: sessions started from now on do not report to Flightdeck.",
	}
	if !installed {
		return plan, nil
	}
	plan.Steps = []Step{{
		Summary: fmt.Sprintf("uninstall the %s plugin with its saved server and token (the %s marketplace stays)", pluginName, marketplaceName),
		Run: func(ctx context.Context) (string, error) {
			if err := c.change(ctx, path, removeAdvice, claudeLocalTimeout, nil, "", "plugin", "uninstall", pluginID, "--scope", pluginScope, "--json"); err != nil {
				return "", err
			}
			return fmt.Sprintf("Uninstalled the %s plugin.", pluginName), nil
		},
	}}
	return plan, nil
}

// marketplaceDeclared reports whether Claude Code has a marketplace
// named flightdeck-plugins and, when it comes from anywhere but this
// repository, describes where from ("" for this repository).
func (c *ClaudeCode) marketplaceDeclared(ctx context.Context, path string) (bool, string, error) {
	stdout, stderr, err := c.run(ctx, claudeLocalTimeout, nil, path, "plugin", "marketplace", "list", "--json")
	if err != nil {
		return false, "", c.fail(ctx, path, outdatedAdvice, "claude plugin marketplace list --json", claudeLocalTimeout, stdout, stderr, err, "")
	}
	var markets []declaredMarketplace
	if err := json.Unmarshal(stdout, &markets); err != nil {
		return false, "", fmt.Errorf("`claude plugin marketplace list --json` printed no marketplace list this command can read: %v", err)
	}
	i := slices.IndexFunc(markets, func(m declaredMarketplace) bool { return m.Name == marketplaceName })
	if i < 0 {
		return false, "", nil
	}
	return true, markets[i].foreignSource(), nil
}

// declaredMarketplace is one entry of `claude plugin marketplace list
// --json`: its name and where it comes from, in the shape Claude Code
// prints for each kind (github + repo, git + url, directory + path).
type declaredMarketplace struct {
	Name   string `json:"name"`
	Source string `json:"source"`
	Repo   string `json:"repo"`
	URL    string `json:"url"`
	Path   string `json:"path"`
}

// foreignSource returns "" when the marketplace is this repository on
// GitHub (as a GitHub source, or its git URL over HTTPS or SSH), and
// otherwise a description of where it comes from.
func (m declaredMarketplace) foreignSource() string {
	ours := func(location string) bool {
		l := strings.ToLower(strings.TrimSpace(location))
		l = strings.TrimSuffix(strings.TrimSuffix(l, "/"), ".git")
		for _, prefix := range []string{"https://github.com/", "ssh://git@github.com/", "git@github.com:", ""} {
			if rest, ok := strings.CutPrefix(l, prefix); ok && rest == marketplaceSource {
				return true
			}
		}
		return false
	}
	switch m.Source {
	case "github":
		if ours(m.Repo) {
			return ""
		}
		return "the GitHub repository " + printable(m.Repo)
	case "git":
		if ours(m.URL) {
			return ""
		}
		return "the git repository " + printable(m.URL)
	case "directory":
		return "the local directory " + printable(m.Path)
	}
	where := printable(m.Source)
	for _, location := range []string{m.Repo, m.URL, m.Path} {
		if location != "" {
			where += " " + printable(location)
			break
		}
	}
	if where == "" {
		where = "an unnamed source"
	}
	return "a " + where + " source"
}

// change runs a `claude plugin` command that changes something and
// requires it to succeed: exit status 0 and, when it printed a --json
// result line, an "ok" outcome. secret, when set, is cut from any
// message the CLI printed.
func (c *ClaudeCode) change(ctx context.Context, path, advice string, timeout time.Duration, stdin []byte, secret string, args ...string) error {
	stdout, stderr, err := c.run(ctx, timeout, stdin, path, args...)
	step := "claude " + strings.Join(args, " ")
	if err != nil {
		return c.fail(ctx, path, advice, step, timeout, stdout, stderr, err, secret)
	}
	if result, ok := resultLine(stdout); ok && result.Outcome != "" && result.Outcome != "ok" {
		return c.fail(ctx, path, advice, step, timeout, stdout, stderr, fmt.Errorf("outcome %q", result.Outcome), secret)
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
		return c.fail(ctx, path, outdatedAdvice, step, claudeLocalTimeout, stdout, stderr, err, values["token"])
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
		return "the local server at " + DefaultServer
	}
	return printable(server)
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
// line it wrote on stderr). secret, when set, never appears in it, and
// neither do the reason's colour sequences or control characters.
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
	return fmt.Errorf("`%s` failed: %s", step, printable(ansiCSI.ReplaceAllString(reason, "")))
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
