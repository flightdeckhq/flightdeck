package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/identity"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	colmetrics "go.opentelemetry.io/proto/slim/otlp/collector/metrics/v1"
	coltrace "go.opentelemetry.io/proto/slim/otlp/collector/trace/v1"
	logspb "go.opentelemetry.io/proto/slim/otlp/logs/v1"
)

// The Claude Code dialect: how its telemetry is recognised and the
// fixed values of the sessions it reports. ARCHITECTURE.md (OTLP
// ingest) is the contract this file implements.
const (
	// claudeCodeServiceName and claudeCodeScopePrefix identify Claude
	// Code's records: its resource's service.name and the instrumentation
	// scopes it logs under (com.anthropic.claude_code.events).
	claudeCodeServiceName = "claude-code"
	claudeCodeScopePrefix = "com.anthropic.claude_code"
	// claudeCodeRecordPrefix prefixes the body of each of its log
	// records (claude_code.api_request); event.name carries the rest.
	claudeCodeRecordPrefix = "claude_code."

	claudeCodeClientType     = "claude_code"
	claudeCodeAgentType      = "coding"
	claudeCodeFlavor         = "claude-code"
	claudeCodeFramework      = "claude-code"
	claudeCodeDefaultBilling = "subscription"
	claudeCodeProvider       = "anthropic"
	otlpUnknownIdentity      = "unknown"

	// The resource attributes an operator sets with
	// OTEL_RESOURCE_ATTRIBUTES to tell Flightdeck what the exporter
	// itself cannot.
	otlpAttrFlavor         = "flightdeck.flavor"
	otlpAttrBillingMode    = "flightdeck.billing_mode"
	otlpAttrCapturePrompts = "flightdeck.capture_prompts"

	// claudeCodeToolErrorClass is the error_class of a failed tool a
	// Claude Code session reports over OTLP.
	claudeCodeToolErrorClass = "ClaudeCodeToolError"
	// otlpRedactedErrorMessage stands in for a failed tool's error text
	// when capture is off: the placeholder the plugin and the worker use.
	otlpRedactedErrorMessage = "<redacted>"
	// otlpNoToolErrorDetail is a failed tool's message, with capture on,
	// when the record carries no error text.
	otlpNoToolErrorDetail = "tool failed (Claude Code reported no error detail)"
)

// Bounds on content the dialect copies into an event, the plugin's own:
// a failed tool's error text stays inline on the event (1000 characters
// holds a multi-line shell error), an API error's text is cut to the
// 200 characters the sensor keeps of a provider's message, and a whole
// event body to 768 KiB, under the 1 MiB the message bus carries, with
// content strings cut to fit.
const (
	otlpToolErrorMaxChars  = 1000
	otlpAPIErrorMaxChars   = 200
	maxOTLPEventBodyBytes  = 768 << 10
	otlpTruncationTemplate = "… [flightdeck: kept %d of %d bytes to fit the event size limit]"
)

// ClaudeCodeDialect maps Claude Code's OTLP log records to Flightdeck
// events. Records of other sources, and Claude Code's spans and metrics,
// are counted as rejected.
type ClaudeCodeDialect struct {
	store ClaudeCodeSessionStore
	cache *otlpSessionCache
	now   func() time.Time
}

// NewClaudeCodeDialect returns the dialect, reading sessions from store.
func NewClaudeCodeDialect(store ClaudeCodeSessionStore) *ClaudeCodeDialect {
	return newClaudeCodeDialect(store, func() time.Time { return time.Now().UTC() })
}

func newClaudeCodeDialect(store ClaudeCodeSessionStore, now func() time.Time) *ClaudeCodeDialect {
	return &ClaudeCodeDialect{store: store, cache: newOTLPSessionCache(now), now: now}
}

// MapTraces counts every span as rejected: Claude Code's log records
// carry everything its events need.
func (d *ClaudeCodeDialect) MapTraces(ctx context.Context, req *coltrace.ExportTraceServiceRequest) OTLPMapping {
	return UnmappedDialect{}.MapTraces(ctx, req)
}

// MapMetrics counts every data point as rejected.
func (d *ClaudeCodeDialect) MapMetrics(ctx context.Context, req *colmetrics.ExportMetricsServiceRequest) OTLPMapping {
	return UnmappedDialect{}.MapMetrics(ctx, req)
}

