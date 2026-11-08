package storage

import "testing"

// The file: URI SQLite opens percent-encodes the path, so the
// characters SQLite's URI parser gives meaning to cannot truncate or
// change it, and a Windows drive path takes the documented form.
func TestSQLiteFileURI(t *testing.T) {
	cases := map[string]string{
		"/var/lib/fd.db":                       "file:///var/lib/fd.db",
		"rel/fd.db":                            "file:rel/fd.db",
		"/data/a#b/fd.db":                      "file:///data/a%23b/fd.db",
		"/data/x?y/fd.db":                      "file:///data/x%3Fy/fd.db",
		"/data/50%/fd.db":                      "file:///data/50%25/fd.db",
		"/data/%41/fd.db":                      "file:///data/%2541/fd.db",
		"/data/My Documents/fd.db":             "file:///data/My%20Documents/fd.db",
		`C:\Users\omria\flightdeck\fd.db`:      "file:///C:/Users/omria/flightdeck/fd.db",
		"C:/Users/omria/flightdeck/fd.db":      "file:///C:/Users/omria/flightdeck/fd.db",
		`d:\Local Settings\flightdeck#1\fd.db`: "file:///d:/Local%20Settings/flightdeck%231/fd.db",
	}
	for path, want := range cases {
		if got := sqliteFileURI(path); got != want {
			t.Errorf("sqliteFileURI(%q) = %q, want %q", path, got, want)
		}
	}
	for _, p := range []string{"C:", "Cx/y", "/C:/y", ":memory:"} {
		if isWindowsDrivePath(p) {
			t.Errorf("%q taken for a Windows drive path", p)
		}
	}
	// The DSN keeps the URI intact and puts the pragmas after it; the
	// first "?" is ours, so modernc finds the query where it expects it.
	dsn := sqliteDSN("/data/x?y/fd.db", false)
	if want := "file:///data/x%3Fy/fd.db?"; dsn[:len(want)] != want {
		t.Errorf("sqliteDSN = %q, want prefix %q", dsn, want)
	}
}
