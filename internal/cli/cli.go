// Package cli parses the flightdeck binary's command line: a flag wins
// over its environment variable, which wins over the default.
package cli

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"

	"github.com/flightdeckhq/flightdeck/internal/datadir"
	"github.com/flightdeckhq/flightdeck/storage"
)

// DefaultListen is the listener's default address. It is a loopback
// address on purpose: the first run of the binary is a try-it on one
// machine, where the development token is the right default, and a
// deployment that serves other machines says so with --public, --listen
// or --domain and gets a minted token.
const DefaultListen = LoopbackHost + ":" + DefaultPort

// DefaultPort is the listener's port when --port, FLIGHTDECK_PORT and
// --listen leave it unsaid.
const DefaultPort = "4000"

// LoopbackHost is the address --port serves on, and the host a --listen
// port with no host gets: this machine only. IPv4, not ::1, because a
// container or a host may have no IPv6 on its loopback.
const LoopbackHost = "127.0.0.1"

// PublicHost is the address --public serves on: every interface. It is
// the address `--listen 0.0.0.0:<port>` names, and Go opens a listener
// on it as one socket that takes IPv6 connections too where the system
// allows it, so it reaches what [::] reaches.
const PublicHost = "0.0.0.0"

// The port range --port accepts. Port 0, which asks the system for any
// free port, is not among them: the start-up block, the sensor's
// FLIGHTDECK_SERVER and `flightdeck health` all need the port before
// the system would pick it.
const (
	minPort = 1
	maxPort = 65535
)

// Options is the parsed command line.
type Options struct {
	// Listen is the address of the one HTTP listener, resolved from
	// --listen, --port and --public (and their variables), always with a
	// host: a --listen port with no host is LoopbackHost's.
	Listen string
	// DatabaseURL names the database: postgres://… (or postgresql://…)
	// or sqlite://<path>. Empty means the SQLite file in the data dir,
	// which the caller resolves once the data dir is known.
	DatabaseURL string
	// DataDir holds the SQLite database, the NATS store, the secrets
	// file and the TLS cache.
	DataDir string
	// NatsURL, when set, names an external NATS server; empty runs the
	// embedded one.
	NatsURL string
	// Domain, when set, serves TLS for that host with ACME certificates.
	Domain string
	// AllowedHosts are the extra host names the instance answers for
	// (--allowed-hosts), lower-case; see router.HostPolicy. Empty means
	// the default of the listen mode.
	AllowedHosts []string
	// Metrics starts the three services' metrics listeners.
	Metrics bool
	// Version prints the version and exits.
	Version bool
	// Health is the `flightdeck health` command: ask the instance that
	// runs with these settings whether it serves, and exit. Only Listen
	// and Domain matter to it.
	Health bool
}

// The variables of the three flags that choose the listen address.
const (
	listenEnv = "FLIGHTDECK_LISTEN"
	portEnv   = "FLIGHTDECK_PORT"
	publicEnv = "FLIGHTDECK_PUBLIC"
)

// HealthCommand is a subcommand, given as the first argument:
// `flightdeck health`. It takes the server's flags and reads the
// server's environment, so it finds the instance with no arguments
// wherever the instance itself was configured through the environment.
const HealthCommand = "health"

// ConnectCommand is the other subcommand, `flightdeck connect`: it
// connects coding agents to a Flightdeck server and has flags of its
// own (internal/connect), so the binary hands it the rest of the line
// before Parse sees it.
const ConnectCommand = "connect"

// ErrHelp is returned when the command line asked for the usage text,
// which Parse has written to the output.
var ErrHelp = flag.ErrHelp