// ccResource is what a Claude Code resource says about its records.
type ccResource struct {
	version  string // service.version
	host     string
	os, arch string
	flavor   string
	billing  string
	capture  bool
}

func newCCResource(attrs otlpAttrs) *ccResource {
	r := &ccResource{
		version: attrs.text("service.version"),
		host:    attrs.text("host.name"),
		os:      attrs.text("os.type"),
		arch:    attrs.text("host.arch"),
		flavor:  attrs.text(otlpAttrFlavor),
		billing: attrs.text(otlpAttrBillingMode),
	}
	if r.host == "" {
		r.host = otlpUnknownIdentity
	}
	if r.flavor == "" {
		r.flavor = claudeCodeFlavor
	}
	if r.billing == "" {
		r.billing = claudeCodeDefaultBilling
	}
	r.capture, _, _ = attrs.boolean(otlpAttrCapturePrompts)
	return r
}

// The Claude Code record types the dialect maps (event.name).
const (
	ccUserPrompt        = "user_prompt"
	ccAPIRequest        = "api_request"
	ccAPIError          = "api_error"
	ccToolResult        = "tool_result"
	ccToolDecision      = "tool_decision"
	ccSubagentCompleted = "subagent_completed"
)

// ccRecord is one Claude Code log record the dialect maps.
type ccRecord struct {
	res                 *ccResource
	attrs               otlpAttrs
	name                string // event.name: api_request
	ts                  time.Time
	claudeCodeSessionID string
	agentID             string // the sub-agent's agent_id; "" for the root
	role                string // the sub-agent's role, when this record names it
	user                string
	eventID             string
	sessionID           string // Flightdeck session id
	rootID              string // the run's root Flightdeck session id
}

// otlpSessionID is the Flightdeck id of a Claude Code session, or of
// one of its sub-agents: never the Claude Code id itself, which the
// Agent SDK interceptor reports its runs under.
func otlpSessionID(claudeCodeSessionID, agentID string) string {
	name := "flightdeck://otlp/claude-code/session/" + claudeCodeSessionID
	if agentID != "" {
		name += "/" + agentID
	}
	return identity.UUID5(identity.NamespaceFlightdeck, name)
}

// parseCCRecord reads one record of a Claude Code scope, or says why it
// is not used.
func parseCCRecord(res *ccResource, lr *logspb.LogRecord, now time.Time) (*ccRecord, string) {
	attrs := newOTLPAttrs(lr.GetAttributes())
	name := attrs.text("event.name")
	if name == "" {
		name = strings.TrimPrefix(lr.GetBody().GetStringValue(), claudeCodeRecordPrefix)
	}
	switch name {
	case ccUserPrompt, ccAPIRequest, ccAPIError, ccToolResult, ccSubagentCompleted:
	case ccToolDecision:
		if attrs.text("decision") != "reject" {
			return nil, fmt.Sprintf("%q other than a reject is not mapped", claudeCodeRecordPrefix+ccToolDecision)
		}
	case "":
		return nil, "a Claude Code record without event.name is not mapped"
	default:
		return nil, fmt.Sprintf("%q is not mapped", truncateUTF8(claudeCodeRecordPrefix+name, maxEchoedOTLPSourceBytes))
	}
	rec := &ccRecord{res: res, attrs: attrs, name: name}
	rec.claudeCodeSessionID = attrs.text("session.id")
	if rec.claudeCodeSessionID == "" {
		return nil, fmt.Sprintf("%q without session.id", claudeCodeRecordPrefix+name)
	}
	rec.agentID = attrs.text("agent_id")
	if name == ccSubagentCompleted && rec.agentID == "" {
		return nil, fmt.Sprintf("%q without agent_id", claudeCodeRecordPrefix+name)
	}
	rec.role = attrs.text("agent.name")
	if rec.role == "" {
		if t, ok := strings.CutPrefix(attrs.text("query_source"), "agent:builtin:"); ok {
			rec.role = t
		}
	}
	if rec.agentID == "" {
		rec.role = "" // a root session has no role
	}
	rec.user = attrs.text("user.email")
	if rec.user == "" {
		rec.user = attrs.text("user.account_id")
	}
	if rec.user == "" {
		rec.user = otlpUnknownIdentity
	}
	nanos := lr.GetTimeUnixNano()
	switch {
	case nanos != 0:
		rec.ts = time.Unix(0, int64(nanos)).UTC() //nolint:gosec // a time past 2262 is not a real record and fails validation
	case lr.GetObservedTimeUnixNano() != 0:
		rec.ts = time.Unix(0, int64(lr.GetObservedTimeUnixNano())).UTC() //nolint:gosec // as above
	default:
		rec.ts = now
	}
	seq := attrs.text("event.sequence")
	rec.eventID = identity.UUID5(identity.NamespaceFlightdeck,
		"flightdeck://otlp/claude-code/event/"+rec.claudeCodeSessionID+"/"+name+"/"+seq+"/"+strconv.FormatUint(nanos, 10))
	rec.rootID = otlpSessionID(rec.claudeCodeSessionID, "")
	rec.sessionID = rec.rootID
	if rec.agentID != "" {
		rec.sessionID = otlpSessionID(rec.claudeCodeSessionID, rec.agentID)
	}
	return rec, ""
}

