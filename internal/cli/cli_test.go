package cli

import (
	"bytes"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/internal/bootstrap"
	"github.com/flightdeckhq/flightdeck/internal/datadir"
)

func envOf(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestParse_NothingIsRequired(t *testing.T) {
	var out bytes.Buffer
	o, err := Parse(nil, envOf(nil), &out)
	if err != nil {
		t.Fatal(err)
	}
	if o.Listen != DefaultListen || o.DataDir != datadir.Default() || o.DatabaseURL != "" || o.NatsURL != "" || o.Domain != "" || o.Metrics {
		t.Fatalf("%+v", o)
	}
}

func TestParse_AcceptsPostgresAndSQLiteURLs(t *testing.T) {
	for _, u := range []string{
		"postgres://u:p@h/db",
		"postgresql://u:p@h:5432/db?sslmode=disable",
		"sqlite:///var/lib/flightdeck/flightdeck.db",
		"sqlite://relative/flightdeck.db",
		"sqlite:///home/o m/a#b/x?y/50%/flightdeck.db",
		`sqlite://C:\Users\omria\AppData\Local\flightdeck\flightdeck.db`,
	} {
		o, err := Parse([]string{"--database-url", u}, envOf(nil), &bytes.Buffer{})
		if err != nil {
			t.Errorf("--database-url %q refused: %v", u, err)
			continue
		}
		if o.DatabaseURL != u {
			t.Errorf("--database-url %q parsed as %q; the URL must reach the storage module unchanged", u, o.DatabaseURL)
		}
	}
	// Surrounding blanks (a quoted value in an env file) are not part
	// of the URL.
	o, err := Parse(nil, envOf(map[string]string{"FLIGHTDECK_DATABASE_URL": "  postgres://env/db \n"}), &bytes.Buffer{})
	if err != nil || o.DatabaseURL != "postgres://env/db" {
		t.Fatalf("o=%+v err=%v", o, err)
	}
}

func TestParse_EnvironmentFillsIn(t *testing.T) {
	env := envOf(map[string]string{
		"FLIGHTDECK_DATABASE_URL": "postgres://env/db",
		"FLIGHTDECK_LISTEN":       "0.0.0.0:5000",
		"FLIGHTDECK_DATA_DIR":     "/var/lib/flightdeck",
		"FLIGHTDECK_NATS_URL":     "nats://nats:4222",
		"FLIGHTDECK_DOMAIN":       "fd.example.com",
		"FLIGHTDECK_METRICS":      "true",
	})
	o, err := Parse(nil, env, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if o.DatabaseURL != "postgres://env/db" || o.Listen != "0.0.0.0:5000" || o.DataDir != "/var/lib/flightdeck" ||
		o.NatsURL != "nats://nats:4222" || o.Domain != "fd.example.com" || !o.Metrics {
		t.Fatalf("%+v", o)
	}
}

func TestParse_FlagsWinOverEnvironment(t *testing.T) {
	env := envOf(map[string]string{
		"FLIGHTDECK_DATABASE_URL": "postgres://env/db",
		"FLIGHTDECK_LISTEN":       "0.0.0.0:5000",
		"FLIGHTDECK_METRICS":      "true",
	})
	o, err := Parse([]string{"--database-url=postgres://flag/db", "--listen", "127.0.0.1:4100", "--metrics=false"}, env, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if o.DatabaseURL != "postgres://flag/db" || o.Listen != "127.0.0.1:4100" || o.Metrics {
		t.Fatalf("%+v", o)
	}
}

func TestParse_RefusesOtherDatabaseURLsNamingTheAcceptedForms(t *testing.T) {
	for _, u := range []string{
		"mysql://root:s3cret@h/db",
		"/var/lib/flightdeck/flightdeck.db",
		"flightdeck.db",
		"postgres:/u@h/db",
		"file:///var/lib/flightdeck.db",
	} {
		_, err := Parse([]string{"--database-url", u}, envOf(nil), &bytes.Buffer{})
		if err == nil {
			t.Errorf("--database-url %q accepted", u)
			continue
		}
		for _, want := range []string{"--database-url", "FLIGHTDECK_DATABASE_URL", "postgres://", "postgresql://", "sqlite://", "flightdeck.db"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("--database-url %q: error %q lacks %q", u, err, want)
			}
		}
		if strings.Contains(err.Error(), "s3cret") {
			t.Errorf("error %q repeats the URL's password", err)
		}
	}
	for _, u := range []string{"sqlite://", "sqlite://:memory:"} {
		_, err := Parse([]string{"--database-url", u}, envOf(nil), &bytes.Buffer{})
		if err == nil || !strings.Contains(err.Error(), "names no SQLite file") {
			t.Errorf("--database-url %q: err = %v", u, err)
		}
	}
}

// The usage text prints each flag's default. The database and NATS
// URLs come from the environment and hold a password or a token, so
// they are never a flag default: neither --help nor the usage printed
// with an error repeats them, and they still apply when no flag is
// given.
func TestParse_UsageNeverPrintsASecretFromTheEnvironment(t *testing.T) {
	env := envOf(map[string]string{
		"FLIGHTDECK_DATABASE_URL": "postgres://u:secretpw@h/db?password=secretq",
		"FLIGHTDECK_NATS_URL":     "nats://secrettoken@nats:4222",
		"FLIGHTDECK_LISTEN":       "0.0.0.0:5000",
		"FLIGHTDECK_DATA_DIR":     "/var/lib/flightdeck",
		"FLIGHTDECK_DOMAIN":       "fd.example.com",
	})
	for name, args := range map[string][]string{
		"--help":           {"--help"},
		"-h":               {"-h"},
		"a stray argument": {"serve"},
		"an unknown flag":  {"--no-such-flag"},
	} {
		var out bytes.Buffer
		_, err := Parse(args, env, &out)
		if err == nil {
			t.Errorf("%s: Parse succeeded", name)
		}
		text := out.String()
		if err != nil {
			text += err.Error()
		}
		for _, secret := range []string{"secretpw", "secretq", "secrettoken"} {
			if strings.Contains(text, secret) {
				t.Errorf("%s: the output repeats %q from the environment:\n%s", name, secret, text)
			}
		}
		// What is not a secret is still shown as the default.
		for _, shown := range []string{"0.0.0.0:5000", "/var/lib/flightdeck", "fd.example.com", "FLIGHTDECK_DATABASE_URL", "FLIGHTDECK_NATS_URL"} {
			if !strings.Contains(text, shown) {
				t.Errorf("%s: the usage lacks %q:\n%s", name, shown, text)
			}
		}
	}

	o, err := Parse(nil, env, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if o.DatabaseURL != "postgres://u:secretpw@h/db?password=secretq" || o.NatsURL != "nats://secrettoken@nats:4222" {
		t.Fatalf("the environment's URLs were not applied: %+v", o)
	}
	// A flag wins over the environment, an empty one included: it asks
	// for the default (SQLite in the data dir, the embedded NATS).
	o, err = Parse([]string{"--database-url", "", "--nats-url="}, env, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if o.DatabaseURL != "" || o.NatsURL != "" {
		t.Fatalf("an empty flag did not override the environment: %+v", o)
	}
}

func TestParse_BadMetricsEnv(t *testing.T) {
	_, err := Parse(nil, envOf(map[string]string{"FLIGHTDECK_METRICS": "yes please"}), &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "FLIGHTDECK_METRICS") {
		t.Fatalf("err = %v", err)
	}
}

func TestParse_VersionNeedsNoDatabase(t *testing.T) {
	o, err := Parse([]string{"--version"}, envOf(nil), &bytes.Buffer{})
	if err != nil || !o.Version {
		t.Fatalf("o=%+v err=%v", o, err)
	}
}

func TestParse_HelpAndStrayArguments(t *testing.T) {
	var out bytes.Buffer
	_, err := Parse([]string{"-h"}, envOf(nil), &out)
	if !errors.Is(err, ErrHelp) {
		t.Fatalf("err = %v, want ErrHelp", err)
	}
	for _, want := range []string{"-database-url", "-data-dir", "SQLite", "sqlite://", "postgres://", "flightdeck.db", DefaultListen} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("usage lacks %q:\n%s", want, out.String())
		}
	}
	_, err = Parse([]string{"serve"}, envOf(map[string]string{"FLIGHTDECK_DATABASE_URL": "x"}), &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), `"serve"`) {
		t.Fatalf("err = %v", err)
	}
}

func TestParse_HealthCommand(t *testing.T) {
	// No arguments: the server's defaults.
	o, err := Parse([]string{"health"}, envOf(nil), &bytes.Buffer{})
	if err != nil || !o.Health || o.Listen != DefaultListen || o.Domain != "" {
		t.Fatalf("o=%+v err=%v", o, err)
	}
	// The server's environment, as a container sets it.
	env := envOf(map[string]string{"FLIGHTDECK_LISTEN": "0.0.0.0:4000", "FLIGHTDECK_DOMAIN": "fd.example.com", "FLIGHTDECK_DATA_DIR": "/data"})
	o, err = Parse([]string{"health"}, env, &bytes.Buffer{})
	if err != nil || !o.Health || o.Listen != "0.0.0.0:4000" || o.Domain != "fd.example.com" {
		t.Fatalf("o=%+v err=%v", o, err)
	}
	// The address resolves as the server's does: the port flags, their
	// variables, a port with no host on loopback, and the same refusals.
	for _, c := range []struct {
		args []string
		env  map[string]string
		want string
	}{
		{[]string{"health", "--port", "4100"}, nil, "127.0.0.1:4100"},
		{[]string{"health", "-p", "4100"}, nil, "127.0.0.1:4100"},
		{[]string{"health"}, map[string]string{"FLIGHTDECK_PORT": "4100"}, "127.0.0.1:4100"},
		{[]string{"health", "--public", "--port", "4100"}, nil, "0.0.0.0:4100"},
		{[]string{"health"}, map[string]string{"FLIGHTDECK_PUBLIC": "true", "FLIGHTDECK_PORT": "4100"}, "0.0.0.0:4100"},
		{[]string{"health", "--listen", ":4100"}, nil, "127.0.0.1:4100"},
		{[]string{"health"}, map[string]string{"FLIGHTDECK_LISTEN": ":4100"}, "127.0.0.1:4100"},
	} {
		o, err := Parse(c.args, envOf(c.env), &bytes.Buffer{})
		if err != nil || !o.Health || o.Listen != c.want {
			t.Errorf("Parse(%q) with %v: o=%+v err=%v, want %s", c.args, c.env, o, err, c.want)
		}
	}
	if _, err := Parse([]string{"health", "--port", "4100", "--listen", "127.0.0.1:4100"}, envOf(nil), &bytes.Buffer{}); err == nil ||
		!strings.Contains(err.Error(), "--listen and --port") {
		t.Errorf("health --port --listen: err = %v, want both named", err)
	}
	if _, err := Parse([]string{"health"}, envOf(map[string]string{"FLIGHTDECK_PORT": "4100", "FLIGHTDECK_LISTEN": ":4100"}), &bytes.Buffer{}); err == nil ||
		!strings.Contains(err.Error(), "FLIGHTDECK_LISTEN and FLIGHTDECK_PORT") {
		t.Errorf("health with FLIGHTDECK_PORT and FLIGHTDECK_LISTEN: err = %v, want both named", err)
	}
	if _, err := Parse([]string{"health", "--port", "0"}, envOf(nil), &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "1 to 65535") {
		t.Errorf("health --port 0: err = %v, want the range", err)
	}
	// The server's flags, which win over the environment.
	o, err = Parse([]string{"health", "--listen", "10.0.0.5:5000", "--domain", ""}, env, &bytes.Buffer{})
	if err != nil || !o.Health || o.Listen != "10.0.0.5:5000" || o.Domain != "" {
		t.Fatalf("o=%+v err=%v", o, err)
	}
	// The server's other flags are accepted and not looked at: a
	// command line copied from the server's works.
	o, err = Parse([]string{"health", "--data-dir", "/data", "--metrics", "--nats-url", "nats://n:4222"}, envOf(nil), &bytes.Buffer{})
	if err != nil || !o.Health {
		t.Fatalf("o=%+v err=%v", o, err)
	}
	// The health command opens no database, so a database URL the
	// server would refuse does not make a serving instance unhealthy.
	o, err = Parse([]string{"health"}, envOf(map[string]string{"FLIGHTDECK_DATABASE_URL": "mysql://u:p@h/db"}), &bytes.Buffer{})
	if err != nil || !o.Health {
		t.Fatalf("o=%+v err=%v", o, err)
	}

	// The server is not the health command.
	o, err = Parse(nil, envOf(nil), &bytes.Buffer{})
	if err != nil || o.Health {
		t.Fatalf("o=%+v err=%v", o, err)
	}
	// Only as the first argument, and with nothing after its flags.
	for _, args := range [][]string{
		{"--listen", ":4000", "health"},
		{"health", "now"},
		{"health", "health"},
		{"healthz"},
	} {
		if _, err := Parse(args, envOf(nil), &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "unexpected argument") {
			t.Errorf("Parse(%q): err = %v, want an unexpected-argument error", args, err)
		}
	}
	if _, err := Parse([]string{"health", "--listen", " "}, envOf(nil), &bytes.Buffer{}); err == nil {
		t.Error("an empty --listen was accepted for the health command")
	}
	if _, err := Parse([]string{"health", "--no-such-flag"}, envOf(nil), &bytes.Buffer{}); err == nil {
		t.Error("an unknown flag was accepted for the health command")
	}
}

func TestParse_UsageNamesTheHealthCommandAndNoSecret(t *testing.T) {
	var out bytes.Buffer
	env := envOf(map[string]string{
		"FLIGHTDECK_DATABASE_URL": "postgres://u:hunter2@h/db",
		"FLIGHTDECK_NATS_URL":     "nats://tokenvalue@n:4222",
	})
	if _, err := Parse([]string{"-h"}, env, &out); !errors.Is(err, ErrHelp) {
		t.Fatalf("err = %v, want ErrHelp", err)
	}
	usage := out.String()
	if !strings.Contains(usage, "flightdeck health [flags]") {
		t.Errorf("the usage text does not name the health command:\n%s", usage)
	}
	if !strings.Contains(usage, "flightdeck connect [<agent>] [flags]") || !strings.Contains(usage, "flightdeck connect claude-code") {
		t.Errorf("the usage text does not name the connect command:\n%s", usage)
	}
	for _, secret := range []string{"hunter2", "tokenvalue"} {
		if strings.Contains(usage, secret) {
			t.Errorf("the usage text carries %q from the environment", secret)
		}
	}
}

func TestParse_AllowedHosts(t *testing.T) {
	o, err := Parse(nil, envOf(nil), &bytes.Buffer{})
	if err != nil || len(o.AllowedHosts) != 0 {
		t.Fatalf("o=%+v err=%v", o, err)
	}
	o, err = Parse([]string{"--allowed-hosts", " FD.Internal, .Example.com ,,nas "}, envOf(nil), &bytes.Buffer{})
	if err != nil || strings.Join(o.AllowedHosts, "|") != "fd.internal|.example.com|nas" {
		t.Fatalf("o=%+v err=%v", o, err)
	}
	o, err = Parse(nil, envOf(map[string]string{"FLIGHTDECK_ALLOWED_HOSTS": "localhost"}), &bytes.Buffer{})
	if err != nil || strings.Join(o.AllowedHosts, "|") != "localhost" {
		t.Fatalf("o=%+v err=%v", o, err)
	}
	// The flag wins over the environment, an empty one included.
	o, err = Parse([]string{"--allowed-hosts", ""}, envOf(map[string]string{"FLIGHTDECK_ALLOWED_HOSTS": "localhost"}), &bytes.Buffer{})
	if err != nil || len(o.AllowedHosts) != 0 {
		t.Fatalf("o=%+v err=%v", o, err)
	}
	o, err = Parse([]string{"--allowed-hosts", "*"}, envOf(nil), &bytes.Buffer{})
	if err != nil || strings.Join(o.AllowedHosts, "|") != "*" {
		t.Fatalf("o=%+v err=%v", o, err)
	}
	// An entry that could never match a Host is refused at start, not
	// left to lock its operator out.
	for _, bad := range []string{"http://fd.internal", "fd.internal:4000", "fd.internal/path", "fd internal", "..example.com", "example.com.", "*.example.com", "fd_internal", "[::1]"} {
		if _, err := Parse([]string{"--allowed-hosts", "ok.internal," + bad}, envOf(nil), &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "--allowed-hosts") {
			t.Errorf("--allowed-hosts %q: err = %v, want it refused", bad, err)
		}
	}
}

// A mistyped flag of the health command prints nothing itself (the
// binary prints the error as one line); -h still prints the usage.
func TestParse_HealthCommandBadFlagPrintsNoUsage(t *testing.T) {
	var out bytes.Buffer
	_, err := Parse([]string{"health", "--nope"}, envOf(nil), &out)
	if err == nil || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("err = %v, want the flag named", err)
	}
	if out.Len() != 0 {
		t.Fatalf("the usage was printed for a bad flag:\n%s", out.String())
	}
	out.Reset()
	if _, err := Parse([]string{"health", "-h"}, envOf(nil), &out); !errors.Is(err, ErrHelp) || !strings.Contains(out.String(), "flightdeck health [flags]") || !strings.Contains(out.String(), "-listen") {
		t.Fatalf("health -h: err %v, output %q", err, out.String())
	}
	// The server keeps the usage on a bad flag.
	out.Reset()
	if _, err := Parse([]string{"--nope"}, envOf(nil), &out); err == nil || !strings.Contains(out.String(), "Usage: flightdeck") {
		t.Fatalf("the server's bad flag: err %v, output %q", err, out.String())
	}
}

