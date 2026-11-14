package handlers

import "testing"

// An OTLP session_start's derived id reaches the attacher, so an
// exporter that retries a batch attaches the start once.
func TestEventIDOf(t *testing.T) {
	for _, tc := range []struct {
		payload, want string
	}{
		{`{"id":"33333333-3333-4333-8333-333333333333","event_type":"session_start"}`, "33333333-3333-4333-8333-333333333333"},
		{`{"event_type":"session_start"}`, ""},
		{`{"id":7}`, ""},
		{`not json`, ""},
	} {
		if got := eventIDOf([]byte(tc.payload)); got != tc.want {
			t.Errorf("eventIDOf(%s) = %q, want %q", tc.payload, got, tc.want)
		}
	}
}