// MapLogs maps Claude Code's log records to events. Each session's
// first record in a request is preceded by a synthetic session_start
// when its row is missing or closed; a session another client reports
// is not used. Every event passes POST /v1/events validation or is
// counted as rejected. A failed session read fails the whole request
// (Err), which the receiver answers with 503 so the exporter retries.
func (d *ClaudeCodeDialect) MapLogs(ctx context.Context, req *collogs.ExportLogsServiceRequest) OTLPMapping {
	now := d.now()
	rejected := newRejectionSet()
	var records []*ccRecord
	for _, rl := range req.GetResourceLogs() {
		attrs := newOTLPAttrs(rl.GetResource().GetAttributes())
		if name := serviceName(rl.GetResource().GetAttributes()); name != claudeCodeServiceName {
			var n int64
			for _, sl := range rl.GetScopeLogs() {
				n += int64(len(sl.GetLogRecords()))
			}
			rejected.add(fmt.Sprintf("source %q is not mapped", truncateUTF8(name, maxEchoedOTLPSourceBytes)), n)
			continue
		}
		res := newCCResource(attrs)
		for _, sl := range rl.GetScopeLogs() {
			scope := sl.GetScope().GetName()
			if !strings.HasPrefix(scope, claudeCodeScopePrefix) {
				rejected.add(fmt.Sprintf("scope %q is not mapped", truncateUTF8(scope, maxEchoedOTLPSourceBytes)),
					int64(len(sl.GetLogRecords())))
				continue
			}
			for _, lr := range sl.GetLogRecords() {
				rec, reason := parseCCRecord(res, lr, now)
				if reason != "" {
					rejected.add(reason, 1)
					continue
				}
				records = append(records, rec)
			}
		}
	}

	// A sub-agent's role, from any of its records in the request that
	// names it: its tool results and decisions do not.
	roles := map[string]string{}
	for _, rec := range records {
		if rec.role != "" && roles[rec.sessionID] == "" {
			roles[rec.sessionID] = rec.role
		}
	}

	sessions := map[string]*ccSession{}
	var events []OTLPEvent
	var ended []string
	for _, rec := range records {
		if rec.agentID != "" {
			// The run's root is resolved, and started when it must be,
			// before its sub-agent, so the child's parent row carries the
			// session's context and capture posture rather than being a
			// stub the worker made for it.
			rootRec := *rec
			rootRec.agentID, rootRec.sessionID, rootRec.role = "", rec.rootID, ""
			root, err := d.resolveSession(ctx, sessions, &rootRec)
			if err != nil {
				return d.lookupFailed(err)
			}
			if !root.deduped {
				events = d.appendStart(events, root, &rootRec)
			}
		}
		s, err := d.resolveSession(ctx, sessions, rec)
		if err != nil {
			return d.lookupFailed(err)
		}
		if s.deduped {
			rejected.add("its Claude Code session is reported by another Flightdeck client", 1)
			continue
		}
		if s.child {
			if role := roles[s.id]; role != "" {
				s.role = role
			}
		}
		events = d.appendStart(events, s, rec)
		payload, eventType := d.mapRecord(rec, s)
		body, msg := finishOTLPEvent(payload, now)
		if msg != "" {
			rejected.add(fmt.Sprintf("%q event is invalid: %s", claudeCodeRecordPrefix+rec.name, msg), 1)
			continue
		}
		events = append(events, OTLPEvent{EventType: eventType, SessionID: s.id, Payload: body})
		if eventType == "session_end" {
			ended = append(ended, s.id)
		}
	}

	mapping := OTLPMapping{Events: events, Rejected: rejected.total, Message: rejected.message("log record")}
	if len(sessions) > 0 {
		mapping.Published = func() {
			for _, s := range sessions {
				if !s.cached || s.role != "" {
					d.cache.put(s.id, s.deduped, s.role)
				}
			}
			for _, id := range ended {
				d.cache.drop(id)
			}
		}
	}
	return mapping
}

