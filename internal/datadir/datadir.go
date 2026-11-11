// Package datadir manages the flightdeck binary's data directory: its
// default location, its creation, the lock that keeps a second process
// out of it, and the secrets file it holds.
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

// DatabaseFile and LockFile are the names of the SQLite database and of
// the lock file inside a data directory.
const (
	DatabaseFile = "flightdeck.db"
	LockFile     = "flightdeck.lock"
)

// Layout names the paths under a data directory.
type Layout struct {
	Root     string
	Database string // flightdeck.db, the SQLite database when no --database-url is given
	Lock     string // flightdeck.lock, held by the running process (see Acquire)
	NATS     string // the embedded JetStream store
	Secrets  string // secrets.json
	ACME     string // the TLS certificate cache
	// Warning is set when the directory exists with a mode wider than
	// 0700 (not on Windows): the bus store and the secrets file inside
	// are then readable by other users of the machine. The caller logs
	// it; the directory is used as it is, since fixing modes behind the
	// operator's back is worse than telling them.
	Warning string
}

// Ensure creates dir (and the NATS and ACME subdirectories) with mode
// 0700 and returns its layout. An existing directory is left as it is,
// with Layout.Warning set when its mode admits other users.
func Ensure(dir string) (Layout, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return Layout{}, fmt.Errorf("data dir %q: %w", dir, err)
	}
	l := Layout{
		Root:     abs,
		Database: filepath.Join(abs, DatabaseFile),
		Lock:     filepath.Join(abs, LockFile),
		NATS:     filepath.Join(abs, "nats"),
		Secrets:  filepath.Join(abs, "secrets.json"),
		ACME:     filepath.Join(abs, "acme"),
	}
	for _, p := range []string{l.Root, l.NATS, l.ACME} {
		if err := os.MkdirAll(p, 0o700); err != nil {
			return Layout{}, fmt.Errorf("create %s: %w", p, err)
		}
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(l.Root)
		if err != nil {
			return Layout{}, fmt.Errorf("stat %s: %w", l.Root, err)
		}
		if perm := info.Mode().Perm(); perm&0o077 != 0 {
			l.Warning = fmt.Sprintf("data dir %s has mode %04o; it holds the database, the message-bus store and secrets.json and should be 0700 (chmod 700 %s)", l.Root, perm, l.Root)
		}
	}
	return l, nil
}

// CreatePrivate creates path as an empty file with mode 0600 when
// nothing is there, and leaves an existing file as it is. The binary
// calls it for its SQLite database before SQLite opens the file: SQLite
// would create it with the process's umask (0644 on most systems), and
// it gives the write-ahead log and shared-memory files beside the
// database the database's own mode, so creating the database private
// keeps all three private. An empty file is a new database to SQLite.
func CreatePrivate(path string) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	return nil
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
