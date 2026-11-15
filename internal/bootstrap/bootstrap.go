// Package bootstrap decides the binary's authentication mode from how it
// listens, and provides the dashboard's token in each mode.
package bootstrap

import (
	"context"
	"fmt"
	"net"
	"strings"

	apiapp "github.com/flightdeckhq/flightdeck/api/app"
	"github.com/flightdeckhq/flightdeck/internal/datadir"
	"github.com/flightdeckhq/flightdeck/storage"
)

// DevToken is the development token the migrations seed; the services
// accept it only in development mode.
const DevToken = "tok_dev"

// TokenName is the name of the access token the binary mints on its
// first non-loopback start, as the Settings page lists it.
const TokenName = "Bootstrap token"

// Loopback reports whether listen is an address only this machine can
// reach: a loopback IP (127.0.0.0/8, ::1, an IPv4-mapped 127 address),
// with or without an interface zone (::1%lo), or "localhost", with or
// without the trailing dot of a fully qualified name. An empty host
// (":4000") is not loopback, since that is the address net.Listen binds
// on every interface; the binary's command line never produces one
// (cli.Parse gives a port alone the loopback host). A host name other
// than localhost is resolved by the operating system at bind time and is
// not assumed to be loopback; the binary compares the bound socket with
// this answer and refuses to start when they differ.
func Loopback(listen string) bool {
	host, _, err := net.SplitHostPort(listen)
	if err != nil {
		return false
	}
	host = strings.Trim(host, "[]")
	if host == "" {
		return false
	}
	if strings.EqualFold(strings.TrimSuffix(host, "."), "localhost") {
		return true
	}
	// A zone names the interface the address is on, not the address.
	if i := strings.IndexByte(host, '%'); i >= 0 {
		host = host[:i]
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// DevMode reports whether the binary runs the services with the
// development semantics: bound to loopback and serving no domain.
func DevMode(listen, domain string) bool {
	return domain == "" && Loopback(listen)
}

// Result is the dashboard token for this start.
type Result struct {
	// Token is what /runtime-config.json serves.
	Token string
	// Minted is true when an ftd_ token was created on this start; it is
	// the one time the plaintext is printed by the binary itself.
	Minted bool
	// Dev is true when Token is the development token.
	Dev bool
	// Source is the variable an operator supplied Token through
	// (TokenFileEnv or TokenEnv); "" for a development or minted token.
	// A supplied token is never printed.
	Source string
}

// EnsureToken returns the development token in dev mode. Otherwise it
// returns the token the operator supplied, stored as an access token
// named after its prefix unless it is stored already (idempotent across
// restarts and across instances starting together on one database). A
// token supplied earlier stays valid until it is revoked, on purpose:
// during a rolling update the old instances still serve it. A row
// revoked while its token is still supplied is stored again by the next
// start, so a rotation supplies the new token, restarts every instance,
// and then revokes the old row. With none supplied it
// returns the token kept in secrets when the database still knows it,
// and mints a new one through the query API's token store (storing it in
// secrets) when there is none or it no longer resolves, as after the
// database was recreated under an old data dir. A supplied token is not
// written to secrets: its source is the operator's file or variable.
func EnsureToken(ctx context.Context, db *storage.DB, secrets *datadir.Secrets, secretsPath string, dev bool, supplied *Supplied) (Result, error) {
	if dev {
		return Result{Token: DevToken, Dev: true}, nil
	}
	if supplied != nil {
		if _, err := apiapp.EnsureSuppliedToken(ctx, db, SuppliedTokenNameFor(supplied.Token), supplied.Token); err != nil {
			return Result{}, fmt.Errorf("store the dashboard token supplied by %s: %w", supplied.Source, err)
		}
		return Result{Token: supplied.Token, Source: supplied.Source}, nil
	}
	if secrets.DashboardToken != "" {
		ok, err := apiapp.TokenValid(ctx, db, secrets.DashboardToken)
		if err != nil {
			return Result{}, fmt.Errorf("check the stored dashboard token: %w", err)
		}
		if ok {
			return Result{Token: secrets.DashboardToken}, nil
		}
	}
	raw, err := apiapp.MintToken(ctx, db, TokenName)
	if err != nil {
		return Result{}, fmt.Errorf("mint the dashboard token: %w", err)
	}
	secrets.DashboardToken = raw
	if err := datadir.SaveSecrets(secretsPath, secrets); err != nil {
		return Result{}, err
	}
	return Result{Token: raw, Minted: true}, nil
}