func (d *ClaudeCodeDialect) lookupFailed(err error) OTLPMapping {
	slog.Error("otlp session lookup failed", "err", err)
	return OTLPMapping{Err: fmt.Errorf("session lookup: %w", err)}
}

// appendStart appends the session's synthetic session_start when its
// row is missing or closed and the request has not started it yet. Its
// id derives from the session and the record it precedes, so a retried
// export publishes the same start.
func (d *ClaudeCodeDialect) appendStart(events []OTLPEvent, s *ccSession, rec *ccRecord) []OTLPEvent {
	if !s.needsStart || s.startEmitted {
		return events
	}
	s.startEmitted = true
	p := d.basePayload(rec, s, "session_start")
	p["id"] = identity.UUID5(identity.NamespaceFlightdeck,
		"flightdeck://otlp/claude-code/start/"+s.id+"/"+rec.eventID)
	p["sensor_version"] = rec.res.version
	p["capture_prompts"] = rec.res.capture
	ctx := map[string]any{
		"claude_code_session_id": rec.claudeCodeSessionID,
		"telemetry":              "otlp",
		"supports_directives":    false,
	}
	for key, value := range map[string]string{
		"claude_code_version": rec.res.version,
		"os":                  rec.res.os,
		"arch":                rec.res.arch,
		"terminal_type":       rec.attrs.text("terminal.type"),
	} {
		if value != "" {
			ctx[key] = value
		}
	}
	p["context"] = ctx
	body, msg := finishOTLPEvent(p, d.now())
	if msg != "" {
		// Its fields are the dialect's own or bounded identity strings;
		// an invalid one means a resource attribute out of bounds. The
		// session's events are still published and the worker creates
		// the row from them.
		slog.Warn("otlp synthetic session_start is invalid", "session_id", s.id, "reason", msg)
		return events
	}
	return append(events, OTLPEvent{EventType: "session_start", SessionID: s.id, Payload: body})
}

// basePayload is the identity every event of the session carries.
func (d *ClaudeCodeDialect) basePayload(rec *ccRecord, s *ccSession, eventType string) map[string]any {
	baseName := rec.user + "@" + rec.res.host
	agentName := baseName
	role := ""
	if s.child {
		role = s.role
		if role != "" {
			agentName = baseName + "/" + role
		}
	}
	p := map[string]any{
		"id":          rec.eventID,
		"session_id":  s.id,
		"event_type":  eventType,
		"flavor":      rec.res.flavor,
		"agent_type":  claudeCodeAgentType,
		"agent_id":    identity.AgentID(claudeCodeAgentType, rec.user, rec.res.host, claudeCodeClientType, baseName, role),
		"agent_name":  agentName,
		"client_type": claudeCodeClientType,
		"user":        rec.user,
		"hostname":    rec.res.host,
		"host":        rec.res.host,
		"framework":   claudeCodeFramework,
		"timestamp":   rec.ts.Format(time.RFC3339Nano),
		"has_content": false,
	}
	if s.child {
		p["parent_session_id"] = s.rootID
		if role != "" {
			p["agent_role"] = role
		}
	}
	return p
}

// mapRecord builds the event a record maps to.
func (d *ClaudeCodeDialect) mapRecord(rec *ccRecord, s *ccSession) (map[string]any, string) {
	switch rec.name {
	case ccUserPrompt:
		return d.preCall(rec, s), "pre_call"
	case ccAPIRequest:
		return d.postCall(rec, s), "post_call"
	case ccAPIError:
		return d.llmError(rec, s), "llm_error"
	case ccToolResult:
		return d.toolCall(rec, s)
	case ccToolDecision:
		return d.permissionDenied(rec, s), "session_signal"
	default: // ccSubagentCompleted
		p := d.basePayload(rec, s, "session_end")
		p["close_reason"] = "normal_exit"
		return p, "session_end"
	}
}

