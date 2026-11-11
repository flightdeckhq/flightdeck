package cli

import (
	"bytes"
	"errors"
	"strings"
	"testing"

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
