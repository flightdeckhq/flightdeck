package storage

import (
	"net/url"
	"strings"
)

// urlSecretMask stands in for a secret in a URL that is shown to a
// person or written to a log.
const urlSecretMask = "***"

// urlSecretQueryKeys are the query parameters of a connection URL whose
// value is a secret: pgx reads the password and the passphrase of the
// client key from the query as well as from the userinfo. The keys that
// name a file (passfile, sslkey, sslcert, sslrootcert) hold a path and
// are shown.
var urlSecretQueryKeys = map[string]bool{
	"password":    true,
	"sslpassword": true,
}

// natsSchemes are the URL schemes of a NATS server. A NATS URL with a
// user and no password carries its auth token in the user slot.
var natsSchemes = map[string]bool{"nats": true, "tls": true, "ws": true, "wss": true}

// MaskURL returns a connection URL (Postgres, NATS) with every secret
// in it replaced by ***, for a start-up line, an error or a log: the
// password of the userinfo, the password and sslpassword query
// parameters, and the lone user of a NATS URL, which is its token. The
// rest of the URL is kept as written. A sqlite:// URL holds no secret
// and is returned unchanged (its path is not a URL path and must not
// be re-encoded). A URL that does not parse is reduced to its scheme:
// what follows may hold a secret this function cannot find.
func MaskURL(raw string) string {
	if strings.HasPrefix(raw, sqliteScheme) {
		return raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		if scheme, _, found := strings.Cut(raw, "://"); found {
			return scheme + "://…"
		}
		return "…"
	}
	masked := false
	if u.User != nil {
		if _, has := u.User.Password(); has {
			u.User = url.UserPassword(u.User.Username(), urlSecretMask)
			masked = true
		} else if natsSchemes[strings.ToLower(u.Scheme)] && u.User.Username() != "" {
			u.User = url.User(urlSecretMask)
			masked = true
		}
	}
	if query, changed := maskQuerySecrets(u.RawQuery); changed {
		u.RawQuery = query
		masked = true
	}
	if !masked {
		return raw
	}
	// url.String escapes the asterisks of the userinfo; show them as
	// written.
	return strings.ReplaceAll(u.String(), "%2A%2A%2A", urlSecretMask)
}

// maskQuerySecrets replaces the value of every secret parameter of a
// raw query, leaving the other parameters, their order and their
// encoding as written.
func maskQuerySecrets(rawQuery string) (string, bool) {
	if rawQuery == "" {
		return rawQuery, false
	}
	changed := false
	pairs := strings.Split(rawQuery, "&")
	for i, pair := range pairs {
		key, _, hasValue := strings.Cut(pair, "=")
		name, err := url.QueryUnescape(key)
		if err != nil {
			name = key
		}
		if hasValue && urlSecretQueryKeys[strings.ToLower(name)] {
			pairs[i] = key + "=" + urlSecretMask
			changed = true
		}
	}
	return strings.Join(pairs, "&"), changed
}
