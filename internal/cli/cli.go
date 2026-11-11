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
	// DatabaseURL is the Postgres DSN; required.
	DatabaseURL string
	// DataDir holds the NATS store, the secrets file and the TLS cache.
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
}

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
	fs.StringVar(&o.Listen, "listen", envOr(env, "FLIGHTDECK_LISTEN", DefaultListen),
		"address to serve the dashboard, /api and /ingest on; a loopback address enables the development token (env FLIGHTDECK_LISTEN)")
	fs.StringVar(&o.DatabaseURL, "database-url", env("FLIGHTDECK_DATABASE_URL"),
		"Postgres URL, postgres://user:password@host:5432/db?sslmode=disable (env FLIGHTDECK_DATABASE_URL)")
	fs.StringVar(&o.DataDir, "data-dir", envOr(env, "FLIGHTDECK_DATA_DIR", datadir.Default()),
		"directory for the message-bus store, the secrets file and the TLS cache (env FLIGHTDECK_DATA_DIR)")
	fs.StringVar(&o.NatsURL, "nats-url", env("FLIGHTDECK_NATS_URL"),
		"external NATS server URL; unset runs an embedded server with no port (env FLIGHTDECK_NATS_URL)")
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
		_, _ = fmt.Fprintf(out, "Usage: flightdeck [flags]\n\nRuns the Flightdeck control plane: ingestion, workers, query API and the dashboard in one process.\n\nFlags:\n")
		fs.PrintDefaults()
	}

	if err := fs.Parse(args); err != nil {
		return Options{}, err
	}
	if fs.NArg() > 0 {
		fs.Usage()
		return Options{}, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	if o.Version {
		return o, nil
	}
	if strings.TrimSpace(o.DatabaseURL) == "" {
		return Options{}, errors.New("no database configured: pass --database-url or set FLIGHTDECK_DATABASE_URL to a Postgres URL " +
			"(a bundled SQLite database is coming; until then Flightdeck needs Postgres, for example the compose stack's " +
			"postgres://flightdeck:flightdeck_dev@localhost:5432/flightdeck?sslmode=disable)")
	}
	if strings.TrimSpace(o.Listen) == "" {
		return Options{}, errors.New("--listen must not be empty")
	}
	return o, nil
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
