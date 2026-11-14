package bootstrap

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// The variables an operator supplies the dashboard token through. They
// have no flag: a flag's value shows in the process list.
const (
	// TokenFileEnv names a file that holds the token: a mounted
	// Kubernetes or Docker secret.
	TokenFileEnv = "FLIGHTDECK_DASHBOARD_TOKEN_FILE"
	// TokenEnv holds the token itself.
	TokenEnv = "FLIGHTDECK_DASHBOARD_TOKEN"
)

// SuppliedTokenName is the start of the name of the access token the
// binary stores for a supplied dashboard token; SuppliedTokenNameFor
// adds the token's prefix.
const SuppliedTokenName = "Supplied dashboard token"

// SuppliedTokenNameFor is the name the Settings page lists a supplied
// token under: SuppliedTokenName and the token's first eight
// characters, "Supplied dashboard token (ftd_a07a)". A token supplied
// earlier stays valid until it is revoked (see EnsureToken), and the
// prefix tells the old row from the new one. The prefix is no more than
// the Settings page shows of any token.
func SuppliedTokenNameFor(token string) string {
	return fmt.Sprintf("%s (%s)", SuppliedTokenName, token[:min(len(token), tokenPrefixShown)])
}

const (
	// tokenPrefix and tokenHexDigits are the form of a minted token,
	// "ftd_" and 16 random bytes in hex, which a supplied one must have
	// too: the validator finds a token by its first eight characters,
	// and 128 random bits is what makes a bearer token unguessable.
	tokenPrefix    = "ftd_"
	tokenHexDigits = 32
	// tokenPrefixShown is how much of a token its name and the Settings
	// page show: "ftd_" and four digits, the prefix the token store keeps
	// in the clear and the validator looks a token up by.
	tokenPrefixShown = 8
	// minDistinctDigits is the fewest distinct hex digits a supplied
	// token may have. It catches the values typed by hand (all zeros,
	// "deadbeef" repeated); 16 random bytes have fewer than eight
	// distinct digits about four times in a hundred million.
	minDistinctDigits = 8
	// maxTokenFileBytes bounds how much of the token file is read. A
	// token and a newline are 37 bytes; the bound keeps a path that
	// names some other, large file from being read into memory.
	maxTokenFileBytes = 4 << 10
)

// Supplied is a dashboard token the operator supplied.
type Supplied struct {
	// Token is the token.
	Token string
	// Source is the variable it came from, TokenFileEnv or TokenEnv,
	// for the start-up block: the token itself is never printed.
	Source string
	// Shadowed is true when both variables were set and the file won.
	Shadowed bool
}

// LoadSupplied reads the supplied dashboard token from env (a variable
// name to its value, "" when unset): the file TokenFileEnv names, else
// the value of TokenEnv, else nil. The file wins when both are set: it
// is the form that stays out of the process environment. A value that
// does not have a minted token's form is an error that names the
// variable and the form, never the value.
func LoadSupplied(env func(string) string) (*Supplied, error) {
	path, direct := env(TokenFileEnv), env(TokenEnv)
	switch {
	case path != "":
		raw, err := readTokenFile(path)
		if err != nil {
			return nil, err
		}
		if err := checkSupplied(raw); err != nil {
			return nil, fmt.Errorf("%s (%s): %w", TokenFileEnv, path, err)
		}
		return &Supplied{Token: raw, Source: TokenFileEnv, Shadowed: direct != ""}, nil
	case direct != "":
		raw := strings.TrimSpace(direct)
		if err := checkSupplied(raw); err != nil {
			return nil, fmt.Errorf("%s: %w", TokenEnv, err)
		}
		return &Supplied{Token: raw, Source: TokenEnv}, nil
	}
	return nil, nil
}

// readTokenFile returns the content of the token file without its
// surrounding white space. The file's mode is not checked: Kubernetes
// mounts a secret 0644 and Docker 0444, in a container with no other
// user, so refusing a file others can read would refuse both.
func readTokenFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("%s: %w", TokenFileEnv, err)
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, maxTokenFileBytes+1))
	if err != nil {
		return "", fmt.Errorf("%s: read %s: %w", TokenFileEnv, path, err)
	}
	if len(data) > maxTokenFileBytes {
		return "", fmt.Errorf("%s: %s is larger than a token file (%d bytes at most)", TokenFileEnv, path, maxTokenFileBytes)
	}
	return strings.TrimSpace(string(data)), nil
}

// errTokenForm describes the form a supplied token must have. It never
// carries the value it refused.
var errTokenForm = errors.New(`the dashboard token must be "ftd_" followed by 32 random lower-case hex digits; ` +
	`generate one with: printf 'ftd_%s' "$(openssl rand -hex 16)"`)

// checkSupplied reports whether raw has the form of a minted token and
// is not an obviously hand-typed value.
func checkSupplied(raw string) error {
	if raw == "" {
		return fmt.Errorf("the value is empty: %w", errTokenForm)
	}
	digits, found := strings.CutPrefix(raw, tokenPrefix)
	if !found || len(digits) != tokenHexDigits {
		return errTokenForm
	}
	var seen [16]bool
	distinct := 0
	for _, c := range digits {
		var v int
		switch {
		case c >= '0' && c <= '9':
			v = int(c - '0')
		case c >= 'a' && c <= 'f':
			v = int(c-'a') + 10
		default:
			return errTokenForm
		}
		if !seen[v] {
			seen[v] = true
			distinct++
		}
	}
	if distinct < minDistinctDigits {
		return fmt.Errorf("the value is not random (fewer than %d distinct digits): %w", minDistinctDigits, errTokenForm)
	}
	// Two patterns a person types that have enough distinct digits: one
	// half written twice (64 bits at most), and a walk where every digit
	// is one above or one below the one before (0123456789abcdef twice,
	// fedcba9876543210...). Random digits are such a walk with a
	// chance of (2/16)^31, and repeat a half with a chance of 16^-16.
	if digits[:tokenHexDigits/2] == digits[tokenHexDigits/2:] {
		return fmt.Errorf("the value is not random (its second half repeats the first): %w", errTokenForm)
	}
	if isDigitWalk(digits) {
		return fmt.Errorf("the value is not random (each digit is one away from the one before): %w", errTokenForm)
	}
	return nil
}

// isDigitWalk reports whether every hex digit of digits is one above or
// one below the digit before it, modulo 16. digits holds lower-case hex
// digits only.
func isDigitWalk(digits string) bool {
	value := func(c byte) int {
		if c <= '9' {
			return int(c - '0')
		}
		return int(c-'a') + 10
	}
	for i := 1; i < len(digits); i++ {
		if step := (value(digits[i]) - value(digits[i-1]) + 16) % 16; step != 1 && step != 15 {
			return false
		}
	}
	return true
}
