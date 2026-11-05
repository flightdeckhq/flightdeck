package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/genai"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	colmetrics "go.opentelemetry.io/proto/slim/otlp/collector/metrics/v1"
	coltrace "go.opentelemetry.io/proto/slim/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/slim/otlp/logs/v1"
	resourcepb "go.opentelemetry.io/proto/slim/otlp/resource/v1"
)

// otlpMetricsReason is why every metric data point is counted as
// rejected: the GenAI frameworks' metrics total the usage their spans
// already report, and Claude Code's its log records', so mapping them
// would count it twice. Claude Code's metrics keep that dialect's own
// reason.
const otlpMetricsReason = "metrics repeat span usage"

// OTLPRouter maps each resource of an export request by the dialect its
// instrumentation scope names: Claude Code (service.name claude-code, or
// a scope under com.anthropic.claude_code) through the Claude Code
// dialect, unchanged and matched first, since its own claude_code.tool
// spans carry a GenAI operation name; a resource carrying one of the
// recorded GenAI scopes through the GenAI dialect, which stages its
// spans (and Google ADK's details log records) for the assembler; and
// any other resource counted as rejected, its scope named.
// ARCHITECTURE.md (OTLP ingest > Dialects) is the contract.
type OTLPRouter struct {
	claudeCode OTLPDialect
	stager     GenAIStager
}

// NewOTLPRouter returns the router over the Claude Code dialect and the
// GenAI staging store.
func NewOTLPRouter(claudeCode OTLPDialect, stager GenAIStager) *OTLPRouter {
	return &OTLPRouter{claudeCode: claudeCode, stager: stager}
}

// isClaudeCodeResource reports a Claude Code resource: by service.name,
// or by a scope under Claude Code's prefix.
func isClaudeCodeResource(res *resourcepb.Resource, scopes []*commonpb.InstrumentationScope) bool {
	if serviceName(res.GetAttributes()) == claudeCodeServiceName {
		return true
	}
	for _, sc := range scopes {
		if strings.HasPrefix(sc.GetName(), claudeCodeScopePrefix) {
			return true
		}
	}
	return false
}

func scopeNotMapped(scope string) string {
	return fmt.Sprintf("scope %q is not mapped", truncateUTF8(scope, maxEchoedOTLPSourceBytes))
}

// MapLogs maps Claude Code's log records through its dialect and stages
// Google ADK's gen_ai.client.inference.operation.details records; ADK's
// other records, the other scopes of a GenAI resource and every other
// resource are counted as rejected.
func (r *OTLPRouter) MapLogs(ctx context.Context, req *collogs.ExportLogsServiceRequest) OTLPMapping {
	token, hasToken := otlpToken(ctx)
	rejected := newRejectionSet()
	cc := &collogs.ExportLogsServiceRequest{}
	g := newGenAIRequest(token, "log record")
	for _, rl := range req.GetResourceLogs() {
		scopes := make([]*commonpb.InstrumentationScope, 0, len(rl.GetScopeLogs()))
		for _, sl := range rl.GetScopeLogs() {
			scopes = append(scopes, sl.GetScope())
		}
		if isClaudeCodeResource(rl.GetResource(), scopes) {
			cc.ResourceLogs = append(cc.ResourceLogs, rl)
			continue
		}
		src, scope, recognised := genai.Recognize(scopes)
		if !recognised || !hasToken {
			for _, sl := range rl.GetScopeLogs() {
				rejected.add(scopeNotMapped(sl.GetScope().GetName()), int64(len(sl.GetLogRecords())))
			}
			continue
		}
		res := newGenAIResource(src, scope, rl.GetResource().GetAttributes())
		for _, sl := range rl.GetScopeLogs() {
			s, ok := genai.SourceForScope(sl.GetScope().GetName())
			if !ok || s.Label != genai.LabelGoogleADK {
				rejected.add(scopeNotMapped(sl.GetScope().GetName()), int64(len(sl.GetLogRecords())))
				continue
			}
			for _, lr := range sl.GetLogRecords() {
				r.stageLog(g, rejected, res, sl.GetScope(), lr)
			}
		}
	}
	return r.merge(ctx, g, rejected, "log record", len(cc.GetResourceLogs()) > 0,
		func(ctx context.Context) OTLPMapping { return r.claudeCode.MapLogs(ctx, cc) })
}

func (r *OTLPRouter) stageLog(g *genaiRequest, rejected *rejectionSet, res genaiResource, scope *commonpb.InstrumentationScope, lr *logspb.LogRecord) {
	if !genai.IsADKDetails(lr) {
		name := lr.GetEventName()
		if name == "" {
			name = newOTLPAttrs(lr.GetAttributes()).text("event.name")
		}
		rejected.add(fmt.Sprintf("Google ADK log record %q is not mapped",
			truncateUTF8(name, maxEchoedOTLPSourceBytes)), 1)
		return
	}
	trace, f, err := genai.LogFact(scope, lr)
	if err != nil || !placeable(trace, f) {
		rejected.add(genai.ErrRecordIDs.Error(), 1)
		return
	}
	var content json.RawMessage
	if res.capture {
		content = genai.LogContent(lr)
	}
	g.add(trace, res, f, content)
}

