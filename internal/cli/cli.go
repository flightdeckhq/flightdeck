// Package cli parses the flightdeck binary's command line: a flag wins
// over its environment variable, which wins over the default.
package cli

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/flightdeckhq/flightdeck/internal/datadir"
	"github.com/flightdeckhq/flightdeck/storage"
)

// DefaultListen is the listener's default address. It is a loopback
// address on purpose: the first run of the binary is a try-it on one
// machine, where the development token is the right default, and a
// deployment that serves other machines says so with --listen or
// --domain and gets a minted token.
const DefaultListen = "127.0.0.1:4000"

// Options is the parsed command line.
type Options struct {
	// Listen is the address of the one HTTP listener.
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
	// Metrics starts the three services' metrics listeners.
	Metrics bool
	// Version prints the version and exits.
	Version bool
	// Health is the `flightdeck health` command: ask the instance that
	// runs with these settings whether it serves, and exit. Only Listen
	// and Domain matter to it.
	Health bool
}

// HealthCommand is the binary's one subcommand, given as its first
// argument: `flightdeck health`. It takes the server's flags and reads
// the server's environment, so it finds the instance with no arguments
// wherever the instance itself was configured through the environment.
const HealthCommand = "health"

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
	fs.StringVar(&o.Listen, "listen", envOr(env, "FLIGHTDECK_LISTEN", DefaultListen),
		"address to serve the dashboard, /api and /ingest on; a loopback address enables the development token (env FLIGHTDECK_LISTEN)")
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
	metricsDefault, err := envBool(env, "FLIGHTDECK_METRICS")
	if err != nil {
		return Options{}, err
	}
	fs.BoolVar(&o.Metrics, "metrics", metricsDefault,
		"start the services' metrics listeners on ports 9102 (workers), 9103 (ingestion) and 9104 (query API) (env FLIGHTDECK_METRICS)")
	fs.BoolVar(&o.Version, "version", false, "print the version and exit")
	fs.Usage = func() {
		_, _ = fmt.Fprintf(out, "Usage: flightdeck [flags]\n       flightdeck %s [flags]\n\n"+
			"Runs the Flightdeck control plane: ingestion, workers, query API and the dashboard in one process.\n"+
			"With no flags it serves on %s and keeps its data in a SQLite database under the data dir.\n\n"+
			"flightdeck %s asks the instance that runs with the same --listen and --domain (or their environment\n"+
			"variables) whether it serves, prints one line and exits 0 when it does and 1 when it does not:\n"+
			"a container health check that needs no shell and no token.\n\nFlags:\n",
			HealthCommand, DefaultListen, HealthCommand)
		fs.PrintDefaults()
	}

	if err := fs.Parse(args); err != nil {
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
	if strings.TrimSpace(o.Listen) == "" {
		return Options{}, errors.New("--listen must not be empty")
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
