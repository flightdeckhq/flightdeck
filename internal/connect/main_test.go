package connect

import (
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/flightdeckhq/flightdeck/internal/connect/fakeclaude"
)

// TestMain runs the tests, or, in a copy of this test binary named
// claude.exe, the Go stand-in for Claude Code's CLI (fakeclaude) that the
// Windows run of these tests drives.
func TestMain(m *testing.M) {
	if fakeclaude.Is() {
		os.Exit(fakeclaude.Main(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
	}
	code := m.Run()
	if goFake.dir != "" {
		_ = os.RemoveAll(goFake.dir)
	}
	os.Exit(code)
}

// goFake is the one copy of this test binary as claude.exe, made the
// first time a test needs it: a test binary is megabytes, and every test
// can share the executable while each keeps its own state directory.
var goFake struct {
	once sync.Once
	dir  string
	exe  string
	err  error
}

// goFakeClaude returns the path of the copy, creating it once.
func goFakeClaude(t *testing.T) string {
	t.Helper()
	goFake.once.Do(func() {
		self, err := os.Executable()
		if err != nil {
			goFake.err = err
			return
		}
		if goFake.dir, err = os.MkdirTemp("", "fake-claude-"); err != nil {
			goFake.err = err
			return
		}
		goFake.exe = filepath.Join(goFake.dir, fakeclaude.Name+".exe")
		goFake.err = copyFile(self, goFake.exe)
	})
	if goFake.err != nil {
		t.Fatalf("the Go stand-in claude: %v", goFake.err)
	}
	return goFake.exe
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(to, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
