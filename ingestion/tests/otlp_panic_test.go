package handlers_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/server"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	colmetrics "go.opentelemetry.io/proto/slim/otlp/collector/metrics/v1"
	coltrace "go.opentelemetry.io/proto/slim/otlp/collector/trace/v1"
)

// panickingDialect panics on its first `panics` calls, then maps
// nothing.
type panickingDialect struct {
	panics int64
	calls  atomic.Int64
}

func (d *panickingDialect) maybePanic() handlers.OTLPMapping {
	if d.calls.Add(1) <= d.panics {
		panic("dialect failure")
	}
	return handlers.OTLPMapping{}
}

func (d *panickingDialect) MapLogs(context.Context, *collogs.ExportLogsServiceRequest) handlers.OTLPMapping {
	return d.maybePanic()
}

func (d *panickingDialect) MapTraces(context.Context, *coltrace.ExportTraceServiceRequest) handlers.OTLPMapping {
	return d.maybePanic()
}

func (d *panickingDialect) MapMetrics(context.Context, *colmetrics.ExportMetricsServiceRequest) handlers.OTLPMapping {
	return d.maybePanic()
}

// A dialect that panics while holding a decode slot is answered 500 by
// the server's recovery and gives its slot back: after more panics
// than there are slots, a request still gets one and is answered 200,
// not 503.
func TestOTLPPanicInDialectReleasesDecodeSlot(t *testing.T) {
	const panics = 4 // more than the receiver's 3 decode slots
	dialect := &panickingDialect{panics: panics}
	srv := server.New(":0", &mockValidator{valid: true}, &mockPublisher{}, &mockDirStore{}, nil,
		dialect, handlers.DefaultRateLimitPerMinute)
	ts := httptest.NewServer(srv.Handler)
	defer ts.Close()

	post := func() int {
		req, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/logs", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer tok")
		req.Header.Set("Content-Type", "application/json")
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}

	for i := range panics {
		if code := post(); code != http.StatusInternalServerError {
			t.Fatalf("panicking request %d: status %d, want 500", i+1, code)
		}
	}
	if code := post(); code != http.StatusOK {
		t.Fatalf("after %d panics: status %d, want 200 (a decode slot leaked)", panics, code)
	}
}
