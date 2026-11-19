package cli

import (
	"bytes"
	"flag"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeURLFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "database-url")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// The URL in a file is the URL itself: white space around it and a
// byte-order mark go, nothing else changes, and the file is named in
// Options so a caller can pass the path on.
func TestParse_ReadsTheDatabaseURLFromAFile(t *testing.T) {
	const url = "postgres://fd:p%40ss@db.internal:5432/fd?sslmode=require"
	for name, content := range map[string]string{
		"plain":            url,
		"with a newline":   url + "\n",
		"with white space": "  \t" + url + " \r\n",
		"with a BOM":       byteOrderMark + url + "\n",
	} {
		path := writeURLFile(t, content)
		for how, parse := range map[string]func() (Options, error){
			"flag": func() (Options, error) { return Parse([]string{"--database-url-file", path}, envOf(nil), io.Discard) },
			"variable": func() (Options, error) {
				return Parse(nil, envOf(map[string]string{databaseURLFileEnv: path}), io.Discard)
			},
		} {
			o, err := parse()
			if err != nil || o.DatabaseURL != url || o.DatabaseURLFile != path {
				t.Errorf("%s, by %s: URL %q from %q (%v), want %q from %q", name, how, o.DatabaseURL, o.DatabaseURLFile, err, url, path)
			}
		}
	}
	// A SQLite URL works the same way.
	o, err := Parse([]string{"--database-url-file", writeURLFile(t, "sqlite:///srv/fd/flightdeck.db\n")}, envOf(nil), io.Discard)
	if err != nil || o.DatabaseURL != "sqlite:///srv/fd/flightdeck.db" {
		t.Errorf("a SQLite URL in the file: %q, %v", o.DatabaseURL, err)
	}
}

// The two forms are one setting, under --listen's rule: a flag of either
// form beats the other form's variable, and both given together are a
// usage error naming both.
func TestParse_TheURLAndItsFileAreOneSetting(t *testing.T) {
	fileURL := "postgres://from-file/db"
	path := writeURLFile(t, fileURL)
	both := envOf(map[string]string{databaseURLEnv: "postgres://from-env/db", databaseURLFileEnv: path})

	if _, err := Parse([]string{"--database-url", "postgres://flag/db", "--database-url-file", path}, envOf(nil), io.Discard); err == nil ||
		!strings.Contains(err.Error(), "--database-url and --database-url-file were both given") {
		t.Errorf("both flags: %v", err)
	}
	if _, err := Parse(nil, both, io.Discard); err == nil ||
		!strings.Contains(err.Error(), databaseURLEnv+" and "+databaseURLFileEnv+" are both set") {
		t.Errorf("both variables: %v", err)
	}
	if o, err := Parse([]string{"--database-url", "postgres://flag/db"}, both, io.Discard); err != nil || o.DatabaseURL != "postgres://flag/db" || o.DatabaseURLFile != "" {
		t.Errorf("--database-url over both variables: %+v, %v", o, err)
	}
	if o, err := Parse([]string{"--database-url-file", path}, both, io.Discard); err != nil || o.DatabaseURL != fileURL {
		t.Errorf("--database-url-file over both variables: %+v, %v", o, err)
	}
	// The health command opens no database, so it reads no file either.
	if o, err := Parse([]string{"health", "--database-url-file", "/no/such/file"}, envOf(nil), io.Discard); err != nil || !o.Health {
		t.Errorf("health with a file that is not there: %v", err)
	}
}

// A file that cannot give a URL is refused, naming the file and never
// its content.
func TestParse_RefusesAFileThatHoldsNoURLWithoutRepeatingIt(t *testing.T) {
	big := writeURLFile(t, "postgres://u:secretpw@h/db?x="+strings.Repeat("a", maxDatabaseURLFileBytes))
	for name, tc := range map[string]struct{ path, want string }{
		"missing":       {filepath.Join(t.TempDir(), "nope"), "no such file"},
		"empty":         {writeURLFile(t, " \n"), "is empty"},
		"not a URL":     {writeURLFile(t, "mysql://u:secretpw@h/db"), "got mysql://"},
		"no scheme":     {writeURLFile(t, "secretpw"), "a value with no scheme"},
		"too large":     {big, "larger than a database URL"},
		"a directory":   {t.TempDir(), "--database-url-file"},
		"empty flag":    {"", "--database-url-file is empty"},
		"SQLite memory": {writeURLFile(t, "sqlite://:memory:"), "names no SQLite file"},
	} {
		_, err := Parse([]string{"--database-url-file", tc.path}, envOf(nil), io.Discard)
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: error %q lacks %q", name, err, tc.want)
		}
		if tc.path != "" && name != "a directory" && name != "missing" && !strings.Contains(err.Error(), tc.path) {
			t.Errorf("%s: error %q does not name the file", name, err)
		}
		if strings.Contains(err.Error(), "secretpw") {
			t.Errorf("%s: error %q repeats the file's content", name, err)
		}
	}
}

