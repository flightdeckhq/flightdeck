package connect

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/flightdeckhq/flightdeck/internal/datadir"
)

// The exit statuses of `flightdeck connect`.
const (
	// ExitOK: connected, removed, nothing to do, or the listing.
	ExitOK = 0
	// ExitFailed: a step failed or timed out, or the question was
	// answered no.
	ExitFailed = 1
	// ExitUsage: an unknown agent or flag, a server or token refused.
	ExitUsage = 2
	// ExitNotFound: the agent is not on this machine.
	ExitNotFound = 3
	// ExitNeedsConfirmation: the plan carries a caution that only a yes
	// on a terminal accepts. --dry-run reports it with this status (the
	// installers' signal not to ask), and a connect refuses with it under
	// --yes or without a terminal.
	ExitNeedsConfirmation = 4
)

// The states `--detected` prints.
const (
	stateConnected    = "connected"
	stateNotConnected = "not-connected"
)

// IO is what one run of the command reads and writes.
type IO struct {
	// Registry is the connectors the command knows.
	Registry Registry
	// Getenv reads a variable ("" when unset): FLIGHTDECK_TOKEN.
	Getenv func(string) string
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
	// Interactive is true when stdin and stdout are a terminal: the
	// command then asks before it changes anything, unless --yes.
	Interactive bool
	// Answers reports whether a Flightdeck answers at a server on this
	// machine; nil is the health check of the binary (flightdeckAnswers).
	Answers AnswersFunc
}