// Parse reads args (without the program name) against env, which maps
// a variable name to its value ("" when unset, as os.Getenv does), and
// writes usage to out on -h or an error.
func Parse(args []string, env func(string) string, out io.Writer) (Options, error) {
	fs := flag.NewFlagSet("flightdeck", flag.ContinueOnError)
	fs.SetOutput(out)

	var o Options
	if len(args) > 0 && args[0] == HealthCommand {
		o.Health = true
		args = args[1:]
	}
	// The listen address has three flags: --port and --public, which
	// combine, and --listen, which names the whole address. The value
	// is resolved after parsing (resolveListen).
	var port string
	portUsage := "port to serve the dashboard, /api and /ingest on, " + strconv.Itoa(minPort) + " to " + strconv.Itoa(maxPort) +
		": on " + LoopbackHost + ", this machine only, with the development token, unless --public is given (env " + portEnv + ")"
	fs.StringVar(&port, "port", envOr(env, portEnv, DefaultPort), portUsage)
	fs.StringVar(&port, "p", envOr(env, portEnv, DefaultPort), "short for --port")
	publicDefault, err := envBool(env, publicEnv)
	if err != nil {
		return Options{}, err
	}
	var public bool
	fs.BoolVar(&public, "public", publicDefault,
		"serve every network interface ("+PublicHost+"), so other machines reach this server: it then refuses the development token "+
			"and uses an access token, created on its first start (env "+publicEnv+")")
	fs.StringVar(&o.Listen, "listen", env(listenEnv),
		"one address to serve on, host:port, for example 10.0.0.5:4000; 0.0.0.0:4000 is every interface, a loopback host "+
			"enables the development token, and a port with no host (:4000) is "+LoopbackHost+". It names the whole address, so it "+
			"is not combined with --port or --public (env "+listenEnv+")")
	// The two URL flags are registered with no default and take their
	// environment value after parsing: the usage text prints every
	// flag's default, and these URLs hold a password or a token.
	fs.StringVar(&o.DatabaseURL, "database-url", "",
		"database to use instead of the SQLite file in the data dir: a Postgres URL, postgres://user:password@host:5432/db?sslmode=disable, "+
			"or another SQLite file, sqlite:///path/to/flightdeck.db (default: $FLIGHTDECK_DATABASE_URL, else the SQLite file in the data dir)")
	fs.StringVar(&o.DataDir, "data-dir", envOr(env, "FLIGHTDECK_DATA_DIR", datadir.Default()),
		"directory for the database ("+datadir.DatabaseFile+"), the message-bus store, the secrets file and the TLS cache (env FLIGHTDECK_DATA_DIR)")
	fs.StringVar(&o.NatsURL, "nats-url", "",
		"external NATS server URL (default: $FLIGHTDECK_NATS_URL, else an embedded server with no port)")
	fs.StringVar(&o.Domain, "domain", env("FLIGHTDECK_DOMAIN"),
		"public host name: serve HTTPS on :443 with a Let's Encrypt certificate and redirect :80 (env FLIGHTDECK_DOMAIN)")
	allowedHosts := fs.String("allowed-hosts", env("FLIGHTDECK_ALLOWED_HOSTS"),
		"comma-separated host names this server answers for besides localhost, IP addresses and --domain, for example "+
			"fd.internal,.example.com (a leading dot admits every name under it); \"*\" answers any name. Unset, a loopback "+
			"listen and --domain answer only for those, and a listen address beyond loopback answers any name (env FLIGHTDECK_ALLOWED_HOSTS)")
	metricsDefault, err := envBool(env, "FLIGHTDECK_METRICS")
	if err != nil {
		return Options{}, err
	}
	fs.BoolVar(&o.Metrics, "metrics", metricsDefault,
		"start the services' metrics listeners on ports 9102 (workers), 9103 (ingestion) and 9104 (query API) (env FLIGHTDECK_METRICS)")
	fs.BoolVar(&o.Version, "version", false, "print the version and exit")
	fs.Usage = func() {
		_, _ = fmt.Fprintf(out, "Usage: flightdeck [flags]\n       flightdeck %s [flags]\n       flightdeck %s [<agent>] [flags]\n\n"+
			"Runs the Flightdeck control plane: ingestion, workers, query API and the dashboard in one process.\n"+
			"With no flags it serves on %s, this machine only, and keeps its data in a SQLite database\n"+
			"under the data dir. --port 4100 serves on another port of this machine; --public lets other machines in\n"+
			"(every network interface, on the --port given); --listen <address>:<port> serves on one address.\n\n"+
			"flightdeck %s asks the instance that runs with the same --port, --public, --listen and --domain (or\n"+
			"their environment variables) whether it serves, prints one line and exits 0 when it does and 1 when it\n"+
			"does not: a container health check that needs no shell and no token.\n\n"+
			"flightdeck %s connects a coding agent on this machine to Flightdeck (flightdeck %s claude-code);\n"+
			"with no agent it lists the agents and whether each is connected. flightdeck %s --help has its flags.\n\nFlags:\n",
			HealthCommand, ConnectCommand, DefaultListen, HealthCommand, ConnectCommand, ConnectCommand, ConnectCommand)
		fs.PrintDefaults()
	}

	usage := fs.Usage
	if o.Health {
		// A health check's output is a container's health log: a
		// mistyped flag is one line (the caller prints the error), not
		// the whole usage. -h still prints it.
		fs.SetOutput(io.Discard)
		fs.Usage = func() {}
	}
	if err := fs.Parse(args); err != nil {
		if o.Health && errors.Is(err, flag.ErrHelp) {
			fs.SetOutput(out)
			usage()
		}
		return Options{}, err
	}
	if fs.NArg() > 0 {
		fs.Usage()
		return Options{}, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	// A flag given on the command line wins, an empty one included.
	given := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { given[f.Name] = true })
	if !given["database-url"] {
		o.DatabaseURL = env("FLIGHTDECK_DATABASE_URL")
	}
	if !given["nats-url"] {
		o.NatsURL = env("FLIGHTDECK_NATS_URL")
	}
	if o.Version {
		return o, nil
	}
	if o.Listen, err = resolveListen(given, o.Listen, port, public, env); err != nil {
		return Options{}, err
	}
	if o.AllowedHosts, err = parseAllowedHosts(*allowedHosts); err != nil {
		return Options{}, err
	}
	if o.Health {
		// The health command opens no database: a URL it would refuse
		// is the server's to report.
		return o, nil
	}
	o.DatabaseURL = strings.TrimSpace(o.DatabaseURL)
	if err := checkDatabaseURL(o.DatabaseURL); err != nil {
		return Options{}, err
	}
	return o, nil
}