func (d *ClaudeCodeDialect) preCall(rec *ccRecord, s *ccSession) map[string]any {
	p := d.basePayload(rec, s, "pre_call")
	if !rec.res.capture {
		return p
	}
	if prompt, ok := rec.attrs.content("prompt"); ok {
		p["has_content"] = true
		p["content"] = map[string]any{
			"provider": claudeCodeProvider,
			"model":    "",
			"system":   nil,
			"messages": []any{map[string]any{"role": "user", "content": prompt}},
			"tools":    []any{},
			"response": []any{},
		}
	}
	return p
}

// tokenCount is a token attribute: 0 when absent, -1 when it is not a
// non-negative whole number (which validation then refuses).
func tokenCount(attrs otlpAttrs, key string) int64 {
	n, present, ok := attrs.integer(key)
	switch {
	case !present:
		return 0
	case !ok || n < 0:
		return -1
	}
	return n
}

func (d *ClaudeCodeDialect) postCall(rec *ccRecord, s *ccSession) map[string]any {
	p := d.basePayload(rec, s, "post_call")
	a := rec.attrs
	uncached := tokenCount(a, "input_tokens")
	output := tokenCount(a, "output_tokens")
	cacheRead := tokenCount(a, "cache_read_tokens")
	cacheCreation := tokenCount(a, "cache_creation_tokens")
	cache1h := tokenCount(a, "cache_creation_1h_tokens")
	if uncached < 0 || output < 0 || cacheRead < 0 || cacheCreation < 0 || cache1h < 0 {
		p["tokens_input"] = -1 // refused by validation: a count is malformed
		return p
	}
	input := uncached + cacheRead + cacheCreation
	p["tokens_input"] = input
	p["tokens_output"] = output
	p["tokens_total"] = input + output
	p["tokens_cache_read"] = cacheRead
	p["tokens_cache_creation"] = cacheCreation
	p["tokens_cache_creation_1h"] = cache1h
	if model := a.text("model"); model != "" {
		p["model"] = model
		p["model_requested"] = model
		p["model_served"] = model
	}
	p["provider"] = claudeCodeProvider
	p["billing_mode"] = rec.res.billing
	if ms, present, ok := a.integer("duration_ms"); present && ok && ms >= 0 {
		p["latency_ms"] = ms
	}
	streaming := map[string]any{"ttft_ms": nil, "final_outcome": "completed"}
	if ms, present, ok := a.integer("ttft_ms"); present && ok && ms >= 0 {
		streaming["ttft_ms"] = ms
	}
	p["streaming"] = streaming
	if cost, present, ok := a.number("cost_usd"); present {
		if !ok {
			cost = -1 // refused by validation
		}
		p["cost_reported"] = cost
		p["cost_source"] = "agent"
	}
	meta := map[string]any{}
	if id := a.text("request_id"); id != "" {
		meta["request_id"] = id
	}
	if qs := a.text("query_source"); qs != "" {
		meta["query_source"] = qs
	}
	if len(meta) > 0 {
		p["provider_metadata"] = meta
	}
	return p
}

func (d *ClaudeCodeDialect) llmError(rec *ccRecord, s *ccSession) map[string]any {
	p := d.basePayload(rec, s, "llm_error")
	a := rec.attrs
	if model := a.text("model"); model != "" {
		p["model"] = model
	}
	p["provider"] = claudeCodeProvider
	if n, present, ok := a.integer("attempt"); present && ok && n >= 1 {
		p["retry_attempt"] = n
	}
	var status any
	code, present, ok := a.integer("status_code")
	if present && ok && code >= 100 && code <= 599 {
		status = code
	} else {
		code = 0
	}
	// The error text is read to classify the error, and copied into the
	// event only when capture is on.
	text, hasText := a.content("error")
	errorType := classifyClaudeCodeAPIError(code, text)
	message := "Claude Code API error"
	if code != 0 {
		message += fmt.Sprintf(" (HTTP %d)", code)
	}
	if rec.res.capture && hasText {
		message += ": " + clipOneLine(text, otlpAPIErrorMaxChars)
	}
	var requestID any
	if id := a.text("request_id"); id != "" {
		requestID = id
	}
	p["error"] = map[string]any{
		"error_type":          errorType,
		"provider":            claudeCodeProvider,
		"http_status":         status,
		"provider_error_code": nil,
		"error_message":       message,
		"request_id":          requestID,
		"retry_after":         nil,
		"is_retryable":        retryableErrorTypes[errorType],
	}
	return p
}

