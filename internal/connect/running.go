package connect

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/flightdeckhq/flightdeck/internal/datadir"
	"github.com/flightdeckhq/flightdeck/internal/health"
)

// The Flightdeck running on this machine, as `flightdeck connect` finds
// it through the instance file of a data dir, and the rules the command
// and the server's start-up check of the agents share: which server
// values are a server on this machine, which one is a given instance,
// and the commands that point an agent at one or start one.

// AnswersFunc reports whether a Flightdeck answers at server, a server
// value as an agent saves it ("" is DefaultServer).
type AnswersFunc func(ctx context.Context, server string) bool

// flightdeckAnswers is the AnswersFunc of the binary: the check
// `flightdeck health` makes, both health routes answering with their
// service's body, sent only to an http:// server on this machine. Any
// other value is false without a request: a server beyond this machine
// is never probed. The probe carries no token.
func flightdeckAnswers(ctx context.Context, server string) bool {
	target, ok := probeTarget(server)
	if !ok {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, health.Timeout)
	defer cancel()
	_, err := health.Check(ctx, target)
	return err == nil
}

// localServer is a server value that names a plain http:// server on
// this machine's loopback.
type localServer struct {
	// host is "localhost", or a loopback IP address without brackets.
	host string
	// port is the port in decimal, 80 when the value names none.
	port string
	// path is what follows the address, "" for none, after the one
	// server address rule (serverBase) dropped a final /ingest.
	path string
}

// parseLocal reads server ("" is DefaultServer) as an http:// server on
// this machine. ok is false for anything else: a server beyond this
// machine, and an https:// one on it, which someone set up on purpose
// (a TLS proxy) and which no flightdeck on loopback serves.
func parseLocal(server string) (localServer, bool) {
	if strings.TrimSpace(server) == "" {
		server = DefaultServer
	}
	u, err := url.Parse(serverBase(server))
	if err != nil || u.Scheme != "http" || u.Opaque != "" {
		return localServer{}, false
	}
	host := u.Hostname()
	if !isLoopbackHost(host) {
		return localServer{}, false
	}
	if strings.EqualFold(strings.TrimSuffix(host, "."), "localhost") {
		host = "localhost"
	}
	port := 80
	if p := u.Port(); p != "" {
		if port, err = strconv.Atoi(p); err != nil || port < 1 || port > 65535 {
			return localServer{}, false
		}
	}
	return localServer{host: host, port: strconv.Itoa(port), path: u.Path}, true
}

// defaultPort is the port of DefaultServer, the one `flightdeck` serves
// with no flag.
var defaultPort = func() string {
	l, _ := parseLocal(DefaultServer)
	return l.port
}()

// probeTarget is where flightdeckAnswers sends the health check for
// server: the loopback address itself, so the probe never leaves this
// machine, with localhost tried as 127.0.0.1 and then ::1.
func probeTarget(server string) (health.Target, bool) {
	l, ok := parseLocal(server)
	if !ok {
		return health.Target{}, false
	}
	if l.host == "localhost" {
		return health.Target{
			Base:     "http://" + net.JoinHostPort("127.0.0.1", l.port) + l.path,
			Fallback: "http://" + net.JoinHostPort("::1", l.port) + l.path,
		}, true
	}
	return health.Target{Base: "http://" + net.JoinHostPort(l.host, l.port) + l.path}, true
}

// serverFor returns the server value an agent is given for an instance
// listening on listen, a loopback IP address and port: what its
// start-up block prints, http://localhost:<port>, for 127.0.0.1, and
// the address itself for another loopback address. ok is false for an
// address that is not a loopback IP address with a port.
func serverFor(listen string) (string, bool) {
	addr, port, ok := loopbackListen(listen)
	if !ok {
		return "", false
	}
	if addr == netip.MustParseAddr("127.0.0.1") {
		return "http://localhost:" + port, true
	}
	return "http://" + net.JoinHostPort(addr.String(), port), true
}

// loopbackListen splits a listen address into its loopback IP address,
// unmapped and without a zone, and its port in decimal.
func loopbackListen(listen string) (netip.Addr, string, bool) {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return netip.Addr{}, "", false
	}
	addr, err := netip.ParseAddr(host)
	if err != nil || addr.Zone() != "" || !addr.Unmap().IsLoopback() {
		return netip.Addr{}, "", false
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return netip.Addr{}, "", false
	}
	return addr.Unmap(), strconv.Itoa(n), true
}

