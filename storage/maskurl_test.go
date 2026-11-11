package storage_test

import (
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/storage"
)

func TestMaskURL(t *testing.T) {
	cases := map[string]string{
		// The password of the userinfo.
		"postgres://flightdeck:flightdeck_dev@localhost:5432/fd?sslmode=disable": "postgres://flightdeck:***@localhost:5432/fd?sslmode=disable",
		"postgresql://u:p%40ss@db.example/fd":                                    "postgresql://u:***@db.example/fd",
		// No secret: as written.
		"postgres://flightdeck@localhost/fd":                "postgres://flightdeck@localhost/fd",
		"postgres://localhost/fd?sslmode=require&sslkey=/k": "postgres://localhost/fd?sslmode=require&sslkey=/k",
		"postgres://localhost/fd?passfile=/home/u/.pgpass":  "postgres://localhost/fd?passfile=/home/u/.pgpass",
		"not a url at all": "not a url at all",
		"":                 "",
		// The secrets pgx reads from the query, wherever they stand
		// and however the key is spelled; the other parameters keep
		// their order and encoding.
		"postgres://localhost/x?user=flightdeck&password=secretq":                   "postgres://localhost/x?user=flightdeck&password=***",
		"postgres://localhost/x?password=secretq&sslmode=disable":                   "postgres://localhost/x?password=***&sslmode=disable",
		"postgres://u:pw@h/x?sslpassword=keypass&application_name=a%20b&PASSWORD=p": "postgres://u:***@h/x?sslpassword=***&application_name=a%20b&PASSWORD=***",
		"postgres://h/x?pass%77ord=secretq":                                         "postgres://h/x?pass%77ord=***",
		"postgres://h/x?password=":                                                  "postgres://h/x?password=***",
		// A NATS URL: a password, or the token in the user slot.
		"nats://user:pw@nats:4222": "nats://user:***@nats:4222",
		"nats://tok3n@nats:4222":   "nats://***@nats:4222",
		"tls://tok3n@nats:4222":    "tls://***@nats:4222",
		"nats://nats:4222":         "nats://nats:4222",
		// A SQLite URL holds no secret and its path is not a URL path.
		"sqlite:///home/o m/a#b/x?password=y/50%/flightdeck.db":  "sqlite:///home/o m/a#b/x?password=y/50%/flightdeck.db",
		`sqlite://C:\Users\omria\AppData\Local\flightdeck\fd.db`: `sqlite://C:\Users\omria\AppData\Local\flightdeck\fd.db`,
		// A URL that does not parse is shown without anything that
		// could be its secret.
		"postgres://flightdeck:pa ss@localhost:5432/db%zz": "postgres://…",
		"%zz": "…",
	}
	for in, want := range cases {
		if got := storage.MaskURL(in); got != want {
			t.Errorf("MaskURL(%q)\n got %q\nwant %q", in, got, want)
		}
	}
	// Whatever the input, no secret of these survives.
	for _, in := range []string{
		"postgres://u:hunter2@h/x?password=hunter2&sslpassword=hunter2",
		"nats://hunter2@h:4222",
		"postgres://u:hunter2 @h/x%zz",
	} {
		if got := storage.MaskURL(in); strings.Contains(got, "hunter2") {
			t.Errorf("MaskURL(%q) = %q still holds the secret", in, got)
		}
	}
}
