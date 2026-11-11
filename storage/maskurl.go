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
// parameters (the query split on "&" or ";"), and the lone user of a
// NATS URL, which is its token. A NATS server list
// (nats://a@h1:4222,nats://b@h2:4222) is masked server by server. The
// rest of the URL is kept as written. A sqlite:// URL holds no secret
// and is returned unchanged (its path is not a URL path and must not
// be re-encoded). A URL that does not parse is reduced to its scheme:
// what follows may hold a secret this function cannot find.
//
// Only URL forms are handled. A keyword/value DSN ("host=h password=x")
// is returned as it is; the flightdeck binary refuses a database value
// without one of its schemes before it displays it.
func MaskURL(raw string) string {
	if strings.HasPrefix(raw, sqliteScheme) {
		return raw
	}
	scheme, _, hasScheme := strings.Cut(raw, "://")
	if hasScheme && natsSchemes[strings.ToLower(scheme)] && strings.Contains(raw, ",") {
		// A NATS client takes several servers separated by commas,
		// each with its own userinfo; a later server may omit the
		// scheme. (A Postgres URL lists its hosts inside one
		// authority, under one userinfo, and is not split.)
		servers := strings.Split(raw, ",")
		for i, server := range servers {
			lead := server[:len(server)-len(strings.TrimLeft(server, " "))]
			server = strings.TrimSpace(server)
			if strings.Contains(server, "://") {
				servers[i] = lead + maskOneURL(server)
			} else {
				masked := maskOneURL(scheme + "://" + server)
				servers[i] = lead + strings.TrimPrefix(masked, scheme+"://")
			}
		}
		return strings.Join(servers, ",")
	}
	return maskOneURL(raw)
}

// maskOneURL is MaskURL for a single URL.
func maskOneURL(raw string) string {
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
// raw query, leaving the other parameters, their order, their
// separators and their encoding as written. Parameters are separated
// by "&" or by ";", which older clients and some servers accept.
func maskQuerySecrets(rawQuery string) (string, bool) {
	if rawQuery == "" {
		return rawQuery, false
	}
	var out strings.Builder
	changed := false
	for rawQuery != "" {
		pair := rawQuery
		separator := ""
		if i := strings.IndexAny(rawQuery, "&;"); i >= 0 {
			pair, separator = rawQuery[:i], rawQuery[i:i+1]
		}
		rawQuery = rawQuery[len(pair)+len(separator):]
		key, _, hasValue := strings.Cut(pair, "=")
		name, err := url.QueryUnescape(key)
		if err != nil {
			name = key
		}
		if hasValue && urlSecretQueryKeys[strings.ToLower(strings.TrimSpace(name))] {
			pair = key + "=" + urlSecretMask
			changed = true
		}
		out.WriteString(pair)
		out.WriteString(separator)
	}
	return out.String(), changed
}