// reportsHere reports whether server, an agent's saved server ("" is
// DefaultServer), names the instance listening on listen: an http://
// value with no path and the instance's port, whose host is localhost
// or the listen address itself.
func reportsHere(server, listen string) bool {
	l, ok := parseLocal(server)
	if !ok || l.path != "" {
		return false
	}
	addr, port, ok := loopbackListen(listen)
	if !ok || port != l.port {
		return false
	}
	if l.host == "localhost" {
		return true
	}
	saved, err := netip.ParseAddr(l.host)
	return err == nil && saved.Unmap() == addr
}

// connectCommand is the command that connects the agent id to server,
// an http:// server on this machine: --port for the default host, the
// short form of --server http://localhost:<port>.
func connectCommand(id, server string) string {
	if l, ok := parseLocal(server); ok && l.path == "" && (l.host == "localhost" || l.host == "127.0.0.1") {
		return "flightdeck connect " + id + " --port " + l.port
	}
	return "flightdeck connect " + id + " --server " + printable(server)
}

// startCommand is the command that starts a flightdeck at l.
func startCommand(l localServer) string {
	switch {
	case (l.host == "localhost" || l.host == "127.0.0.1") && l.port == defaultPort:
		return "flightdeck"
	case l.host == "localhost" || l.host == "127.0.0.1":
		return "flightdeck --port " + l.port
	}
	return "flightdeck --listen " + net.JoinHostPort(l.host, l.port)
}

// idleNote is the line that says no Flightdeck answers at server yet,
// an http:// server on this machine, and how to start one there. A
// server with a path is behind something else (a proxy) that no
// command of this binary starts.
func idleNote(server string) string {
	where := printable(server)
	if strings.TrimSpace(server) == "" {
		where = DefaultServer
	}
	l, _ := parseLocal(server)
	if l.path != "" {
		return fmt.Sprintf("No Flightdeck answers at %s yet; sessions are recorded once one does.", where)
	}
	return fmt.Sprintf("No Flightdeck answers at %s yet: start it with `%s`, and sessions are recorded from then on.", where, startCommand(l))
}

// runningServer is the Flightdeck found running on this machine.
type runningServer struct {
	// Server is the server value an agent is given for it (serverFor).
	Server string
	// Listen is the address it listens on, as its instance file says.
	Listen string
	// DataDir is the data dir whose instance file named it, absolute.
	DataDir string
}

// findRunning returns the instance that dataDir's instance file names,
// when every check holds: the file is one (datadir.ReadInstance), its
// address is a loopback IP address with a port, its process is alive
// and a Flightdeck answers at that very address. A file an instance
// killed earlier left, whose process is gone or whose port something
// else holds now, finds nothing. Nothing is created and no other
// address is probed.
func findRunning(ctx context.Context, dataDir string, answers AnswersFunc) (runningServer, bool) {
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return runningServer{}, false
	}
	inst, err := datadir.ReadInstance(abs)
	if err != nil {
		return runningServer{}, false
	}
	server, ok := serverFor(inst.Listen)
	if !ok || !processAlive(inst.PID) || !answers(ctx, "http://"+inst.Listen) {
		return runningServer{}, false
	}
	return runningServer{Server: server, Listen: inst.Listen, DataDir: abs}, true
}

// serverChoice is the server a connect without --server or --port
// reports to, with the lines that say why.
type serverChoice struct {
	target Target
	// why says why the plan points the agent at a server it would not
	// report to otherwise: the instance found running. It is shown with
	// the plan.
	why string
	// idle says that no Flightdeck answers at the server the agent is
	// to report to, and how to start one (idleNote). It is shown with
	// the plan and after it.
	idle string
}

