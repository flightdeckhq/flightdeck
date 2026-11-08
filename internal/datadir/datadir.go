// Package datadir manages the flightdeck binary's data directory: its
// default location, its creation, and the secrets file it holds.
package datadir

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
)

// Default is the data directory when --data-dir is not given:
// ~/.flightdeck, or %LOCALAPPDATA%\flightdeck on Windows, where
// per-user, per-machine application data goes. With no home directory
// (a container running as a user with none) it is ./flightdeck-data.
func Default() string {
	if runtime.GOOS == "windows" {
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			return filepath.Join(local, "flightdeck")
		}
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "flightdeck-data"
	}
	return filepath.Join(home, ".flightdeck")
}

// Layout names the paths under a data directory.
type Layout struct {
	Root    string
	NATS    string // the embedded JetStream store
	Secrets string // secrets.json
	ACME    string // the TLS certificate cache
}

// Ensure creates dir (and the NATS and ACME subdirectories) with mode
// 0700 and returns its layout. An existing directory is left as it is.
func Ensure(dir string) (Layout, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return Layout{}, fmt.Errorf("data dir %q: %w", dir, err)
	}
	l := Layout{
		Root:    abs,
		NATS:    filepath.Join(abs, "nats"),
		Secrets: filepath.Join(abs, "secrets.json"),
		ACME:    filepath.Join(abs, "acme"),
	}
	for _, p := range []string{l.Root, l.NATS, l.ACME} {
		if err := os.MkdirAll(p, 0o700); err != nil {
			return Layout{}, fmt.Errorf("create %s: %w", p, err)
		}
	}
	return l, nil
}

// Secrets is the content of secrets.json.
type Secrets struct {
	// JWTSecret is generated once per data dir; it is the value the
	// query API's FLIGHTDECK_JWT_SECRET carries.
	JWTSecret string `json:"jwt_secret"`
	// DashboardToken is the plaintext of the ftd_ token minted for the
	// dashboard when the binary does not serve on loopback, kept so
	// /runtime-config.json can hand it to the dashboard on every start.
	// Empty in loopback mode and before the first non-loopback start.
	DashboardToken string `json:"dashboard_token,omitempty"`
}

// secretBytes is the JWT secret's size: 32 bytes, 256 bits, the key
// size HMAC-SHA256 uses in full.
const secretBytes = 32

// LoadSecrets reads path, or creates it with a fresh JWT secret when it
// does not exist. A file with a mode wider than 0600 is refused: it
// holds a bearer token in plaintext.
func LoadSecrets(path string) (*Secrets, error) {
	data, err := os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		s := &Secrets{JWTSecret: randomHex(secretBytes)}
		if err := SaveSecrets(path, s); err != nil {
			return nil, err
		}
		return s, nil
	case err != nil:
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			return nil, fmt.Errorf("stat %s: %w", path, err)
		}
		if perm := info.Mode().Perm(); perm&0o077 != 0 {
			return nil, fmt.Errorf("%s has mode %04o; it holds secrets and must be 0600 (chmod 600 %s)", path, perm, path)
		}
	}
	var s Secrets
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if s.JWTSecret == "" {
		s.JWTSecret = randomHex(secretBytes)
		if err := SaveSecrets(path, &s); err != nil {
			return nil, err
		}
	}
	return &s, nil
}

// SaveSecrets writes s to path with mode 0600, through a temporary file
// in the same directory so a crash mid-write leaves the old file.
func SaveSecrets(path string, s *Secrets) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("encode secrets: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand fails only when the system has no randomness,
		// which no later step could work around either.
		panic(fmt.Sprintf("random secret: %v", err))
	}
	return hex.EncodeToString(b)
}