// Main runs `flightdeck connect` with args (the words after "connect")
// and returns the exit status.
func Main(ctx context.Context, args []string, rt IO) int {
	fs := flag.NewFlagSet("flightdeck connect", flag.ContinueOnError)
	fs.SetOutput(rt.Stderr)
	server := fs.String("server", "", "the Flightdeck server to report to: its URL (https://flightdeck.example.com) or the ingestion URL its start-up block prints")
	tokenFile := fs.String("token-file", "", "a file holding the server's access token (default: $FLIGHTDECK_TOKEN); used with --server")
	port := fs.String("port", "", "short for --server http://localhost:<`port`>: the flightdeck that flightdeck --port <port> runs on this machine")
	dataDir := fs.String("data-dir", "", "the data `dir` of the flightdeck running on this machine, looked in when neither --server nor --port is given "+
		"(default: $FLIGHTDECK_DATA_DIR, else "+datadir.Default()+", as the server uses)")
	remove := fs.Bool("remove", false, "disconnect the agent: remove what connecting it installed")
	var yes bool
	fs.BoolVar(&yes, "yes", false, "do not ask before changing anything")
	fs.BoolVar(&yes, "y", false, "shorthand for --yes")
	detected := fs.Bool("detected", false, "print one line per agent found on this machine: id, connected or not-connected, name, separated by tabs (for scripts)")
	dryRun := fs.Bool("dry-run", false, "print what connecting (or with --remove, disconnecting) would change and what the integration records, and change nothing")
	fs.Usage = func() { usage(rt.Stderr, rt.Registry, fs) }

	// Flags may come before or after the agent's id.
	var positional []string
	rest := args
	for {
		if err := fs.Parse(rest); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return ExitOK
			}
			return ExitUsage
		}
		if fs.NArg() == 0 {
			break
		}
		positional = append(positional, fs.Arg(0))
		rest = fs.Args()[1:]
	}
	given := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { given[f.Name] = true })
	fail := func(format string, a ...any) int {
		_, _ = fmt.Fprintf(rt.Stderr, "flightdeck connect: "+format+"\n", a...)
		return ExitUsage
	}

	if len(positional) > 1 {
		return fail("one agent at a time, got %q; see flightdeck connect --help", strings.Join(positional, " "))
	}
	if *detected {
		if len(positional) > 0 || len(given) > 1 {
			return fail("--detected takes no agent and no other flag")
		}
		printDetected(ctx, rt)
		return ExitOK
	}
	answers := rt.Answers
	if answers == nil {
		answers = flightdeckAnswers
	}
	dir := *dataDir
	switch {
	case given["data-dir"] && strings.TrimSpace(dir) == "":
		return fail("--data-dir is empty; give the data dir the server runs with, or leave it out for the default")
	case !given["data-dir"] && rt.Getenv != nil && rt.Getenv("FLIGHTDECK_DATA_DIR") != "":
		dir = rt.Getenv("FLIGHTDECK_DATA_DIR")
	case !given["data-dir"]:
		dir = datadir.Default()
	}
	if len(positional) == 0 {
		if len(given) > 0 && (len(given) > 1 || !given["data-dir"]) {
			return fail("name the agent: flightdeck connect <agent> [flags]; the agents are %s", strings.Join(rt.Registry.IDs(), ", "))
		}
		printList(ctx, rt, dir, answers)
		return ExitOK
	}
	c, ok := rt.Registry.Lookup(positional[0])
	if !ok {
		return fail("no agent named %q; the agents are %s (flightdeck connect lists them)", positional[0], strings.Join(rt.Registry.IDs(), ", "))
	}
	if *remove {
		if given["server"] || given["port"] || given["token-file"] {
			return fail("--remove takes no --server, --port or --token-file")
		}
		plan, err := c.PlanDisconnect(ctx)
		if err != nil {
			return report(rt, c, err)
		}
		title := "Disconnect " + c.Name() + " from Flightdeck"
		if *dryRun {
			plan.Describe(rt.Stdout, title)
			return dryRunStatus(plan)
		}
		if len(plan.Steps) > 0 && !rt.Interactive && !yes {
			// Removing is not what a script that installs runs by
			// accident: without a person to ask, it must say --yes.
			_, _ = fmt.Fprintf(rt.Stderr, "flightdeck connect %s --remove: there is no terminal to confirm on, so --remove needs --yes; nothing changed\n", c.ID())
			return ExitUsage
		}
		return run(ctx, rt, c, plan, yes, title, false)
	}

	if given["port"] {
		if given["server"] {
			return fail("--port and --server were both given; --port <port> is short for --server http://localhost:<port>, so give one of them")
		}
		n, err := strconv.Atoi(*port)
		if err != nil || strings.Trim(*port, "0123456789") != "" || n < 1 || n > 65535 {
			return fail("--port takes a port number from 1 to 65535, the one flightdeck serves on: for example --port 4100")
		}
		*server, given["server"] = "http://localhost:"+strconv.Itoa(n), true
	}
	var target Target
	var choice serverChoice
	if given["server"] {
		s, local, err := CheckServer(*server)
		if err != nil {
			return report(rt, c, err)
		}
		target.Server, target.Local = s, local
		if !local && strings.HasPrefix(strings.ToLower(s), "http://") {
			_, _ = fmt.Fprintf(rt.Stderr, "warning: %s is plain http:// and not this machine: the token and the sessions travel unencrypted; use https:// across a network\n", s)
		}
		token, source := "", "FLIGHTDECK_TOKEN"
		if given["token-file"] {
			source = "--token-file"
			if token, err = ReadTokenFile(*tokenFile); err != nil {
				return report(rt, c, err)
			}
			if warning := TokenFileWarning(*tokenFile); warning != "" {
				_, _ = fmt.Fprintln(rt.Stderr, warning)
			}
		} else if rt.Getenv != nil {
			token = strings.TrimSpace(rt.Getenv("FLIGHTDECK_TOKEN"))
		}
		if token != "" {
			if err := CheckToken(token); err != nil {
				return report(rt, c, fmt.Errorf("%s: %w", source, err))
			}
			if token == DevToken && !local {
				return report(rt, c, usageError("%s holds the development token %s, which only a server on this machine accepts; "+
					"give the access token of %s", source, DevToken, s))
			}
			target.Token = token
		}
		choice = idleChoice(ctx, target, target.Server, answers)
	} else if given["token-file"] {
		return fail("--token-file goes with --server: the token belongs to the server it was minted on")
	} else {
		// No server named: the flightdeck running on this machine.
		choice = chooseServer(ctx, c, dir, answers)
		target = choice.target
	}
	plan, err := c.PlanConnect(ctx, target)
	if err != nil {
		return report(rt, c, err)
	}
	choice.annotate(&plan)
	title := "Connect " + c.Name() + " to Flightdeck"
	if *dryRun {
		plan.Describe(rt.Stdout, title)
		return dryRunStatus(plan)
	}
	return run(ctx, rt, c, plan, yes, title, true)
}