// parseListen parses args and env and returns the resolved address, or
// fails the test.
func parseListen(t *testing.T, args []string, env map[string]string) string {
	t.Helper()
	o, err := Parse(args, envOf(env), &bytes.Buffer{})
	if err != nil {
		t.Fatalf("Parse(%q) with %v: %v", args, env, err)
	}
	return o.Listen
}

func TestParse_PortServesThisMachineOnly(t *testing.T) {
	for _, c := range []struct {
		args []string
		env  map[string]string
		want string
	}{
		{nil, nil, "127.0.0.1:4000"},
		{[]string{"--port", "4100"}, nil, "127.0.0.1:4100"},
		{[]string{"--port=4100"}, nil, "127.0.0.1:4100"},
		{[]string{"-port", "4100"}, nil, "127.0.0.1:4100"},
		{[]string{"-p", "4100"}, nil, "127.0.0.1:4100"},
		{[]string{"-p=4100"}, nil, "127.0.0.1:4100"},
		{[]string{"--p", "4100"}, nil, "127.0.0.1:4100"},
		{nil, map[string]string{"FLIGHTDECK_PORT": "4100"}, "127.0.0.1:4100"},
		// Surrounding blanks (a quoted value in an env file) and leading
		// zeros are not part of the number.
		{nil, map[string]string{"FLIGHTDECK_PORT": " 4100\n"}, "127.0.0.1:4100"},
		{[]string{"--port", "04100"}, nil, "127.0.0.1:4100"},
		{[]string{"--port", "1"}, nil, "127.0.0.1:1"},
		{[]string{"--port", "65535"}, nil, "127.0.0.1:65535"},
		// The flag wins over its variable; the last of the two spellings
		// on a line wins, as with any repeated flag.
		{[]string{"--port", "4100"}, map[string]string{"FLIGHTDECK_PORT": "5000"}, "127.0.0.1:4100"},
		{[]string{"-p", "4100"}, map[string]string{"FLIGHTDECK_PORT": "5000"}, "127.0.0.1:4100"},
		{[]string{"--port", "4100", "-p", "4200"}, nil, "127.0.0.1:4200"},
		// --domain binds its own ports; the listen address is still
		// resolved and checked, as --listen's always was.
		{[]string{"--port", "4100", "--domain", "fd.example.com"}, nil, "127.0.0.1:4100"},
	} {
		got := parseListen(t, c.args, c.env)
		if got != c.want {
			t.Errorf("Parse(%q) with %v: Listen = %q, want %q", c.args, c.env, got, c.want)
		}
		if !bootstrap.Loopback(got) {
			t.Errorf("Parse(%q) with %v: %q is not loopback; --port serves this machine only", c.args, c.env, got)
		}
	}
}

