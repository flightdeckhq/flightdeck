package connect

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every case of contracts/server_urls.json, the cases the sensor, the
// plugin and the playground agree on: flightdeck connect compares the
// saved server with the one asked for by the same rule.
func TestServerBase_Contract(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "contracts", "server_urls.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Cases []struct {
			Value, Ingest, API, Why string
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	if len(contract.Cases) == 0 {
		t.Fatal("the contract has no cases")
	}
	for _, c := range contract.Cases {
		base := serverBase(c.Value)
		if got := base + "/ingest"; got != c.Ingest {
			t.Errorf("%s: serverBase(%q) = %q, so the ingestion URL is %q; want %q", c.Why, c.Value, base, got, c.Ingest)
		}
		if got := base + "/api"; got != c.API {
			t.Errorf("%s: serverBase(%q) gives the API URL %q; want %q", c.Why, c.Value, got, c.API)
		}
	}
}

func TestSameServer(t *testing.T) {
	same := [][2]string{
		{"http://localhost:4000/", "http://localhost:4000"},
		{"http://localhost:4000/ingest", "http://localhost:4000"},
		{"HTTP://LocalHost:4000/ingest/", "http://localhost:4000"},
		{"https://flightdeck.example.com:443/fd/ingest", "https://flightdeck.example.com/fd"},
		{"", "http://localhost:4000/ingest"},
		{"", ""},
	}
	for _, c := range same {
		if !sameServer(c[0], c[1]) || !sameServer(c[1], c[0]) {
			t.Errorf("sameServer(%q, %q) = false; want true", c[0], c[1])
		}
	}
	different := [][2]string{
		{"http://localhost:4000", "http://localhost:4100"},
		{"http://localhost:4000", "https://localhost:4000"},
		{"https://example.com/fd", "https://example.com/FD"},
		{"", "https://flightdeck.example.com"},
	}
	for _, c := range different {
		if sameServer(c[0], c[1]) {
			t.Errorf("sameServer(%q, %q) = true; want false", c[0], c[1])
		}
	}
}

func TestDecodeText(t *testing.T) {
	token := "ftd_0123456789abcdef0123456789abcdef"
	utf16le := []byte{0xFF, 0xFE}
	for _, r := range token + "\r\n" {
		utf16le = append(utf16le, byte(r), 0)
	}
	utf16be := []byte{0xFE, 0xFF}
	for _, r := range token {
		utf16be = append(utf16be, 0, byte(r))
	}
	for name, data := range map[string][]byte{
		"UTF-8":                      []byte(token + "\n"),
		"UTF-8 with a mark":          append([]byte{0xEF, 0xBB, 0xBF}, token...),
		"UTF-16 LE (PowerShell 5.1)": utf16le,
		"UTF-16 BE":                  utf16be,
	} {
		if got := strings.TrimSpace(decodeText(data)); got != token {
			t.Errorf("%s: decodeText = %q; want the token", name, got)
		}
	}
}