// dryRunStatus is --dry-run's exit status: ExitNeedsConfirmation when
// applying the plan needs a person's yes on a terminal, ExitOK otherwise.
func dryRunStatus(plan Plan) int {
	if len(plan.Steps) > 0 && plan.Caution != "" {
		return ExitNeedsConfirmation
	}
	return ExitOK
}

// run asks, when it may, then applies the plan. A plan with a caution
// is applied only after a yes on a terminal: --yes does not count, and
// without a terminal the plan is refused.
func run(ctx context.Context, rt IO, c Connector, plan Plan, yes bool, title string, defaultYes bool) int {
	if len(plan.Steps) > 0 && plan.Caution != "" && (!rt.Interactive || yes) {
		_, _ = fmt.Fprintf(rt.Stderr, "flightdeck connect %s: %s; nothing changed\n", c.ID(), plan.Caution)
		return ExitNeedsConfirmation
	}
	if len(plan.Steps) > 0 && rt.Interactive && !yes {
		plan.Describe(rt.Stdout, title)
		// A caution is answered no unless the person says yes.
		if !ask(rt, defaultYes && plan.Caution == "") {
			_, _ = fmt.Fprintln(rt.Stdout, "Nothing changed.")
			return ExitFailed
		}
	}
	err := plan.Apply(ctx, func(line string) { _, _ = fmt.Fprintln(rt.Stdout, line) })
	if err != nil {
		return report(rt, c, err)
	}
	return ExitOK
}

// ask reads a yes or no from stdin. An empty answer is the default; an
// unreadable one is no.
func ask(rt IO, defaultYes bool) bool {
	prompt := "Continue? [y/N] "
	if defaultYes {
		prompt = "Continue? [Y/n] "
	}
	_, _ = fmt.Fprint(rt.Stdout, prompt)
	line, err := bufio.NewReader(rt.Stdin).ReadString('\n')
	if err != nil && line == "" {
		_, _ = fmt.Fprintln(rt.Stdout)
		return false
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "":
		return defaultYes
	case "y", "yes":
		return true
	default:
		return false
	}
}

// report prints err as one line and returns its exit status.
func report(rt IO, c Connector, err error) int {
	switch {
	case errors.Is(err, ErrNotFound):
		_, _ = fmt.Fprintf(rt.Stderr, "flightdeck connect %s: %s is not on this machine (%s); install it, then run flightdeck connect %s again\n",
			c.ID(), c.Name(), strings.TrimPrefix(err.Error(), ErrNotFound.Error()+": "), c.ID())
		return ExitNotFound
	case errors.Is(err, ErrUsage):
		_, _ = fmt.Fprintf(rt.Stderr, "flightdeck connect %s: %s\n", c.ID(), strings.Replace(err.Error(), ErrUsage.Error()+": ", "", 1))
		return ExitUsage
	default:
		_, _ = fmt.Fprintf(rt.Stderr, "flightdeck connect %s: %v\n", c.ID(), err)
		return ExitFailed
	}
}

// printDetected is the installers' query: one tab-separated line per
// agent found, id, state and name. Fields may be added at the end of a
// line, never reordered.
func printDetected(ctx context.Context, rt IO) {
	for _, c := range rt.Registry {
		det, err := c.Detect(ctx)
		if err != nil || !det.Found {
			continue
		}
		state := stateNotConnected
		if st, err := c.Status(ctx); err == nil && st.Connected() {
			state = stateConnected
		}
		_, _ = fmt.Fprintf(rt.Stdout, "%s\t%s\t%s\n", c.ID(), state, c.Name())
	}
}