// mcpToolNames are the server and tool of an MCP tool record, which
// Claude Code names only in tool_parameters, and only when
// OTEL_LOG_TOOL_DETAILS=1. Nothing else of tool_parameters is read: for
// other tools it holds their input (a Bash command line).
func mcpToolNames(a otlpAttrs) (server, tool string, ok bool) {
	if a.text("tool_name") != "mcp_tool" {
		return "", "", false
	}
	raw, isStr := a.str("tool_parameters")
	if !isStr {
		return "", "", false
	}
	var params struct {
		Server string `json:"mcp_server_name"`
		Tool   string `json:"mcp_tool_name"`
	}
	if json.Unmarshal([]byte(raw), &params) != nil || params.Server == "" || params.Tool == "" {
		return "", "", false
	}
	return params.Server, params.Tool, true
}

func (d *ClaudeCodeDialect) toolCall(rec *ccRecord, s *ccSession) (map[string]any, string) {
	a := rec.attrs
	server, mcpTool, isMCP := mcpToolNames(a)
	eventType := "tool_call"
	if isMCP {
		eventType = "mcp_tool_call"
	}
	p := d.basePayload(rec, s, eventType)
	if isMCP {
		p["server_name"] = server
		p["tool_name"] = mcpTool
	} else if name := a.text("tool_name"); name != "" {
		p["tool_name"] = name
	}
	if id := a.text("tool_use_id"); id != "" {
		p["tool_use_id"] = id
	}
	if ms, present, ok := a.integer("duration_ms"); present && ok && ms >= 0 {
		p["duration_ms"] = ms
		p["latency_ms"] = ms
	}
	if success, present, ok := a.boolean("success"); present && ok && !success {
		message := otlpRedactedErrorMessage
		if rec.res.capture {
			message = otlpNoToolErrorDetail
			if text, ok := a.content("error"); ok {
				message = clipChars(text, otlpToolErrorMaxChars)
			}
		}
		p["error"] = map[string]any{
			"error_type":  "other",
			"error_class": claudeCodeToolErrorClass,
			"message":     message,
		}
	}
	if rec.res.capture {
		if input, ok := a.content("tool_input"); ok {
			provider, model := claudeCodeProvider, ""
			if isMCP {
				provider, model = "mcp", server
			}
			p["has_content"] = true
			p["content"] = map[string]any{
				"system":      nil,
				"messages":    []any{},
				"tools":       nil,
				"response":    map[string]any{},
				"input":       nil,
				"tool_input":  asJSONValue(input),
				"tool_output": nil,
				"provider":    provider,
				"model":       model,
			}
		}
	}
	return p, eventType
}

// asJSONValue is a tool input as Claude Code sent it: the JSON document
// it encodes, or the string itself when it is not JSON.
func asJSONValue(s string) any {
	var v any
	if json.Unmarshal([]byte(s), &v) == nil {
		return v
	}
	return s
}

func (d *ClaudeCodeDialect) permissionDenied(rec *ccRecord, s *ccSession) map[string]any {
	p := d.basePayload(rec, s, "session_signal")
	a := rec.attrs
	p["signal"] = "permission_denied"
	data := map[string]any{}
	server, mcpTool, isMCP := mcpToolNames(a)
	if isMCP {
		data["tool_name"] = mcpTool
		data["mcp_server"] = server
	} else if name := a.text("tool_name"); name != "" {
		data["tool_name"] = name
	}
	if id := a.text("tool_use_id"); id != "" {
		data["tool_use_id"] = id
	}
	if source := a.text("source"); source != "" {
		data["reason"] = source
	}
	p["signal_data"] = data
	return p
}

// retryableErrorTypes are the llm_error types the taxonomy marks
// retryable.
var retryableErrorTypes = map[string]bool{
	"rate_limit": true, "overloaded": true, "timeout": true, "api_error": true,
}

// Phrases that refine an API error's type from its text, as the sensor
// and the plugin refine it. Anthropic reports an exhausted spend limit
// or credit balance under a 400 or 429 and a full context window under
// a 400; the text is read for this test only.
var (
	otlpBillingPhrases = []string{"spend limit", "spending limit", "spend cap", "credit balance"}
	otlpContextPhrases = []string{"prompt is too long", "context window", "context length"}
)

