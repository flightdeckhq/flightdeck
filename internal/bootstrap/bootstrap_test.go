package bootstrap

import (
	"context"
	"testing"
)

func TestLoopback(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1:4000":   true,
		"127.0.0.2:4000":   true,
		"localhost:4000":   true,
		"LOCALHOST:4100":   true,
		"[::1]:4000":       true,
		":4000":            false,
		"0.0.0.0:4000":     false,
		"[::]:4000":        false,
		"192.168.1.10:80":  false,
		"example.com:4000": false,
		"4000":             false,
		"":                 false,
	}
	for addr, want := range cases {
		if got := Loopback(addr); got != want {
			t.Errorf("Loopback(%q) = %v, want %v", addr, got, want)
		}
	}
}

func TestDevMode_NeedsLoopbackAndNoDomain(t *testing.T) {
	if !DevMode("127.0.0.1:4000", "") {
		t.Fatal("loopback without a domain is dev mode")
	}
	if DevMode("127.0.0.1:4000", "flightdeck.example.com") {
		t.Fatal("a domain turns dev mode off even on loopback")
	}
	if DevMode(":4000", "") {
		t.Fatal("every interface is not dev mode")
	}
}

func TestEnsureToken_DevModeNeedsNoDatabase(t *testing.T) {
	res, err := EnsureToken(context.Background(), nil, nil, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if res.Token != DevToken || !res.Dev || res.Minted {
		t.Fatalf("%+v", res)
	}
}