func TestParse_PublicServesEveryInterface(t *testing.T) {
	for _, c := range []struct {
		args []string
		env  map[string]string
		want string
	}{
		{[]string{"--public"}, nil, "0.0.0.0:4000"},
		{[]string{"--public=true"}, nil, "0.0.0.0:4000"},
		{[]string{"--public", "--port", "4100"}, nil, "0.0.0.0:4100"},
		{[]string{"-p", "4100", "--public"}, nil, "0.0.0.0:4100"},
		{nil, map[string]string{"FLIGHTDECK_PUBLIC": "true"}, "0.0.0.0:4000"},
		{nil, map[string]string{"FLIGHTDECK_PUBLIC": "1"}, "0.0.0.0:4000"},
		{nil, map[string]string{"FLIGHTDECK_PUBLIC": "false"}, "127.0.0.1:4000"},
		{nil, map[string]string{"FLIGHTDECK_PUBLIC": "true", "FLIGHTDECK_PORT": "4100"}, "0.0.0.0:4100"},
		// A flag and a variable of the same side combine.
		{[]string{"--port", "4100"}, map[string]string{"FLIGHTDECK_PUBLIC": "true"}, "0.0.0.0:4100"},
		{[]string{"--public"}, map[string]string{"FLIGHTDECK_PORT": "4100"}, "0.0.0.0:4100"},
		// The flag wins over its variable, false included.
		{[]string{"--public=false"}, map[string]string{"FLIGHTDECK_PUBLIC": "true"}, "127.0.0.1:4000"},
		// It is the mode --listen 0.0.0.0 is, and with --domain it binds
		// nothing, as that listen address does not.
		{[]string{"--public", "--domain", "fd.example.com"}, nil, "0.0.0.0:4000"},
	} {
		if got := parseListen(t, c.args, c.env); got != c.want {
			t.Errorf("Parse(%q) with %v: Listen = %q, want %q", c.args, c.env, got, c.want)
		}
	}
	if got := parseListen(t, []string{"--public"}, nil); bootstrap.DevMode(got, "") {
		t.Errorf("--public resolved to %q, which the binary would serve with the development token", got)
	}
	if got, want := parseListen(t, []string{"--public"}, nil), parseListen(t, []string{"--listen", "0.0.0.0:4000"}, nil); got != want {
		t.Errorf("--public is %q and --listen 0.0.0.0:4000 is %q; they must be one listener", got, want)
	}
	_, err := Parse(nil, envOf(map[string]string{"FLIGHTDECK_PUBLIC": "yes please"}), &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "FLIGHTDECK_PUBLIC") {
		t.Fatalf("a bad FLIGHTDECK_PUBLIC: err = %v", err)
	}
}

