package service

import (
	"bytes"
	"encoding/xml"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the golden files under testdata")

// golden compares got with testdata/name, or rewrites it with -update.
func golden(t *testing.T, name string, got []byte) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if *update {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (go test -run %s -update writes it)", err, t.Name())
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s differs from what was rendered (go test -update rewrites it after a deliberate change):\n--- got\n%s\n--- want\n%s", path, got, want)
	}
}

// awkward is a configuration with a value of every kind that a format
// could misread: spaces, both quotes, a backslash, %, $ and a variable's
// name, systemd specifiers, XML's special characters and non-ASCII text.
var awkward = Config{
	Binary:          "/opt/flight deck/bin/flightdeck",
	Listen:          "127.0.0.1:4100",
	DataDir:         `/home/ada/Flight "Deck" 'n' 100% $HOME ${USER} %h \back <&> é`,
	DatabaseURLFile: "/home/ada/.secrets/fd url",
	AllowedHosts:    []string{"fd.internal", ".example.com"},
	Metrics:         true,
}

func TestSystemdUnit_Golden(t *testing.T) {
	golden(t, "flightdeck.service.golden", (&systemd{}).render(awkward))
}

func TestLaunchdPlist_Golden(t *testing.T) {
	golden(t, "com.flightdeck-hq.flightdeck.plist.golden", (&launchd{}).render(awkward))
}