// MapTraces stages every span of a resource carrying a recognised GenAI
// scope, the spans of its other scopes included (a framework's spans
// nest those of the provider SDK it calls); Claude Code's spans go to
// its dialect, which counts them as rejected; every other resource's
// spans are counted as rejected.
func (r *OTLPRouter) MapTraces(ctx context.Context, req *coltrace.ExportTraceServiceRequest) OTLPMapping {
	token, hasToken := otlpToken(ctx)
	rejected := newRejectionSet()
	cc := &coltrace.ExportTraceServiceRequest{}
	g := newGenAIRequest(token, "span")
	for _, rs := range req.GetResourceSpans() {
		scopes := make([]*commonpb.InstrumentationScope, 0, len(rs.GetScopeSpans()))
		for _, ss := range rs.GetScopeSpans() {
			scopes = append(scopes, ss.GetScope())
		}
		if isClaudeCodeResource(rs.GetResource(), scopes) {
			cc.ResourceSpans = append(cc.ResourceSpans, rs)
			continue
		}
		src, scope, recognised := genai.Recognize(scopes)
		if !recognised || !hasToken {
			for _, ss := range rs.GetScopeSpans() {
				rejected.add(scopeNotMapped(ss.GetScope().GetName()), int64(len(ss.GetSpans())))
			}
			continue
		}
		res := newGenAIResource(src, scope, rs.GetResource().GetAttributes())
		for _, ss := range rs.GetScopeSpans() {
			for _, sp := range ss.GetSpans() {
				trace, f, err := genai.SpanFact(ss.GetScope(), sp)
				if err != nil || !placeable(trace, f) {
					rejected.add(genai.ErrRecordIDs.Error(), 1)
					continue
				}
				// Content is read only from a resource that declares
				// capture; without it nothing of the span's content
				// leaves the request.
				var content json.RawMessage
				if res.capture {
					content = genai.SpanContent(f, sp)
				}
				g.add(trace, res, f, content)
			}
		}
	}
	return r.merge(ctx, g, rejected, "span", len(cc.GetResourceSpans()) > 0,
		func(ctx context.Context) OTLPMapping { return r.claudeCode.MapTraces(ctx, cc) })
}

// MapMetrics counts every data point as rejected: Claude Code's through
// its dialect, unchanged; every other source's because metrics repeat
// the usage spans report.
func (r *OTLPRouter) MapMetrics(ctx context.Context, req *colmetrics.ExportMetricsServiceRequest) OTLPMapping {
	rejected := newRejectionSet()
	cc := &colmetrics.ExportMetricsServiceRequest{}
	for _, rm := range req.GetResourceMetrics() {
		scopes := make([]*commonpb.InstrumentationScope, 0, len(rm.GetScopeMetrics()))
		for _, sm := range rm.GetScopeMetrics() {
			scopes = append(scopes, sm.GetScope())
		}
		if isClaudeCodeResource(rm.GetResource(), scopes) {
			cc.ResourceMetrics = append(cc.ResourceMetrics, rm)
			continue
		}
		var n int64
		for _, sm := range rm.GetScopeMetrics() {
			for _, m := range sm.GetMetrics() {
				n += countDataPoints(m)
			}
		}
		rejected.add(otlpMetricsReason, n)
	}
	m := OTLPMapping{}
	if len(cc.GetResourceMetrics()) > 0 {
		m = r.claudeCode.MapMetrics(ctx, cc)
	}
	m.Rejected += rejected.total
	m.Message = joinOTLPMessages(m.Message, rejected.message("data point"))
	return m
}

// merge combines the Claude Code part of a request with its GenAI part.
// The budget is checked for the GenAI records before the Claude Code
// dialect does any costly work, and that dialect's own check is handed
// the GenAI units as well, so the request is refused (413 or 429) as a
// whole, having read and staged nothing. A Claude Code refusal or
// failure ends the request with nothing staged.
func (r *OTLPRouter) merge(
	ctx context.Context,
	g *genaiRequest,
	rejected *rejectionSet,
	record string,
	hasClaudeCode bool,
	mapClaudeCode func(context.Context) OTLPMapping,
) OTLPMapping {
	if refusal := otlpBudgetCheck(ctx, g.units); refusal != nil {
		return OTLPMapping{Refused: refusal}
	}
	m := OTLPMapping{}
	if hasClaudeCode {
		extra := g.units
		ccCtx := withOTLPBudget(ctx, func(events int) *OTLPRefusal { return otlpBudgetCheck(ctx, events+extra) })
		m = mapClaudeCode(ccCtx)
		if m.Refused != nil || m.Err != nil {
			return m
		}
	}
	m.Rejected += rejected.total
	m.Message = joinOTLPMessages(m.Message, rejected.message(record))
	m.Stage, m.StagedUnits = g.mapping(r.stager)
	return m
}