// A port with no host is this machine only, as --port is; an address
// that serves other machines is written out.
func TestParse_ListenPortWithoutHostIsLoopback(t *testing.T) {
	for _, c := range []struct {
		args []string
		env  map[string]string
		want string
		dev  bool
	}{
		{[]string{"--listen", ":4100"}, nil, "127.0.0.1:4100", true},
		{[]string{"--listen", "[]:4100"}, nil, "127.0.0.1:4100", true},
		{nil, map[string]string{"FLIGHTDECK_LISTEN": ":4100"}, "127.0.0.1:4100", true},
		{nil, map[string]string{"FLIGHTDECK_LISTEN": " :4100 "}, "127.0.0.1:4100", true},
		// Written-out addresses keep their meaning.
		{[]string{"--listen", "0.0.0.0:4100"}, nil, "0.0.0.0:4100", false},
		{[]string{"--listen", "[::]:4100"}, nil, "[::]:4100", false},
		{[]string{"--listen", "[::1]:4100"}, nil, "[::1]:4100", true},
		{[]string{"--listen", "127.0.0.2:4100"}, nil, "127.0.0.2:4100", true},
		{[]string{"--listen", "localhost:4100"}, nil, "localhost:4100", true},
		{[]string{"--listen", "10.0.0.5:4100"}, nil, "10.0.0.5:4100", false},
		{[]string{"--listen", "[fd00::5]:4100"}, nil, "[fd00::5]:4100", false},
		{[]string{"--listen", "127.0.0.1:0"}, nil, "127.0.0.1:0", true},
		// A value that is no address is the bind's to report, as before.
		{[]string{"--listen", "nonsense"}, nil, "nonsense", false},
	} {
		got := parseListen(t, c.args, c.env)
		if got != c.want {
			t.Errorf("Parse(%q) with %v: Listen = %q, want %q", c.args, c.env, got, c.want)
		}
		if dev := bootstrap.DevMode(got, ""); dev != c.dev {
			t.Errorf("Parse(%q) with %v: %q is in the development mode: %v, want %v", c.args, c.env, got, dev, c.dev)
		}
	}
	for _, args := range [][]string{{"--listen", ""}, {"--listen", " "}} {
		if _, err := Parse(args, envOf(nil), &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "must not be empty") {
			t.Errorf("Parse(%q): err = %v, want it refused as empty", args, err)
		}
	}
	// A number alone was never an address; the refusal names the form
	// that serves that port.
	for _, c := range []struct {
		args []string
		env  map[string]string
	}{
		{[]string{"--listen", "4100"}, nil},
		{nil, map[string]string{"FLIGHTDECK_LISTEN": "4100"}},
	} {
		_, err := Parse(c.args, envOf(c.env), &bytes.Buffer{})
		if err == nil {
			t.Errorf("Parse(%q) with %v: a port alone was accepted as --listen", c.args, c.env)
			continue
		}
		for _, want := range []string{"--listen", "FLIGHTDECK_LISTEN", "--port 4100", "FLIGHTDECK_PORT=4100"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("Parse(%q) with %v: error %q lacks %q", c.args, c.env, err, want)
			}
		}
	}
}