// resolveListen decides the listen address from --listen on one side
// and --port and --public on the other, given holding the flags that
// are on the command line and listen, port and public their values
// (a flag's variable when it is not given). --listen names the whole
// address, so it combines with neither of the others. A flag beats its
// variable, and a flag of either side overrides the other side's
// variables; the two sides given together, as flags or, with no flag
// deciding, as variables, are a usage error that names both.
func resolveListen(given map[string]bool, listen, port string, public bool, env func(string) string) (string, error) {
	portFlag := ""
	switch {
	case given["port"]:
		portFlag = "--port"
	case given["p"]:
		portFlag = "-p"
	}
	switch {
	case given["listen"] && portFlag != "":
		return "", bothFlags(portFlag)
	case given["listen"] && given["public"]:
		return "", bothFlags("--public")
	case given["listen"]:
		return listenAddress(listen)
	case portFlag != "" || given["public"]:
		// FLIGHTDECK_LISTEN is overridden by a flag of the other side.
	case env(listenEnv) != "":
		switch {
		case env(portEnv) != "":
			return "", bothVariables(portEnv)
		case env(publicEnv) != "":
			return "", bothVariables(publicEnv)
		}
		return listenAddress(listen)
	}
	return portAddress(port, public)
}

// listenAddress checks a --listen value and gives a port with no host
// (":4100", "[]:4100") the loopback host: an address that serves other
// machines is written out (0.0.0.0:4100, [::]:4100, one interface's
// address) or spelled --public. A number alone is refused with the
// --port form; any other value the bind reports, as it always has.
func listenAddress(raw string) (string, error) {
	addr := strings.TrimSpace(raw)
	if addr == "" {
		return "", errors.New("--listen (" + listenEnv + ") must not be empty: give host:port, for example 10.0.0.5:4000, " +
			"or leave it out to serve on " + DefaultListen)
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		if decimal(addr) {
			return "", fmt.Errorf("--listen (%s) got %s, a port with no address; for that port on this machine give --port %s "+
				"(%s=%s), and for another address --listen <address>:%s", listenEnv, addr, addr, portEnv, addr, addr)
		}
		return addr, nil
	}
	if host == "" {
		return net.JoinHostPort(LoopbackHost, port), nil
	}
	return addr, nil
}