// chooseServer decides where c reports when the command names no
// server: a new connection reports to the Flightdeck running on this
// machine (findRunning in dataDir), else to the default; an existing
// one keeps its server, unless that is an http:// server on this
// machine where nothing answers while an instance runs here at another
// address. A server beyond this machine, or an https:// one, is kept
// and not probed. A status that cannot be read chooses nothing and
// reads no data dir: the connector's PlanConnect reads it as well and
// reports why it cannot, in its own words and exit status.
func chooseServer(ctx context.Context, c Connector, dataDir string, answers AnswersFunc) serverChoice {
	st, err := c.Status(ctx)
	if err != nil {
		return serverChoice{}
	}
	inst, found := findRunning(ctx, dataDir, answers)
	if !st.Installed {
		switch {
		case found && sameServer(inst.Server, DefaultServer):
			// The integration's default: nothing to save.
			return serverChoice{}
		case found:
			return serverChoice{
				target: Target{Server: inst.Server, Local: true},
				why:    fmt.Sprintf("%s is the Flightdeck running on this machine (data dir %s).", inst.Server, inst.DataDir),
			}
		}
		return idleChoice(ctx, Target{}, "", answers)
	}
	if _, local := parseLocal(st.Server); !local || answers(ctx, st.Server) {
		return serverChoice{}
	}
	if found && !reportsHere(st.Server, inst.Listen) {
		return serverChoice{
			target: Target{Server: inst.Server, Local: true},
			why: fmt.Sprintf("%s reports to %s, where no Flightdeck answers; %s is the Flightdeck running on this machine (data dir %s).",
				c.Name(), describeServer(st.Server), inst.Server, inst.DataDir),
		}
	}
	return serverChoice{idle: idleNote(st.Server)}
}

// idleChoice is target with the idle note when server is an http://
// server on this machine where no Flightdeck answers.
func idleChoice(ctx context.Context, target Target, server string, answers AnswersFunc) serverChoice {
	choice := serverChoice{target: target}
	if _, local := parseLocal(server); local && !answers(ctx, server) {
		choice.idle = idleNote(server)
	}
	return choice
}

// annotate adds the choice's lines to the plan: why it reports where it
// does before the plan's notice, and the idle note after the notice and
// after the line that closes the run.
func (s serverChoice) annotate(p *Plan) {
	p.Notice = joinLines(s.why, p.Notice, s.idle)
	p.Unchanged = joinLines(p.Unchanged, s.idle)
	p.Done = joinLines(p.Done, s.idle)
}

// joinLines joins the lines that are not empty.
func joinLines(lines ...string) string {
	var kept []string
	for _, line := range lines {
		if line != "" {
			kept = append(kept, line)
		}
	}
	return strings.Join(kept, "\n")
}

// CheckReporting is the server's start-up check of the coding agents:
// for each agent found and connected whose integration reports to an
// http:// server on this machine that is not the instance listening on
// listen, one line that names both and the command that connects it
// here. An agent that is not found, not connected, connected here, or
// connected to a server beyond this machine or an https:// one has no
// line. The errors of the agents' commands are returned apart, for a
// debug log; a cancelled ctx ends the check, and its commands with it.
func CheckReporting(ctx context.Context, reg Registry, listen string) (lines []string, errs []error) {
	here, ok := serverFor(listen)
	if !ok {
		return nil, nil
	}
	for _, c := range reg {
		if ctx.Err() != nil {
			break
		}
		det, err := c.Detect(ctx)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", c.ID(), err))
			continue
		}
		if !det.Found {
			continue
		}
		st, err := c.Status(ctx)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", c.ID(), err))
			continue
		}
		if !st.Connected() {
			continue
		}
		if _, local := parseLocal(st.Server); !local || reportsHere(st.Server, listen) {
			continue
		}
		saved := printable(st.Server)
		if strings.TrimSpace(saved) == "" {
			saved = DefaultServer
		}
		lines = append(lines, fmt.Sprintf("%s reports to %s, not to this server at %s: its sessions are not recorded here. To report here, run: %s",
			c.Name(), saved, here, connectCommand(c.ID(), here)))
	}
	return lines, errs
}

// unansweredNote is the listing's line for an agent whose integration
// reports to st.Server: "" unless that is an http:// server on this
// machine where no Flightdeck answers. Then it names the instance
// running here and the command that points the agent at it, or, with
// none running, says how to start one there.
func unansweredNote(ctx context.Context, c Connector, st Status, dataDir string, answers AnswersFunc) string {
	if _, local := parseLocal(st.Server); !local || answers(ctx, st.Server) {
		return ""
	}
	if inst, found := findRunning(ctx, dataDir, answers); found {
		if reportsHere(st.Server, inst.Listen) {
			// It answered the moment before: nothing to point it at.
			return ""
		}
		return fmt.Sprintf("no Flightdeck answers there; the one running on this machine is at %s: %s",
			inst.Server, connectCommand(c.ID(), inst.Server))
	}
	// The listing's lines are phrases: lower-case, no full stop.
	note := strings.TrimSuffix(idleNote(st.Server), ".")
	return strings.ToLower(note[:1]) + note[1:]
}
