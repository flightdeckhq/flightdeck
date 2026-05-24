package handlers

import "regexp"

// uuidRE matches the standard 36-char RFC-4122 hyphenated form the
// agents.agent_id and sessions.session_id columns are populated with.
// Handlers validate path / query UUID params against this before the
// store layer so a malformed client-side value returns a clean 400
// rather than a Postgres cast error wrapped in a 500. The store's
// “$1::uuid“ cast stays as a belt-and-braces defence.
//
// Shared across handlers so a fix or rule tightening lands in one
// place (drift between duplicated regexes was the failure mode the
// extraction guards against).
var uuidRE = regexp.MustCompile(
	`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`,
)