func TestParse_BadPortsSayWhatToPass(t *testing.T) {
	for _, bad := range []string{"0", "65536", "-1", "+4100", "4100.0", "0x10", "abc", "", " ", "41 00", "99999999999999999999"} {
		for name, c := range map[string]struct {
			args []string
			env  map[string]string
		}{
			"--port":          {[]string{"--port", bad}, nil},
			"-p":              {[]string{"-p=" + bad}, nil},
			"FLIGHTDECK_PORT": {nil, map[string]string{"FLIGHTDECK_PORT": bad}},
			"with --public":   {[]string{"--public", "--port", bad}, nil},
		} {
			if name == "FLIGHTDECK_PORT" && strings.TrimSpace(bad) == "" {
				continue // an empty variable is unset: the default port
			}
			_, err := Parse(c.args, envOf(c.env), &bytes.Buffer{})
			if err == nil {
				t.Errorf("%s %q accepted", name, bad)
				continue
			}
			for _, want := range []string{"--port", "FLIGHTDECK_PORT", "from 1 to 65535", "--port 4100", strconv.Quote(bad)} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("%s %q: error %q lacks %q", name, bad, err, want)
				}
			}
		}
	}
	// A port that --listen overrides is not looked at.
	if got := parseListen(t, []string{"--listen", "127.0.0.1:4100"}, map[string]string{"FLIGHTDECK_PORT": "nope"}); got != "127.0.0.1:4100" {
		t.Errorf("Listen = %q", got)
	}
}

