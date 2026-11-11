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

func TestParse_DefaultsNeedOnlyTheDatabase(t *testing.T) {
	var out bytes.Buffer
	o, err := Parse([]string{"--database-url", "postgres://u:p@h/db"}, envOf(nil), &out)
	if err != nil {
		t.Fatal(err)
	}
	if o.Listen != DefaultListen || o.DataDir != datadir.Default() || o.NatsURL != "" || o.Domain != "" || o.Metrics {
		t.Fatalf("%+v", o)
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

func TestParse_MissingDatabaseSaysSQLiteIsComing(t *testing.T) {
	_, err := Parse(nil, envOf(nil), &bytes.Buffer{})
	if err == nil {
		t.Fatal("want an error")
	}
	for _, want := range []string{"--database-url", "FLIGHTDECK_DATABASE_URL", "SQLite"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q lacks %q", err, want)
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
	if !strings.Contains(out.String(), "--database-url") && !strings.Contains(out.String(), "-database-url") {
		t.Fatalf("usage %q does not list the flags", out.String())
	}
	_, err = Parse([]string{"serve"}, envOf(map[string]string{"FLIGHTDECK_DATABASE_URL": "x"}), &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), `"serve"`) {
		t.Fatalf("err = %v", err)
	}
}