// ParseCommand takes the server's flags under the same rules, beside the
// command's own, with the command's usage.
func TestParseCommand_TakesTheServersFlagsBesideItsOwn(t *testing.T) {
	var dry bool
	cmd := Command{
		Name:  "flightdeck service install",
		Flags: func(fs *flag.FlagSet) { fs.BoolVar(&dry, "dry-run", false, "print only") },
		Usage: func(w io.Writer) { _, _ = io.WriteString(w, "Usage: flightdeck service install [flags]\n") },
	}
	o, err := ParseCommand([]string{"--dry-run", "--public", "--port", "4100", "--metrics"},
		envOf(map[string]string{"FLIGHTDECK_DATA_DIR": "/srv/fd"}), io.Discard, cmd)
	if err != nil || !dry || o.Listen != PublicHost+":4100" || o.DataDir != "/srv/fd" || !o.Metrics {
		t.Errorf("ParseCommand = %+v, dry %v, %v", o, dry, err)
	}
	// "health" is a server subcommand, not a word a command takes.
	if _, err := ParseCommand([]string{"health"}, envOf(nil), io.Discard, cmd); err == nil {
		t.Error("ParseCommand read health as the health command")
	}
	// --version is the server's alone.
	var out bytes.Buffer
	if _, err := ParseCommand([]string{"--version"}, envOf(nil), &out, cmd); err == nil {
		t.Error("ParseCommand accepted --version")
	}
	out.Reset()
	if _, err := ParseCommand([]string{"--help"}, envOf(nil), &out, cmd); err != ErrHelp ||
		!strings.HasPrefix(out.String(), "Usage: flightdeck service install") || !strings.Contains(out.String(), "-database-url-file") ||
		!strings.Contains(out.String(), "-dry-run") {
		t.Errorf("--help: %v\n%s", err, out.String())
	}
}

// A command's arguments may come before, between or after its flags, up
// to MaxArgs of them; the server's own line still takes none.
func TestParseCommand_TakesArgumentsAmongTheFlags(t *testing.T) {
	cmd := Command{Name: "flightdeck restore", Flags: func(*flag.FlagSet) {}, Usage: func(io.Writer) {}, MaxArgs: 1}
	for _, args := range [][]string{
		{"backup.db", "--data-dir", "/srv/fd"},
		{"--data-dir", "/srv/fd", "backup.db"},
	} {
		o, err := ParseCommand(args, envOf(nil), io.Discard, cmd)
		if err != nil || len(o.Args) != 1 || o.Args[0] != "backup.db" || o.DataDir != "/srv/fd" {
			t.Errorf("%q: %+v, %v", args, o, err)
		}
	}
	if _, err := ParseCommand([]string{"a.db", "--data-dir", "/srv/fd", "b.db"}, envOf(nil), io.Discard, cmd); err == nil ||
		!strings.Contains(err.Error(), `unexpected argument "b.db"`) {
		t.Errorf("a second argument: %v", err)
	}
	if _, err := Parse([]string{"backup.db"}, envOf(nil), io.Discard); err == nil {
		t.Error("the server's line took an argument")
	}
}

func TestParse_UsageNamesTheServiceCommand(t *testing.T) {
	var out bytes.Buffer
	if _, err := Parse([]string{"--help"}, envOf(nil), &out); err != ErrHelp {
		t.Fatal(err)
	}
	for _, want := range []string{"flightdeck service install|status|restart|remove", "flightdeck service install keeps Flightdeck running", "-database-url-file"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("the usage lacks %q:\n%s", want, out.String())
		}
	}
}