// --listen names the whole address: with --port or --public it is a
// usage error naming both, on the command line or, with no flag
// deciding, in the environment. A flag of either side overrides the
// other side's variables.
func TestParse_ListenAndThePortFlagsDoNotCombine(t *testing.T) {
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"--port", "4100", "--listen", "127.0.0.1:4100"}, "--listen and --port were both given"},
		{[]string{"--listen", "127.0.0.1:4100", "-p", "4100"}, "--listen and -p were both given"},
		{[]string{"--public", "--listen", "0.0.0.0:4100"}, "--listen and --public were both given"},
		{[]string{"--public=false", "--listen", "127.0.0.1:4100"}, "--listen and --public were both given"},
		{[]string{"--public", "--port", "4100", "--listen", ":4100"}, "--listen and --port were both given"},
		{[]string{"health", "--public", "--listen", ":4100"}, "--listen and --public were both given"},
	} {
		_, err := Parse(c.args, envOf(nil), &bytes.Buffer{})
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("Parse(%q): err = %v, want %q", c.args, err, c.want)
			continue
		}
		for _, form := range []string{"--port <port>", "--public", "--listen <address>:<port>"} {
			if !strings.Contains(err.Error(), form) {
				t.Errorf("Parse(%q): error %q does not show %q", c.args, err, form)
			}
		}
	}

	for _, c := range []struct {
		env  map[string]string
		want string
	}{
		{map[string]string{"FLIGHTDECK_LISTEN": "0.0.0.0:4000", "FLIGHTDECK_PORT": "4100"}, "FLIGHTDECK_LISTEN and FLIGHTDECK_PORT are both set"},
		{map[string]string{"FLIGHTDECK_LISTEN": "0.0.0.0:4000", "FLIGHTDECK_PUBLIC": "true"}, "FLIGHTDECK_LISTEN and FLIGHTDECK_PUBLIC are both set"},
		// A variable counts when it is not empty, whatever it says.
		{map[string]string{"FLIGHTDECK_LISTEN": "10.0.0.5:4000", "FLIGHTDECK_PUBLIC": "false"}, "FLIGHTDECK_LISTEN and FLIGHTDECK_PUBLIC are both set"},
	} {
		_, err := Parse(nil, envOf(c.env), &bytes.Buffer{})
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("env %v: err = %v, want %q", c.env, err, c.want)
			continue
		}
		for _, form := range []string{"FLIGHTDECK_PORT=<port>", "FLIGHTDECK_PUBLIC=true", "FLIGHTDECK_LISTEN=<address>:<port>", "a flag on the command line overrides both"} {
			if !strings.Contains(err.Error(), form) {
				t.Errorf("env %v: error %q does not show %q", c.env, err, form)
			}
		}
	}

	env := map[string]string{"FLIGHTDECK_LISTEN": "10.0.0.5:4000", "FLIGHTDECK_PORT": "4200", "FLIGHTDECK_PUBLIC": "true"}
	for _, c := range []struct {
		args []string
		want string
	}{
		// A flag of the port side: FLIGHTDECK_LISTEN is out, the port
		// side's variables still apply.
		{[]string{"--port", "4100"}, "0.0.0.0:4100"},
		{[]string{"--public"}, "0.0.0.0:4200"},
		{[]string{"--public=false"}, "127.0.0.1:4200"},
		// --listen: both of the port side's variables are out.
		{[]string{"--listen", "127.0.0.1:4100"}, "127.0.0.1:4100"},
		{[]string{"--listen", ":4100"}, "127.0.0.1:4100"},
	} {
		if got := parseListen(t, c.args, env); got != c.want {
			t.Errorf("Parse(%q) with %v: Listen = %q, want %q", c.args, env, got, c.want)
		}
	}
	// With the port side's variables only, FLIGHTDECK_LISTEN set alone
	// applies as it always did.
	if got := parseListen(t, []string{"--port", "4100"}, map[string]string{"FLIGHTDECK_LISTEN": "0.0.0.0:4000"}); got != "127.0.0.1:4100" {
		t.Errorf("--port with FLIGHTDECK_LISTEN: Listen = %q, want 127.0.0.1:4100", got)
	}
	if got := parseListen(t, nil, map[string]string{"FLIGHTDECK_LISTEN": "10.0.0.5:4000", "FLIGHTDECK_PORT": ""}); got != "10.0.0.5:4000" {
		t.Errorf("FLIGHTDECK_LISTEN with an empty FLIGHTDECK_PORT: Listen = %q", got)
	}
	// --version reads none of it.
	if o, err := Parse([]string{"--version", "--port", "0", "--listen", ":1"}, envOf(nil), &bytes.Buffer{}); err != nil || !o.Version {
		t.Errorf("--version with listen flags: o=%+v err=%v", o, err)
	}
}

// The usage text describes --port first, then --public and --listen.
func TestParse_UsageDescribesThePortFlags(t *testing.T) {
	var out bytes.Buffer
	if _, err := Parse([]string{"-h"}, envOf(nil), &out); !errors.Is(err, ErrHelp) {
		t.Fatalf("err = %v, want ErrHelp", err)
	}
	usage := out.String()
	for _, want := range []string{"  -port string", "  -p string", "short for --port", "  -public\n", "FLIGHTDECK_PORT", "FLIGHTDECK_PUBLIC", "(default \"4000\")"} {
		if !strings.Contains(usage, want) {
			t.Errorf("the usage lacks %q:\n%s", want, usage)
		}
	}
	header, _, _ := strings.Cut(usage, "Flags:")
	port, public, listen := strings.Index(header, "--port 4100"), strings.Index(header, "--public lets other machines in"), strings.Index(header, "--listen <address>:<port>")
	if port < 0 || public < port || listen < public {
		t.Errorf("the usage does not describe --port, then --public, then --listen:\n%s", header)
	}
}

