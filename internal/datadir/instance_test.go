package datadir

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// privateDir is a data dir only its owner can write, as Ensure makes one.
func privateDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestInstance_WriteReadRemove(t *testing.T) {
	dir := privateDir(t)
	if _, err := ReadInstance(dir); !errors.Is(err, ErrNoInstance) {
		t.Fatalf("ReadInstance with no file: %v, want ErrNoInstance", err)
	}
	want := Instance{Listen: "127.0.0.1:4100", PID: 12345}
	if err := WriteInstance(dir, want); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, InstanceFile)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// The documented format, and nothing secret beside it.
	if got := strings.TrimSpace(string(data)); got != `{"listen":"127.0.0.1:4100","pid":12345}` {
		t.Fatalf("the file holds %s", got)
	}
	if runtime.GOOS != "windows" {
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("mode %v (%v), want 0600 as the data dir's other files", info.Mode().Perm(), err)
		}
	}
	if _, err := os.Stat(path + ".tmp"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the temporary file is left behind: %v", err)
	}
	got, err := ReadInstance(dir)
	if err != nil || got != want {
		t.Fatalf("ReadInstance = %+v, %v; want %+v", got, err, want)
	}

	// A second write replaces it, as a restart on another port does.
	want = Instance{Listen: "[::1]:4200", PID: 777}
	if err := WriteInstance(dir, want); err != nil {
		t.Fatal(err)
	}
	if got, err := ReadInstance(dir); err != nil || got != want {
		t.Fatalf("ReadInstance after a rewrite = %+v, %v; want %+v", got, err, want)
	}

	if err := RemoveInstance(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadInstance(dir); !errors.Is(err, ErrNoInstance) {
		t.Fatalf("ReadInstance after the remove: %v, want ErrNoInstance", err)
	}
	// Removing what is not there is no error: a start removes whatever a
	// killed instance may have left.
	if err := RemoveInstance(dir); err != nil {
		t.Fatalf("RemoveInstance with no file: %v", err)
	}
}

func TestInstance_AWriteReplacesALeftoverTemporaryFile(t *testing.T) {
	dir := privateDir(t)
	tmp := filepath.Join(dir, InstanceFile+".tmp")
	if err := os.WriteFile(tmp, []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteInstance(dir, Instance{Listen: "127.0.0.1:4100", PID: 1}); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if info, err := os.Stat(filepath.Join(dir, InstanceFile)); err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("mode %v (%v), want 0600 whatever the leftover's mode", info.Mode().Perm(), err)
		}
	}
	if _, err := ReadInstance(dir); err != nil {
		t.Fatal(err)
	}
}

func TestReadInstance_RefusesWhatItCannotTrust(t *testing.T) {
	write := func(t *testing.T, dir, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, InstanceFile), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for name, content := range map[string]string{
		"not JSON":      "listen=127.0.0.1:4100",
		"no address":    `{"pid":12}`,
		"no process":    `{"listen":"127.0.0.1:4100"}`,
		"a negative id": `{"listen":"127.0.0.1:4100","pid":-1}`,
		"too large":     `{"listen":"127.0.0.1:4100","pid":1,"x":"` + strings.Repeat("a", maxInstanceBytes) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := privateDir(t)
			write(t, dir, content)
			if _, err := ReadInstance(dir); err == nil || errors.Is(err, ErrNoInstance) {
				t.Fatalf("ReadInstance = %v; want it refused", err)
			}
		})
	}
	t.Run("a member it does not know is ignored", func(t *testing.T) {
		dir := privateDir(t)
		write(t, dir, `{"listen":"127.0.0.1:4100","pid":5,"version":"v9"}`)
		if got, err := ReadInstance(dir); err != nil || got.PID != 5 {
			t.Fatalf("ReadInstance = %+v, %v", got, err)
		}
	})
	t.Run("a symbolic link", func(t *testing.T) {
		dir := privateDir(t)
		target := filepath.Join(t.TempDir(), "elsewhere.json")
		if err := os.WriteFile(target, []byte(`{"listen":"127.0.0.1:4100","pid":5}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, filepath.Join(dir, InstanceFile)); err != nil {
			t.Skipf("no symbolic link here: %v", err)
		}
		if _, err := ReadInstance(dir); err == nil || !strings.Contains(err.Error(), "not a regular file") {
			t.Fatalf("ReadInstance through a link = %v; want it refused", err)
		}
	})
	if runtime.GOOS == "windows" {
		return
	}
	t.Run("a file other users can write", func(t *testing.T) {
		dir := privateDir(t)
		write(t, dir, `{"listen":"127.0.0.1:4100","pid":5}`)
		if err := os.Chmod(filepath.Join(dir, InstanceFile), 0o620); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadInstance(dir); err == nil || !strings.Contains(err.Error(), "can be written by other users") {
			t.Fatalf("ReadInstance = %v; want it refused", err)
		}
	})
	t.Run("a data dir other users can write", func(t *testing.T) {
		dir := privateDir(t)
		write(t, dir, `{"listen":"127.0.0.1:4100","pid":5}`)
		if err := os.Chmod(dir, 0o777); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadInstance(dir); err == nil || !strings.Contains(err.Error(), "data dir") {
			t.Fatalf("ReadInstance = %v; want it refused", err)
		}
	})
	t.Run("a data dir others can read is fine", func(t *testing.T) {
		dir := privateDir(t)
		write(t, dir, `{"listen":"127.0.0.1:4100","pid":5}`)
		if err := os.Chmod(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadInstance(dir); err != nil {
			t.Fatalf("ReadInstance = %v", err)
		}
	})
}
