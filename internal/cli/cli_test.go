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