// Every value comes back from the file exactly as it went in: the reader
// applies the unquoting systemd applies, and the plist reader the XML
// decoding launchd applies.
func TestEveryValueSurvivesTheFile(t *testing.T) {
	values := []string{
		"/plain/path",
		"/with space/and  two",
		`/q"uote/and'single`,
		`/back\slash\`,
		"/100%/%h/%%",
		"/$HOME/${USER}/$$",
		"/xml/<tag>&amp;</tag>",
		"/ünïcödé/日本",
		"/trailing space ",
	}
	for _, v := range values {
		c := awkward
		c.DataDir = v
		c.DatabaseURLFile = v + "/url"
		for name, m := range map[string]manager{"systemd": &systemd{}, "launchd": &launchd{}} {
			argv, err := m.argv(m.render(c))
			if err != nil {
				t.Fatalf("%s, %q: %v", name, v, err)
			}
			if !reflect.DeepEqual(argv, c.Argv()) {
				t.Errorf("%s, %q: read back %q, wrote %q", name, v, argv, c.Argv())
			}
			back, err := configOf(argv)
			if err != nil || !reflect.DeepEqual(back, c) {
				t.Errorf("%s, %q: config read back as %+v (%v), want %+v", name, v, back, err, c)
			}
		}
	}
}

// systemd reads % as a specifier and $ as a variable anywhere on the
// ExecStart line, inside quotes too: each is doubled, and nothing else
// of the line is left that systemd would expand.
func TestSystemdUnit_QuotesEveryArgumentAndDoublesSpecifiers(t *testing.T) {
	unit := string((&systemd{}).render(awkward))
	var exec string
	for _, line := range strings.Split(unit, "\n") {
		if v, ok := strings.CutPrefix(line, "ExecStart="); ok {
			exec = v
		}
	}
	if !strings.Contains(exec, `"/home/ada/Flight \"Deck\" 'n' 100%% $$HOME $${USER} %%h \\back <&> é"`) {
		t.Errorf("the data dir is not quoted and escaped as systemd reads it: %s", exec)
	}
	unescaped := strings.NewReplacer("%%", "", "$$", "").Replace(exec)
	if strings.ContainsAny(unescaped, "%$") {
		t.Errorf("ExecStart has a %% or $ that systemd would expand: %s", exec)
	}
	for _, want := range []string{"Restart=on-failure", "RestartSec=5", "StartLimitIntervalSec=0", "TimeoutStopSec=75", "WantedBy=default.target"} {
		if !strings.Contains(unit, "\n"+want+"\n") {
			t.Errorf("the unit lacks %s:\n%s", want, unit)
		}
	}
	if !strings.HasPrefix(unit, "# "+marker) {
		t.Errorf("the unit does not begin with the line that says who wrote it:\n%s", unit)
	}
}

// The plist is a well-formed property list that a strict XML reader
// accepts, with the keys launchd needs.
func TestLaunchdPlist_IsWellFormedWithTheKeysLaunchdReads(t *testing.T) {
	content := (&launchd{}).render(awkward)
	dec := xml.NewDecoder(bytes.NewReader(content))
	dec.Strict = true
	for {
		_, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("the plist is not well-formed XML: %v\n%s", err, content)
		}
	}
	for _, want := range []string{
		"<key>Label</key>\n\t<string>com.flightdeck-hq.flightdeck</string>",
		"<key>RunAtLoad</key>\n\t<true/>",
		"<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>",
		"<key>ExitTimeOut</key>\n\t<integer>75</integer>",
		"<key>StandardOutPath</key>\n\t<string>/home/ada/Flight &#34;Deck&#34; &#39;n&#39; 100% $HOME ${USER} %h \\back &lt;&amp;&gt; é/flightdeck.log</string>",
	} {
		if !strings.Contains(string(content), want) {
			t.Errorf("the plist lacks %q:\n%s", want, content)
		}
	}
}

func TestConfigArgv_SpellsTheListenAddressAsAPersonWould(t *testing.T) {
	for _, tc := range []struct {
		listen string
		want   []string
	}{
		{"127.0.0.1:4100", []string{"--port", "4100"}},
		{"0.0.0.0:4100", []string{"--public", "--port", "4100"}},
		{"10.0.0.5:4000", []string{"--listen", "10.0.0.5:4000"}},
		{"[::1]:4100", []string{"--listen", "[::1]:4100"}},
		{"localhost:4100", []string{"--listen", "localhost:4100"}},
	} {
		c := Config{Binary: "/b/flightdeck", Listen: tc.listen, DataDir: "/d"}
		argv := c.Argv()
		want := append(append([]string{"/b/flightdeck"}, tc.want...), "--data-dir", "/d")
		if !reflect.DeepEqual(argv, want) {
			t.Errorf("%s: argv %q, want %q", tc.listen, argv, want)
		}
		back, err := configOf(argv)
		if err != nil || back.Listen != tc.listen {
			t.Errorf("%s: read back as %q (%v)", tc.listen, back.Listen, err)
		}
	}
}

func TestConfigOf_RefusesACommandLineItDidNotWrite(t *testing.T) {
	for _, argv := range [][]string{
		nil,
		{"flightdeck", "--data-dir", "/d"},
		{"/b/flightdeck", "--port", "4100"},
		{"/b/flightdeck", "--data-dir", "/d", "--domain", "x.example.com"},
		{"/b/flightdeck", "--data-dir", "/d", "serve"},
	} {
		if c, err := configOf(argv); err == nil {
			t.Errorf("%q read as %+v", argv, c)
		}
	}
}

func TestCheckValues_RefusesWhatNeitherFormatCarries(t *testing.T) {
	for _, v := range []string{"/a\nb", "/a\tb", "/a\x00b", "/a\x7fb", "/a\xffb"} {
		if err := checkValues([]string{"/b/flightdeck", "--data-dir", v}); err == nil {
			t.Errorf("%q accepted", v)
		}
	}
	if err := checkValues(awkward.Argv()); err != nil {
		t.Errorf("the awkward but printable values are refused: %v", err)
	}
}

func TestSystemdWords_ReadsUnquotedWordsTooAndRefusesAnOpenQuote(t *testing.T) {
	words, err := systemdWords(`/b/flightdeck --port 4100  "--data-dir" "/a b" 100%%`)
	if err != nil || !reflect.DeepEqual(words, []string{"/b/flightdeck", "--port", "4100", "--data-dir", "/a b", "100%"}) {
		t.Errorf("words %q, %v", words, err)
	}
	if _, err := systemdWords(`"/b/flightdeck" "--data-dir`); err == nil {
		t.Error("an unclosed quote was accepted")
	}
}

func TestShellQuote(t *testing.T) {
	got := shellQuote([]string{"/b/flightdeck", "--data-dir", "/a b/it's", "--port", "4100", ""})
	if want := `/b/flightdeck --data-dir '/a b/it'\''s' --port 4100 ''`; got != want {
		t.Errorf("shellQuote = %s, want %s", got, want)
	}
}

func TestDashboardURL(t *testing.T) {
	for listen, want := range map[string]string{
		"127.0.0.1:4100": "http://localhost:4100",
		"[::1]:4100":     "http://localhost:4100",
		"0.0.0.0:4000":   "http://<this-host>:4000",
		"[::]:4000":      "http://<this-host>:4000",
		"10.0.0.5:4000":  "http://10.0.0.5:4000",
	} {
		if got := DashboardURL(listen); got != want {
			t.Errorf("DashboardURL(%s) = %s, want %s", listen, got, want)
		}
	}
}