// portAddress is the address of --port and --public: the port on the
// loopback host, or on every interface with --public.
func portAddress(raw string, public bool) (string, error) {
	v := strings.TrimSpace(raw)
	n, err := strconv.Atoi(v)
	if err != nil || !decimal(v) || n < minPort || n > maxPort {
		return "", fmt.Errorf("--port (%s) got %q; it takes a port number from %d to %d, for example --port 4100",
			portEnv, raw, minPort, maxPort)
	}
	host := LoopbackHost
	if public {
		host = PublicHost
	}
	return net.JoinHostPort(host, strconv.Itoa(n)), nil
}

// decimal reports whether s is one or more ASCII digits and nothing else.
func decimal(s string) bool {
	return s != "" && strings.Trim(s, "0123456789") == ""
}

// listenForms is the end of both conflict messages: the three ways to
// say where to listen, in the spelling of flags or of variables.
func listenForms(port, public, listen string) string {
	return port + "<port> for another port on this machine, " + public + " (with " + strings.TrimRight(port, "= ") +
		" for another port) to let other machines in, or " + listen + "<address>:<port> for one address"
}

func bothFlags(other string) error {
	return fmt.Errorf("--listen and %s were both given; --listen names the whole address, so give one of them: %s",
		other, listenForms("--port ", "--public", "--listen "))
}

func bothVariables(other string) error {
	return fmt.Errorf("%s and %s are both set; %s names the whole address, so set one of them: %s. "+
		"An empty value counts as unset, and a flag on the command line overrides both",
		listenEnv, other, listenEnv, listenForms(portEnv+"=", publicEnv+"=true", listenEnv+"="))
}

// checkDatabaseURL accepts an empty URL (the SQLite file in the data
// dir), a Postgres URL and a sqlite:// URL that names a file, and
// refuses anything else with the accepted forms. The message carries
// the URL's scheme only: the rest may hold a password.
func checkDatabaseURL(raw string) error {
	if raw == "" {
		return nil
	}
	backend, err := storage.BackendOf(raw)
	if err != nil {
		scheme, _, found := strings.Cut(raw, "://")
		if !found || scheme == "" {
			scheme = "a value with no scheme"
		} else {
			scheme += "://"
		}
		return fmt.Errorf("--database-url (FLIGHTDECK_DATABASE_URL) got %s; it takes a Postgres URL "+
			"(postgres://user:password@host:5432/db or postgresql://…) or a SQLite file (sqlite:///path/to/flightdeck.db). "+
			"Leave it out to keep the data in %s under the data dir", scheme, datadir.DatabaseFile)
	}
	if backend == storage.SQLite {
		if path := storage.SQLitePath(raw); path == "" || strings.HasPrefix(path, ":memory:") {
			return errors.New("--database-url (FLIGHTDECK_DATABASE_URL) names no SQLite file: " +
				"give a path after the scheme, for example sqlite:///var/lib/flightdeck/flightdeck.db")
		}
	}
	return nil
}

// parseAllowedHosts splits --allowed-hosts into its entries, lower-case.
// An entry is a host name, a host name with a leading dot (that name
// and every name under it) or "*" (any name). A port, a scheme or a
// path is refused: the check is on the name alone, and an entry that
// silently never matched would lock its operator out.
func parseAllowedHosts(raw string) ([]string, error) {
	var hosts []string
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.ToLower(strings.TrimSpace(entry))
		if entry == "" {
			continue
		}
		name := strings.TrimPrefix(entry, ".")
		if entry != "*" && (name == "" || strings.Trim(name, "abcdefghijklmnopqrstuvwxyz0123456789-.") != "" ||
			strings.HasPrefix(name, ".") || strings.HasSuffix(name, ".") || strings.Contains(name, "..")) {
			return nil, fmt.Errorf("--allowed-hosts (FLIGHTDECK_ALLOWED_HOSTS) entry %q is not a host name: "+
				"give names without a scheme, a port or a path, separated by commas, for example fd.internal,.example.com", entry)
		}
		hosts = append(hosts, entry)
	}
	return hosts, nil
}

func envOr(env func(string) string, key, def string) string {
	if v := env(key); v != "" {
		return v
	}
	return def
}

func envBool(env func(string) string, key string) (bool, error) {
	v := env(key)
	if v == "" {
		return false, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false, got %q", key, v)
	}
	return b, nil
}