// printList is `flightdeck connect` with no agent: every connector, what
// was found and whether it is connected, and for one connected to a
// server on this machine where nothing answers, what to do about it.
func printList(ctx context.Context, rt IO, dataDir string, answers AnswersFunc) {
	w := rt.Stdout
	_, _ = fmt.Fprintln(w, "Coding agents flightdeck connect can connect:")
	for _, c := range rt.Registry {
		_, _ = fmt.Fprintf(w, "\n  %s (%s)\n", c.Name(), c.ID())
		line := func(label, format string, a ...any) {
			_, _ = fmt.Fprintf(w, "    %-14s "+format+"\n", append([]any{label}, a...)...)
		}
		det, err := c.Detect(ctx)
		switch {
		case err != nil:
			line("found", "%s, but it does not answer: %v", det.Path, err)
			continue
		case !det.Found:
			line("not found", "%s; install %s, then run flightdeck connect %s", det.Missing, c.Name(), c.ID())
			continue
		}
		line("found", "%s at %s", det.Version, det.Path)
		st, err := c.Status(ctx)
		switch {
		case err != nil:
			line("status unknown", "%v", err)
		case st.Connected():
			token := "no token saved"
			if st.TokenSaved {
				token = "a token saved"
			}
			line("connected", "plugin %s, reporting to %s, %s", st.Version, describeServer(st.Server), token)
			if note := unansweredNote(ctx, c, st, dataDir, answers); note != "" {
				line("no answer", "%s", note)
			}
		case st.Installed:
			line("turned off", "the plugin is installed but disabled; flightdeck connect %s turns it on", c.ID())
		default:
			line("not connected", "connect it with: flightdeck connect %s", c.ID())
		}
	}
	_, _ = fmt.Fprintln(w, "\nflightdeck connect <agent> connects one, --remove disconnects it; flightdeck connect --help has the flags.")
}

func usage(w io.Writer, reg Registry, fs *flag.FlagSet) {
	agents := make([]string, 0, len(reg))
	for _, c := range reg {
		agents = append(agents, fmt.Sprintf("%s (%s)", c.ID(), c.Name()))
	}
	_, _ = fmt.Fprintf(w, `Usage: flightdeck connect                       list the coding agents and whether each is connected
       flightdeck connect <agent> [flags]        connect one to Flightdeck
       flightdeck connect <agent> --remove       disconnect it
       flightdeck connect --detected             one line per agent found, for scripts

Agents: %s

Without --server, a new connection reports to the flightdeck running on this
machine, found through its data dir (--data-dir, else $FLIGHTDECK_DATA_DIR, else
the server's default), or with none running to the local server (%s, with
the development token). An existing one keeps its server, unless that is an address
on this machine where nothing answers while a flightdeck runs here at another: the
plan then points it there. --port N is short for --server http://localhost:N. With
--server, the token is read from --token-file, else from FLIGHTDECK_TOKEN; no flag
takes the token itself, since a command line is visible to every user of the machine.

On a terminal the command lists what it will change and asks first; --yes skips
that. Without a terminal, connecting goes ahead (a script asked for it) and
--remove needs --yes. A plugin from a marketplace other than
github.com/flightdeckhq/flightdeck is installed only after a yes on a terminal.
--dry-run prints the changes and what the integration records, and changes nothing.

Exit status: 0 connected, removed or nothing to do; 1 a step failed or the answer
was no; 2 a usage error; 3 the agent is not on this machine; 4 the plan needs a yes
on a terminal (--dry-run reports it, and a connect under --yes or without a
terminal refuses with it).

Flags:
`, strings.Join(agents, ", "), DefaultServer)
	fs.PrintDefaults()
}