// Kubernetes gives FLIGHTDECK_PORT the address of a Service named
// flightdeck in every pod of its namespace (tcp://10.96.0.5:4000). That
// value reads as unset: for the port, and for the conflict with
// FLIGHTDECK_LISTEN, in the server and in the health command alike.
func TestParse_KubernetesServiceLinkIsNotAPort(t *testing.T) {
	for _, link := range []string{"tcp://10.96.0.5:4000", "udp://10.96.0.5:4000", "sctp://10.96.0.5:4000", "TCP://10.96.0.5:4000", " tcp://[fd00::5]:4000"} {
		for _, c := range []struct {
			args []string
			env  map[string]string
			want string
		}{
			{nil, map[string]string{"FLIGHTDECK_PORT": link}, "127.0.0.1:4000"},
			{nil, map[string]string{"FLIGHTDECK_PORT": link, "FLIGHTDECK_PUBLIC": "true"}, "0.0.0.0:4000"},
			// The image's environment: no conflict.
			{nil, map[string]string{"FLIGHTDECK_PORT": link, "FLIGHTDECK_LISTEN": "0.0.0.0:4000", "FLIGHTDECK_ALLOWED_HOSTS": "localhost"}, "0.0.0.0:4000"},
			{[]string{"health"}, map[string]string{"FLIGHTDECK_PORT": link, "FLIGHTDECK_LISTEN": "0.0.0.0:4000"}, "0.0.0.0:4000"},
			{[]string{"--public"}, map[string]string{"FLIGHTDECK_PORT": link}, "0.0.0.0:4000"},
			{[]string{"--port", "4100"}, map[string]string{"FLIGHTDECK_PORT": link}, "127.0.0.1:4100"},
		} {
			if got := parseListen(t, c.args, c.env); got != c.want {
				t.Errorf("Parse(%q) with %v: Listen = %q, want %q", c.args, c.env, got, c.want)
			}
		}
	}
	// Any other URL is no port either, and is refused as one.
	if _, err := Parse(nil, envOf(map[string]string{"FLIGHTDECK_PORT": "http://10.96.0.5:4000"}), &bytes.Buffer{}); err == nil ||
		!strings.Contains(err.Error(), "from 1 to 65535") {
		t.Errorf("FLIGHTDECK_PORT=http://…: err = %v, want the port refused", err)
	}
	// A --port flag with a link's value is a mistyped flag, not a link.
	if _, err := Parse([]string{"--port", "tcp://10.96.0.5:4000"}, envOf(nil), &bytes.Buffer{}); err == nil {
		t.Error("--port tcp://… accepted")
	}
}

// Parse says how a host-less listen address was given, for the binary's
// warning and its refusal beside a supplied token.
func TestParse_HostlessListenIsReportedAsGiven(t *testing.T) {
	for _, c := range []struct {
		args []string
		env  map[string]string
		want string
	}{
		{[]string{"--listen", ":4100"}, nil, "--listen :4100"},
		{[]string{"--listen", "[]:4100"}, nil, "--listen []:4100"},
		{[]string{"health", "--listen", ":4100"}, nil, "--listen :4100"},
		{nil, map[string]string{"FLIGHTDECK_LISTEN": ":4100"}, "FLIGHTDECK_LISTEN=:4100"},
		{nil, map[string]string{"FLIGHTDECK_LISTEN": " :4100\n"}, "FLIGHTDECK_LISTEN=:4100"},
		{[]string{"--listen", "127.0.0.1:4100"}, nil, ""},
		{[]string{"--listen", "0.0.0.0:4100"}, nil, ""},
		{[]string{"--port", "4100"}, nil, ""},
		{[]string{"--public"}, nil, ""},
		{nil, nil, ""},
		// A flag of the port side overrides a host-less variable.
		{[]string{"--port", "4100"}, map[string]string{"FLIGHTDECK_LISTEN": ":4200"}, ""},
	} {
		o, err := Parse(c.args, envOf(c.env), &bytes.Buffer{})
		if err != nil || o.HostlessListen != c.want {
			t.Errorf("Parse(%q) with %v: HostlessListen = %q (err %v), want %q", c.args, c.env, o.HostlessListen, err, c.want)
		}
	}
}

// A bad FLIGHTDECK_PUBLIC is reported only when --public does not
// override it, and never in the way of --version or --help.
func TestParse_BadPublicVariableIsReportedOnlyWhenItApplies(t *testing.T) {
	env := map[string]string{"FLIGHTDECK_PUBLIC": "yes please"}
	if got := parseListen(t, []string{"--public=false"}, env); got != "127.0.0.1:4000" {
		t.Errorf("--public=false: Listen = %q", got)
	}
	if got := parseListen(t, []string{"--public", "--port", "4100"}, env); got != "0.0.0.0:4100" {
		t.Errorf("--public: Listen = %q", got)
	}
	if o, err := Parse([]string{"--version"}, envOf(env), &bytes.Buffer{}); err != nil || !o.Version {
		t.Errorf("--version: o=%+v err=%v", o, err)
	}
	var out bytes.Buffer
	if _, err := Parse([]string{"--help"}, envOf(env), &out); !errors.Is(err, ErrHelp) || !strings.Contains(out.String(), "-public") {
		t.Errorf("--help: err %v, output %q", err, out.String())
	}
	for _, args := range [][]string{nil, {"--port", "4100"}, {"health"}, {"--listen", "127.0.0.1:4100"}} {
		_, err := Parse(args, envOf(env), &bytes.Buffer{})
		if err == nil || !strings.Contains(err.Error(), "FLIGHTDECK_PUBLIC must be true or false") || !strings.Contains(err.Error(), "yes please") {
			t.Errorf("Parse(%q): err = %v, want the variable refused", args, err)
		}
	}
	// --public takes its value with "=", as every boolean flag does: a
	// separate "false" is an argument, and refused.
	if _, err := Parse([]string{"--public", "false"}, envOf(nil), &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), `unexpected argument "false"`) {
		t.Errorf("--public false: err = %v, want an unexpected-argument error", err)
	}
}

