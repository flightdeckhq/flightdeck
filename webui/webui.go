// Package webui embeds the dashboard's production bundle. `make
// build-webui` builds dashboard/ and copies dashboard/dist (without the
// source maps) into webui/dist, which is gitignored but for a .gitkeep,
// so the module compiles before the dashboard is built; the router then
// answers that the bundle is missing instead of serving an empty page.
package webui

import (
	"embed"
	"io/fs"
)

// The all: prefix includes the dotfiles, so the committed .gitkeep keeps
// the pattern matching on a checkout without a bundle.
//
//go:embed all:dist
var dist embed.FS

// FS is the bundle with index.html at its root.
func FS() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // "dist" is a constant path of this package
	}
	return sub
}

// Built reports whether the bundle is present (index.html exists).
func Built() bool {
	_, err := fs.Stat(FS(), "index.html")
	return err == nil
}