// classifyClaudeCodeAPIError files an API error under the llm_error
// taxonomy from its HTTP status (0 when Claude Code sent none) and its
// text, as the sensor classifies Anthropic's errors.
func classifyClaudeCodeAPIError(status int64, text string) string {
	lower := strings.ToLower(truncateUTF8(text, 2048))
	mentions := func(phrases []string) bool {
		for _, p := range phrases {
			if strings.Contains(lower, p) {
				return true
			}
		}
		return false
	}
	switch status {
	case 400:
		switch {
		case mentions(otlpBillingPhrases):
			return "quota_exceeded"
		case mentions(otlpContextPhrases):
			return "context_overflow"
		}
		return "invalid_request"
	case 401:
		return "authentication"
	case 402:
		return "quota_exceeded"
	case 403:
		return "permission"
	case 404:
		return "not_found"
	case 408, 504:
		return "timeout"
	case 409, 422:
		return "invalid_request"
	case 413:
		return "request_too_large"
	case 429:
		if mentions(otlpBillingPhrases) {
			return "quota_exceeded"
		}
		return "rate_limit"
	case 529:
		return "overloaded"
	}
	switch {
	case status >= 500:
		return "api_error"
	case status == 0 && (strings.Contains(lower, "timeout") || strings.Contains(lower, "timed out")):
		return "timeout"
	}
	return "other"
}

// clipChars cuts s to at most n characters, marking the cut.
func clipChars(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

// clipOneLine is s on one line, cut to n characters with "..." as the
// sensor cuts a provider's message.
func clipOneLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n-3]) + "..."
}

// finishOTLPEvent encodes an event, cutting its content to fit
// maxOTLPEventBodyBytes, and validates the result exactly as
// POST /v1/events validates a posted one. It returns the body, or the
// validation message.
func finishOTLPEvent(payload map[string]any, now time.Time) ([]byte, string) {
	body, err := fitOTLPEvent(payload)
	if err != nil {
		return nil, "it does not encode"
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, "it does not encode"
	}
	if msg := validateEventPayload(decoded, now); msg != "" {
		return nil, msg
	}
	return body, ""
}

// fitOTLPEvent encodes an event within maxOTLPEventBodyBytes. An event
// over it has the strings of its content cut, each to the same largest
// length that fits, with a marker in place of the cut text, as the
// plugin cuts its events; when no cut fits, the event goes without its
// content.
func fitOTLPEvent(payload map[string]any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil || len(body) <= maxOTLPEventBodyBytes || payload["content"] == nil {
		return body, err
	}
	content := payload["content"]
	cut := func(capBytes int) ([]byte, error) {
		payload["content"] = capContentStrings(content, capBytes)
		return json.Marshal(payload)
	}
	lo, hi := 0, min(longestContentString(content), maxOTLPEventBodyBytes)
	var best []byte
	for lo <= hi {
		mid := (lo + hi) / 2
		candidate, err := cut(mid)
		if err != nil {
			return nil, err
		}
		if len(candidate) <= maxOTLPEventBodyBytes {
			best, lo = candidate, mid+1
		} else {
			hi = mid - 1
		}
	}
	if best != nil {
		payload["content"] = content
		return best, nil
	}
	payload["content"], payload["has_content"] = nil, false
	return json.Marshal(payload)
}

// capContentStrings is value with every string longer than capBytes
// cut to capBytes and marked; structure and other values are kept.
func capContentStrings(value any, capBytes int) any {
	switch v := value.(type) {
	case string:
		if len(v) <= capBytes {
			return v
		}
		kept := truncateUTF8(v, capBytes)
		marked := kept + fmt.Sprintf(otlpTruncationTemplate, len(kept), len(v))
		if len(marked) < len(v) {
			return marked
		}
		return v
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = capContentStrings(item, capBytes)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, item := range v {
			out[k] = capContentStrings(item, capBytes)
		}
		return out
	}
	return value
}

func longestContentString(value any) int {
	switch v := value.(type) {
	case string:
		return len(v)
	case []any:
		longest := 0
		for _, item := range v {
			longest = max(longest, longestContentString(item))
		}
		return longest
	case map[string]any:
		longest := 0
		for _, item := range v {
			longest = max(longest, longestContentString(item))
		}
		return longest
	}
	return 0
}