// An IPv6 address without brackets never reaches the bind: the refusal
// shows it bracketed.
func TestParse_UnbracketedIPv6IsAUsageError(t *testing.T) {
	for _, c := range []struct {
		args []string
		env  map[string]string
		hint string
	}{
		{[]string{"--listen", "::1"}, nil, "[::1]:<port>"},
		{[]string{"--listen", "::1:4000"}, nil, "[::1]:4000"},
		{[]string{"--listen", ":::4000"}, nil, "[::]:4000"},
		{[]string{"--listen", "fd00::5:4000"}, nil, "[fd00::5]:4000"},
		{[]string{"--listen", "fe80::1%eth0:4000"}, nil, "[fe80::1%eth0]:4000"},
		{nil, map[string]string{"FLIGHTDECK_LISTEN": "::1:4000"}, "[::1]:4000"},
		{[]string{"health", "--listen", "::1:4000"}, nil, "[::1]:4000"},
	} {
		_, err := Parse(c.args, envOf(c.env), &bytes.Buffer{})
		if err == nil || !strings.Contains(err.Error(), "an IPv6 address without brackets") || !strings.Contains(err.Error(), c.hint) {
			t.Errorf("Parse(%q) with %v: err = %v, want the refusal with %s", c.args, c.env, err, c.hint)
		}
	}
	// Bracketed, it is an address like any other.
	if got := parseListen(t, []string{"--listen", "[::1]:4000"}, nil); got != "[::1]:4000" {
		t.Errorf("Listen = %q", got)
	}
}

// The mode of the spellings a person or a tool may use for loopback.
// Those Go reads as a loopback literal run in the development mode; the
// others are left to the bind, where the binary refuses a socket that
// disagrees with the mode.
func TestParse_ModeOfLoopbackSpellings(t *testing.T) {
	for _, c := range []struct {
		listen string
		dev    bool
	}{
		{"LOCALHOST:4100", true},
		{"localhost.:4100", true},
		{"[::1%lo]:4100", true},
		{"[::ffff:127.0.0.1]:4100", true},
		{"127.0.0.53:4100", true},
		{"0:4100", false},
		{"127.1:4100", false},
		{"localhost.localdomain:4100", false},
	} {
		got := parseListen(t, []string{"--listen", c.listen}, nil)
		if got != c.listen {
			t.Errorf("--listen %s: Listen = %q, want it unchanged", c.listen, got)
		}
		if dev := bootstrap.DevMode(got, ""); dev != c.dev {
			t.Errorf("--listen %s: development mode %v, want %v", c.listen, dev, c.dev)
		}
	}
}

// literalLoopback is the test's statement of the development mode's
// rule: the host is localhost (in any case, with or without the
// trailing dot of a fully qualified name) or an IP literal on loopback,
// an interface zone aside.
func literalLoopback(host string) bool {
	if strings.EqualFold(strings.TrimSuffix(host, "."), "localhost") {
		return true
	}
	ip, _, _ := strings.Cut(host, "%")
	parsed := net.ParseIP(ip)
	return parsed != nil && parsed.IsLoopback()
}

// Whatever the arguments and the three variables hold, an address Parse
// accepts has a host, and the binary is in the development mode exactly
// when that host is a loopback literal or localhost. The seeds run with
// every `go test`; `go test -fuzz FuzzParse_ListenAddress` searches on.
func FuzzParse_ListenAddress(f *testing.F) {
	for _, seed := range [][4]string{
		{"", "", "", ""},
		{"--port 4100", "", "", ""},
		{"-p 4100 --public", "", "", ""},
		{"--listen :4100", "", "", ""},
		{"--listen []:4100", "", "", ""},
		{"", ":4100", "", ""},
		{"", ":4100", "tcp://10.96.0.5:4000", ""},
		{"", "0.0.0.0:4000", "tcp://10.96.0.5:4000", "true"},
		{"--listen localhost.:4100", "", "", ""},
		{"--listen LOCALHOST:4100", "", "", ""},
		{"--listen [::1%lo]:4100", "", "", ""},
		{"--listen [::ffff:127.0.0.1]:4100", "", "", ""},
		{"--listen 127.1:4100", "", "", ""},
		{"--listen 0:4100", "", "", ""},
		{"--listen ::1:4100", "", "", ""},
		{"--listen nonsense", "", "", ""},
		{"--public=false", ":4100", "", "true"},
		{"health --port 4100", "", "4200", "1"},
		{"--port 4100", "10.0.0.5:4000", "", "yes"},
	} {
		f.Add(seed[0], seed[1], seed[2], seed[3])
	}
	f.Fuzz(func(t *testing.T, args, listen, port, public string) {
		var argv []string
		if args != "" {
			argv = strings.Split(args, " ")
		}
		env := envOf(map[string]string{"FLIGHTDECK_LISTEN": listen, "FLIGHTDECK_PORT": port, "FLIGHTDECK_PUBLIC": public})
		o, err := Parse(argv, env, io.Discard)
		if err != nil || o.Version {
			return
		}
		host, _, splitErr := net.SplitHostPort(o.Listen)
		if splitErr == nil && host == "" {
			t.Fatalf("Parse(%q) with %q, %q, %q returned the host-less address %q", argv, listen, port, public, o.Listen)
		}
		want := splitErr == nil && literalLoopback(host)
		if got := bootstrap.DevMode(o.Listen, ""); got != want {
			t.Fatalf("Parse(%q) with %q, %q, %q returned %q: development mode %v, want %v", argv, listen, port, public, o.Listen, got, want)
		}
	})
}
