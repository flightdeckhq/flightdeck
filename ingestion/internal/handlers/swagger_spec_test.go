package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/ingestion/docs"
)

// specOperation is the part of an OpenAPI operation these tests read.
type specOperation struct {
	Parameters []struct {
		Name        string `json:"name"`
		In          string `json:"in"`
		Description string `json:"description"`
	} `json:"parameters"`
	RequestBody *struct {
		Content map[string]json.RawMessage `json:"content"`
	} `json:"requestBody"`
}

// loadSpecOperations returns the generated spec's operations keyed by
// "METHOD path".
func loadSpecOperations(t *testing.T) map[string]specOperation {
	t.Helper()
	var spec struct {
		Paths map[string]map[string]specOperation `json:"paths"`
	}
	if err := json.Unmarshal(docs.SwaggerJSON, &spec); err != nil {
		t.Fatalf("decode swagger.json: %v", err)
	}
	ops := make(map[string]specOperation)
	for path, methods := range spec.Paths {
		for method, op := range methods {
			ops[strings.ToUpper(method)+" "+path] = op
		}
	}
	return ops
}

// otlpAcceptsMediaType reports whether the OTLP receiver takes a body
// sent with this Content-Type.
func otlpAcceptsMediaType(mediaType string) bool {
	r := httptest.NewRequest(http.MethodPost, "/v1/logs", nil)
	r.Header.Set("Content-Type", mediaType)
	_, ok := otlpRequestEncoding(r)
	return ok
}

// The request content types the spec lists for each body-taking route
// are exactly the ones its handler accepts, so a client generated from
// the spec never sends a body the handler refuses, and a media type the
// receiver starts accepting without the docs listing it fails here. A
// new route with a request body must be added here.
func TestSwaggerRequestContentTypesMatchHandlers(t *testing.T) {
	otlp := make([]string, 0, len(otlpAcceptedMediaTypes))
	for _, m := range otlpAcceptedMediaTypes {
		otlp = append(otlp, m.name)
	}
	// The events and heartbeat handlers decode the body as JSON.
	jsonOnly := []string{"application/json"}
	want := map[string][]string{
		"POST /v1/logs":      otlp,
		"POST /v1/traces":    otlp,
		"POST /v1/metrics":   otlp,
		"POST /v1/events":    jsonOnly,
		"POST /v1/heartbeat": jsonOnly,
	}

	for _, mediaType := range otlp {
		if !otlpAcceptsMediaType(mediaType) {
			t.Fatalf("OTLP receiver refuses %q, which otlpAcceptedMediaTypes lists", mediaType)
		}
	}
	for _, mediaType := range []string{"text/plain", "application/xml", "application/octet-stream"} {
		if otlpAcceptsMediaType(mediaType) {
			t.Fatalf("OTLP receiver accepts %q, which otlpAcceptedMediaTypes does not list", mediaType)
		}
	}

	ops := loadSpecOperations(t)
	for key, op := range ops {
		if op.RequestBody == nil {
			continue
		}
		wantTypes, ok := want[key]
		if !ok {
			t.Errorf("%s has a request body but no expected content types; add it to this test", key)
			continue
		}
		got := make([]string, 0, len(op.RequestBody.Content))
		for mediaType := range op.RequestBody.Content {
			got = append(got, mediaType)
		}
		slices.Sort(got)
		sortedWant := slices.Sorted(slices.Values(wantTypes))
		if !slices.Equal(got, sortedWant) {
			t.Errorf("%s request content types = %v, want %v", key, got, sortedWant)
		}
	}
	for key := range want {
		if op, ok := ops[key]; !ok || op.RequestBody == nil {
			t.Errorf("%s is missing from the spec or has no request body", key)
		}
	}
}

// Each OTLP route documents every Content-Encoding the receiver
// accepts, so an encoding added to otlpAcceptedContentEncodings without
// the docs naming it fails here.
func TestSwaggerOTLPContentEncodingDocumented(t *testing.T) {
	accepted := make([]string, 0, len(otlpAcceptedContentEncodings))
	for _, e := range otlpAcceptedContentEncodings {
		accepted = append(accepted, e.name)
		r := httptest.NewRequest(http.MethodPost, "/v1/logs", nil)
		r.Header.Set("Content-Encoding", e.name)
		if gzipped, ok := otlpContentEncoding(r); !ok || gzipped != e.gzipped {
			t.Fatalf("Content-Encoding %q: gzipped=%v ok=%v, want gzipped=%v ok=true", e.name, gzipped, ok, e.gzipped)
		}
	}
	r := httptest.NewRequest(http.MethodPost, "/v1/logs", nil)
	r.Header.Set("Content-Encoding", "br")
	if _, ok := otlpContentEncoding(r); ok {
		t.Fatal("OTLP receiver accepts Content-Encoding br, which otlpAcceptedContentEncodings does not list")
	}

	ops := loadSpecOperations(t)
	for _, key := range []string{"POST /v1/logs", "POST /v1/traces", "POST /v1/metrics"} {
		op, ok := ops[key]
		if !ok {
			t.Fatalf("%s is missing from the spec", key)
		}
		var desc string
		found := false
		for _, p := range op.Parameters {
			if p.In == "header" && p.Name == "Content-Encoding" {
				desc, found = p.Description, true
			}
		}
		if !found {
			t.Fatalf("%s documents no Content-Encoding header", key)
		}
		for _, enc := range accepted {
			if !strings.Contains(desc, enc) {
				t.Errorf("%s Content-Encoding description %q does not name %q", key, desc, enc)
			}
		}
	}
}

// The 415 messages name exactly the accepted sets.
func TestOTLPRefusalMessagesNameAcceptedSets(t *testing.T) {
	if want := "content type must be application/x-protobuf or application/json"; otlpMediaTypeRefusal != want {
		t.Errorf("media type refusal = %q, want %q", otlpMediaTypeRefusal, want)
	}
	if want := "content encoding must be gzip, identity or none"; otlpContentEncodingRefusal != want {
		t.Errorf("content encoding refusal = %q, want %q", otlpContentEncodingRefusal, want)
	}
}
