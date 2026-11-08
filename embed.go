// Package flightdeck is the root of the repository's Go module: the one
// `flightdeck` binary (cmd/flightdeck) and the files it embeds. The
// package itself only exposes the schema migrations, which live under
// docker/postgres/migrations because the compose stack mounts them from
// there; the binary applies them at start without a file on disk.
package flightdeck

import (
	"embed"
	"io/fs"
)

//go:embed docker/postgres/migrations/*.sql
var migrations embed.FS

// Migrations is the filesystem of numbered up/down migration pairs, with
// the files at its root, as workers/app expects them.
func Migrations() fs.FS {
	sub, err := fs.Sub(migrations, "docker/postgres/migrations")
	if err != nil {
		// The directory is a compile-time constant of this package;
		// fs.Sub fails only for an invalid path.
		panic(err)
	}
	return sub
}
