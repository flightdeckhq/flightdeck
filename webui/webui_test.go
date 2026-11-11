package webui

import (
	"io/fs"
	"testing"
)

func TestFS_HasTheBundleRootOrTheKeep(t *testing.T) {
	fsys := FS()
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatal("the embedded dist is empty; .gitkeep must be present for the pattern to match")
	}
	_, statErr := fs.Stat(fsys, "index.html")
	if Built() != (statErr == nil) {
		t.Fatalf("Built() = %v but index.html stat err = %v", Built(), statErr)
	}
}
