package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/auth"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/genai"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
)

// otlpStageRetryAfterSeconds is the Retry-After of a request whose GenAI
// records could not be staged (the database is down or slow): the
// staging write is idempotent, so a prompt retry is safe, and a second
// lets a brief outage or lock wait clear.
const otlpStageRetryAfterSeconds = 1

// GenAIStager writes a request's GenAI records to the staging store
// (otlpstage.Store).
type GenAIStager interface {
	Stage(ctx context.Context, batches []otlpstage.TraceBatch) (otlpstage.StageResult, error)
}

// genaiRequest collects one request's GenAI records, by trace, for the
// staging write. ARCHITECTURE.md (OTLP ingest > GenAI dialect >
// Staging) is the contract.
type genaiRequest struct {
	token   auth.ValidationResult
	record  string // "span" or "log record", for partial_success
	batches map[[16]byte]*otlpstage.TraceBatch
	order   [][16]byte
	records int
	units   int
}

func newGenAIRequest(token auth.ValidationResult, record string) *genaiRequest {
	return &genaiRequest{token: token, record: record, batches: map[[16]byte]*otlpstage.TraceBatch{}}
}

// genaiResource is what a GenAI resource says about its records: its
// framework (from the first recognised scope), its attributes and
// whether it declares capture.
type genaiResource struct {
	source  genai.Source
	scope   *commonpb.InstrumentationScope
	attrs   []*commonpb.KeyValue
	capture bool
}

func newGenAIResource(src genai.Source, scope *commonpb.InstrumentationScope, attrs []*commonpb.KeyValue) genaiResource {
	capture, _, _ := newOTLPAttrs(attrs).boolean(otlpAttrCapturePrompts)
	return genaiResource{source: src, scope: scope, attrs: attrs, capture: capture}
}

// add stages one record's fact, and its content, in its trace's batch.
// The batch's framework and identity resource are those of the trace's
// first record in the request; the staging store keeps the ones of the
// record that created the trace's row. Content rides only on a record
// whose resource declares capture, cut to fit the event size limit so a
// staged record is never larger than the event it becomes; the store
// stages it only while the trace's posture is still on.
func (g *genaiRequest) add(trace [16]byte, res genaiResource, f otlpstage.Fact, content json.RawMessage) {
	b := g.batches[trace]
	if b == nil {
		b = &otlpstage.TraceBatch{
			Key:           otlpstage.TraceKey{TokenKey: g.token.ID, TraceID: trace},
			TokenName:     g.token.Name,
			Source:        res.source.Label,
			SourceVersion: res.source.Version(res.scope.GetVersion(), res.attrs),
			Resource:      genai.IdentityResource(res.attrs),
		}
		g.batches[trace] = b
		g.order = append(g.order, trace)
	}
	if !res.capture {
		content = nil
	}
	b.Records = append(b.Records, otlpstage.Record{Fact: f, Capture: res.capture, Content: fitStagedContent(content)})
	g.records++
	g.units++
	if genai.IsAgentSpan(f) {
		g.units++ // its session_start and its session_end
	}
}

// placeable reports whether a record can be placed in a trace: the
// staging store refuses an all-zero trace or span id, which OTLP
// defines as invalid, and one such record must not fail the request.
func placeable(trace [16]byte, f otlpstage.Fact) bool {
	return trace != [16]byte{} && f.SpanID != [8]byte{}
}

// mapping is the request's staging step, or nil when it has no GenAI
// records.
func (g *genaiRequest) mapping(store GenAIStager) (func(context.Context) (int64, string, error), int) {
	if g.records == 0 {
		return nil, 0
	}
	batches := make([]otlpstage.TraceBatch, 0, len(g.order))
	for _, trace := range g.order {
		batches = append(batches, *g.batches[trace])
	}
	record := g.record
	return func(ctx context.Context) (int64, string, error) {
		res, err := store.Stage(ctx, batches)
		if err != nil {
			return 0, "", fmt.Errorf("stage genai records: %w", err)
		}
		if res.OverCap == 0 {
			return 0, "", nil
		}
		rejected := newRejectionSet()
		rejected.add(fmt.Sprintf("trace exceeds %d spans", otlpstage.MaxSpansPerTrace), int64(res.OverCap))
		return rejected.total, rejected.message(record), nil
	}, g.units
}

// fitStagedContent is a record's content cut to fit the event size
// limit: every string of it cut to the same largest length that fits,
// with the marker the receiver's events carry, as an event's content is
// cut when it is published. Content that no cut fits is dropped.
func fitStagedContent(content json.RawMessage) json.RawMessage {
	if len(content) <= maxOTLPEventBodyBytes {
		return content
	}
	dec := json.NewDecoder(bytes.NewReader(content))
	dec.UseNumber() // numbers keep their literals
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil
	}
	lo, hi := 0, min(longestContentString(v), maxOTLPEventBodyBytes)
	var best json.RawMessage
	for lo <= hi {
		mid := (lo + hi) / 2
		cut, err := json.Marshal(capContentStrings(v, mid))
		if err != nil {
			return nil
		}
		if len(cut) <= maxOTLPEventBodyBytes {
			best, lo = cut, mid+1
		} else {
			hi = mid - 1
		}
	}
	return best
}
