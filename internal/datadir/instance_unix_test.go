//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package datadir

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestReadInstance_RefusesWhatOnlyUnixCanTell(t *testing.T) {
	record := []byte(`{"listen":"127.0.0.1:4100","pid":5}`)
	t.Run("a hard link to a file elsewhere", func(t *testing.T) {
		dir := privateDir(t)
		outside := filepath.Join(t.TempDir(), "elsewhere.json")
		if err := os.WriteFile(outside, record, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Link(outside, filepath.Join(dir, InstanceFile)); err != nil {
			t.Skipf("no hard link here: %v", err)
		}
		if _, err := ReadInstance(dir); err == nil || !strings.Contains(err.Error(), "2 links") {
			t.Fatalf("ReadInstance = %v; want the hard link refused", err)
		}
	})
	t.Run("a pipe, without waiting for a writer", func(t *testing.T) {
		dir := privateDir(t)
		if err := syscall.Mkfifo(filepath.Join(dir, InstanceFile), 0o600); err != nil {
			t.Skipf("no named pipe here: %v", err)
		}
		done := make(chan error, 1)
		go func() {
			_, err := ReadInstance(dir)
			done <- err
		}()
		select {
		case err := <-done:
			if err == nil || !strings.Contains(err.Error(), "not a regular file") {
				t.Fatalf("ReadInstance = %v; want the pipe refused", err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("ReadInstance waited on the pipe")
		}
	})
	owner := func(t *testing.T, uid int) {
		t.Helper()
		t.Cleanup(func() { currentUID = os.Getuid })
		currentUID = func() int { return uid }
	}
	t.Run("a file another user owns", func(t *testing.T) {
		dir := privateDir(t)
		if err := os.WriteFile(filepath.Join(dir, InstanceFile), record, 0o600); err != nil {
			t.Fatal(err)
		}
		// This user is someone else now: the file and the data dir are
		// another user's, as a data dir at 0755 of another user is.
		owner(t, os.Getuid()+1)
		if _, err := ReadInstance(dir); err == nil || !strings.Contains(err.Error(), "belongs to another user") {
			t.Fatalf("ReadInstance = %v; want it refused", err)
		}
	})
	t.Run("this user's file, read as this user", func(t *testing.T) {
		dir := privateDir(t)
		if err := os.WriteFile(filepath.Join(dir, InstanceFile), record, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadInstance(dir); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadInstance(filepath.Join(dir, "missing")); !errors.Is(err, ErrNoInstance) {
			t.Fatalf("a data dir that is not there: %v, want ErrNoInstance", err)
		}
	})
}
