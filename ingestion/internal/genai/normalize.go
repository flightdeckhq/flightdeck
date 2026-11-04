package genai

import (
	"bytes"
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/identity"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
)

// Input is one claimed trace to map.
type Input struct {
	// Trace is the trace's row: its key, framework, identity resource,
	// capture posture, first_received_at and assembly_count.
	Trace otlpstage.Trace
	// Facts is every staged record of the trace, assembled or not.
	Facts []otlpstage.StagedFact
	// Reason is why the trace is due, recorded in each session's
	// context.otel_assembly.
	Reason otlpstage.Reason
	// ValidFrom is the oldest timestamp validation accepts when the
	// events are published; zero sets no bound. A re-attaching
	// session_end dated before it is dated after the events it closes.
	ValidFrom time.Time
}

// Event is one mapped event, in publish order.
type Event struct {
	EventType string
	SessionID string
	// Attach marks a session_start that re-attaches a session an
	// earlier assembly already closed.
	Attach  bool
	Payload map[string]any
}

// idPrefix starts every GenAI id: uuid5 of
// flightdeck://otlp/genai/<token id>/<trace id hex>/<kind>/...
const idPrefix = "flightdeck://otlp/genai/"

// The id kinds.
const (
	idSession = "session"
	idEvent   = "event"
	idStart   = "start"
	idEnd     = "end"
	idSignal  = "signal"
)

// attachLead is how far a re-attaching session_start is dated before
// the earliest event it precedes, and a moved session_end after the
// latest it follows. Postgres stores timestamps to the microsecond, so
// one microsecond orders them without moving them noticeably; the
// Claude Code dialect dates its synthetic start the same way.
const attachLead = time.Microsecond

// The fixed values of GenAI events.
const (
	telemetryOTLP     = "otlp"
	closeNormalExit   = "normal_exit"
	stateError        = "error"
	signalHandoff     = "agent_handoff"
	toolErrorType     = "other"
	costSourceAgent   = "agent"
	finalCompleted    = "completed"
	adkNotSpecifiedID = "<not specified>"
	// redactedMessage stands in for a failed tool's error text when
	// capture is off: the placeholder the Claude Code dialect, the
	// plugin and the worker use.
	redactedMessage = "<redacted>"
	// modelErrorMessage is a failed model call's error_message when the
	// span names no error class.
	modelErrorMessage = "model call failed"
)

// Event ranks order events that end at the same instant: a tool call
// before the hand-off signal its span also carries.
const (
	rankCall = iota
	rankSignal
)

// session is one Flightdeck session of the trace.
type session struct {
	id        string
	agent     *node // nil for the unattributed session
	label     string
	role      string // "" for a root
	agentName string
	agentID   string
	parent    *session
	depth     int
	// owned are the spans whose events belong to the session, published
	// earlier or now; events are the ones to publish now.
	owned  []*node
	events []*pending
}

// pending is one call, tool or signal event awaiting its place in the
// publish order.
type pending struct {
	ts      int64
	rank    int
	span    [8]byte
	event   Event
	session *session
}

type resolver struct {
	in       Input
	ix       *traceIndex
	ident    traceIdentity
	prefix   string
	received string // first_received_at in Unix nanoseconds
	sessions map[*node]*session
	fallback *session
	order    []*session // every session, in creation order
}

// Resolve maps a trace's staged records to events: each named agent
// span is a session, each counted model span a post_call (llm_error
// when it failed), each tool span a tool_call and each hand-off a
// session_signal, on the session of the nearest agent ancestor.
// Only records not yet assembled publish events; a session already
// closed by an earlier assembly that gains events is re-attached and
// closed again. The result is in publish order: session starts parents
// first, then calls, tools and signals by span end, then session ends
// children first. It is deterministic in the staged records: every id is
// a uuid5 of the token, trace and span, so mapping a trace again
// publishes the same events.
func Resolve(in Input) []Event {
	r := &resolver{
		in:       in,
		ix:       indexTrace(in.Facts),
		ident:    newTraceIdentity(in.Trace.Resource, in.Trace.Source),
		prefix:   idPrefix + in.Trace.Key.TokenKey + "/" + hexID(in.Trace.Key.TraceID[:]),
		received: strconv.FormatInt(in.Trace.FirstReceivedAt.UnixNano(), 10),
		sessions: map[*node]*session{},
	}
	for _, n := range r.ix.order {
		if n.kind == kindAgent {
			r.agentSession(n)
		}
	}
	for _, n := range r.ix.order {
		switch n.kind {
		case kindModel:
			r.modelCall(n)
		case kindTool:
			r.toolCall(n)
		case kindHandoff:
			r.handoff(n)
		}
	}
	return r.publishOrder()
}

func (r *resolver) id(kind string, parts ...string) string {
	name := r.prefix + "/" + kind
	for _, p := range parts {
		name += "/" + p
	}
	return identity.UUID5(identity.NamespaceFlightdeck, name)
}

// agentSession is the session of an agent span, its ancestors' made
// first.
func (r *resolver) agentSession(n *node) *session {
	if s, ok := r.sessions[n]; ok {
		return s
	}
	s := &session{id: r.id(idSession, n.spanHex()), agent: n, label: agentLabel(n.fact.AgentName)}
	if pa := n.nearestAgent(); pa != nil {
		s.parent = r.agentSession(pa)
		root := s.parent
		for root.parent != nil {
			root = root.parent
		}
		s.role = s.label
		s.depth = s.parent.depth + 1
		s.agentName = root.agentName + "/" + s.role
		s.agentID = r.ident.agentID(root.agentName, s.role)
	} else {
		s.agentName = r.ident.rootAgentName(s.label)
		s.agentID = r.ident.agentID(s.agentName, "")
	}
	r.sessions[n] = s
	r.order = append(r.order, s)
	return s
}

// owner is the session a call, tool or signal span belongs to: its
// nearest agent ancestor's, never the agent its own attributes name,
// else the trace's unattributed session.
func (r *resolver) owner(n *node) *session {
	if a := n.nearestAgent(); a != nil {
		return r.sessions[a]
	}
	if r.fallback == nil {
		r.fallback = &session{
			id:        r.id(idSession, r.received),
			agentName: r.ident.flavor,
			agentID:   r.ident.agentID(r.ident.flavor, ""),
		}
		r.order = append(r.order, r.fallback)
	}
	return r.fallback
}

func (r *resolver) add(s *session, n *node, rank int, ev Event) {
	s.events = append(s.events, &pending{ts: n.fact.EndNs, rank: rank, span: n.fact.SpanID, event: ev, session: s})
}

// modelCall maps a counted model span: one with no model span between
// it and its agent. A late span over an already published call
// publishes nothing, so totals stay single.
func (r *resolver) modelCall(n *node) {
	if n.modelAbove() {
		return
	}
	s := r.owner(n)
	s.owned = append(s.owned, n)
	if n.fact.Assembled || n.assembledModelBelow() {
		return
	}
	if n.failed() {
		r.add(s, n, rankCall, Event{EventType: "llm_error", SessionID: s.id, Payload: r.llmError(s, n)})
		return
	}
	r.add(s, n, rankCall, Event{EventType: "post_call", SessionID: s.id, Payload: r.postCall(s, n)})
}

func (r *resolver) toolCall(n *node) {
	s := r.owner(n)
	s.owned = append(s.owned, n)
	if n.fact.Assembled {
		return
	}
	r.add(s, n, rankCall, Event{EventType: "tool_call", SessionID: s.id, Payload: r.tool(s, n)})
	if metaText(n.meta, attrToolType) == adkTransferToolType {
		data := map[string]any{}
		if s.agent != nil {
			data["from"] = s.label
		}
		if to := nextSiblingAgent(s.agent, n); to != nil {
			data["to"] = agentLabel(to.fact.AgentName)
		}
		r.add(s, n, rankSignal, Event{EventType: "session_signal", SessionID: s.id, Payload: r.signal(s, n, data)})
	}
}

// handoff maps OpenAI Agents' agent_handoff span to the hand-off signal
// on the agent handing off.
func (r *resolver) handoff(n *node) {
	s := r.owner(n)
	s.owned = append(s.owned, n)
	if n.fact.Assembled {
		return
	}
	data := map[string]any{}
	if from := agentLabel(metaText(n.meta, attrHandoffFrom)); from != "" {
		data["from"] = from
	}
	if to := agentLabel(metaText(n.meta, attrHandoffTo)); to != "" {
		data["to"] = to
	}
	r.add(s, n, rankSignal, Event{EventType: "session_signal", SessionID: s.id, Payload: r.signal(s, n, data)})
}

// nextSiblingAgent is the agent a Google ADK transfer hands to: the
// first agent span under the same parent as the agent handing off that
// starts after the transfer tool did.
func nextSiblingAgent(from *node, tool *node) *node {
	if from == nil || from.parent == nil {
		return nil
	}
	for _, c := range from.parent.children {
		if c != from && c.kind == kindAgent && c.fact.StartNs >= tool.fact.StartNs {
			return c
		}
	}
	return nil
}

// base is the identity every event of a session carries.
func (r *resolver) base(s *session, eventType, id string, ns int64) map[string]any {
	p := map[string]any{
		"id":          id,
		"session_id":  s.id,
		"event_type":  eventType,
		"flavor":      r.ident.flavor,
		"agent_type":  r.ident.agentType,
		"agent_id":    s.agentID,
		"agent_name":  s.agentName,
		"client_type": ClientType,
		"user":        r.ident.user,
		"hostname":    r.ident.host,
		"host":        r.ident.host,
		"framework":   r.in.Trace.Source,
		"timestamp":   stamp(ns),
		"has_content": false,
	}
	if s.parent != nil {
		p["parent_session_id"] = s.parent.id
		p["agent_role"] = s.role
	}
	return p
}

func (r *resolver) postCall(s *session, n *node) map[string]any {
	p := r.base(s, "post_call", r.id(idEvent, n.spanHex()), n.fact.EndNs)
	m := n.meta
	p["latency_ms"] = durationMs(n)
	if model := metaText(m, attrRequestModel); model != "" {
		p["model_requested"] = model
	}
	if model := metaText(m, attrResponseModel); model != "" {
		p["model_served"] = model
	}
	meta := map[string]any{}
	input, output := tokenCount(m, attrInputTokens), tokenCount(m, attrOutputTokens)
	read, readSent := cacheRead(m)
	creation, creationSent := tokenCount(m, attrCacheCreation), metaHas(m, attrCacheCreation)
	if input < 0 || output < 0 || read < 0 || creation < 0 {
		p["tokens_total"] = int64(-1) // refused by validation: a count is malformed
	} else {
		// The conventions define input_tokens to include cache; a
		// framework whose count is smaller than its cache counts left
		// them out, and they are added.
		if input < read+creation {
			input += read + creation
			meta["input_excluded_cache"] = true
		}
		p["tokens_input"] = input
		p["tokens_output"] = output
		p["tokens_total"] = input + output
		if readSent {
			p["tokens_cache_read"] = read
		}
		if creationSent {
			p["tokens_cache_creation"] = creation
		}
	}
	if provider := r.provider(n); provider != "" {
		p["provider"] = provider
	}
	if ttft, present, ok := metaNumber(m, attrTTFT); present && ok && ttft >= 0 {
		p["streaming"] = map[string]any{"ttft_ms": ttft, "final_outcome": finalCompleted}
	}
	if cost, present, ok := metaNumber(m, attrOperationCost); present {
		if !ok {
			cost = -1 // refused by validation
		}
		p["cost_reported"] = cost
		p["cost_source"] = costSourceAgent
	}
	if id := metaText(m, attrResponseID); id != "" {
		meta["response_id"] = id
	}
	if len(meta) > 0 {
		p["provider_metadata"] = meta
	}
	if r.ident.billing != "" {
		p["billing_mode"] = r.ident.billing
	}
	return p
}

// llmError maps a failed model span. Its class is the span's error.type,
// else its exception's type, which are names, not content; the error
// text is content and is not read here.
func (r *resolver) llmError(s *session, n *node) map[string]any {
	p := r.base(s, "llm_error", r.id(idEvent, n.spanHex()), n.fact.EndNs)
	p["latency_ms"] = durationMs(n)
	if model := metaText(n.meta, attrRequestModel); model != "" {
		p["model_requested"] = model
	}
	provider := r.provider(n)
	if provider != "" {
		p["provider"] = provider
	}
	class := errorClass(n)
	errorType := classifyErrorClass(class)
	message := class
	if message == "" {
		message = modelErrorMessage
	}
	var errProvider any
	if provider != "" {
		errProvider = provider
	}
	p["error"] = map[string]any{
		"error_type":          errorType,
		"provider":            errProvider,
		"http_status":         nil,
		"provider_error_code": nil,
		"error_message":       message,
		"request_id":          nil,
		"retry_after":         nil,
		"is_retryable":        retryableErrorTypes[errorType],
	}
	return p
}

func (r *resolver) tool(s *session, n *node) map[string]any {
	p := r.base(s, "tool_call", r.id(idEvent, n.spanHex()), n.fact.EndNs)
	if name := metaText(n.meta, attrToolName); name != "" {
		p["tool_name"] = name
	}
	if id := metaText(n.meta, attrToolCallID); id != "" && id != adkNotSpecifiedID {
		p["tool_use_id"] = id
	}
	ms := durationMs(n)
	p["latency_ms"] = ms
	p["duration_ms"] = ms
	if n.failed() {
		block := map[string]any{"error_type": toolErrorType}
		if class := errorClass(n); class != "" {
			block["error_class"] = class
		}
		if !r.in.Trace.Capture {
			block["message"] = redactedMessage
		}
		p["error"] = block
	}
	return p
}

func (r *resolver) signal(s *session, n *node, data map[string]any) map[string]any {
	p := r.base(s, "session_signal", r.id(idSignal, n.spanHex()), n.fact.EndNs)
	p["signal"] = signalHandoff
	p["signal_data"] = data
	return p
}

// provider is a model span's provider, passed through only from a
// framework whose gen_ai.provider.name names the model's provider, and
// only when it maps to the provider vocabulary.
func (r *resolver) provider(n *node) string {
	if !n.source.TrustProvider {
		return ""
	}
	v := metaText(n.meta, attrProviderName)
	if v == "" {
		v = metaText(n.meta, attrSystem)
	}
	switch {
	case v == "anthropic", v == "openai":
		return v
	case strings.HasPrefix(v, "gcp."):
		return "google"
	case v == "x_ai":
		return "xai"
	case v == "mistral_ai":
		return "mistral"
	}
	return ""
}

// errorClass is a failed span's error class: error.type, else the type
// of its first exception event.
func errorClass(n *node) string {
	if t := metaText(n.meta, attrErrorType); t != "" {
		return t
	}
	return metaText(n.meta, attrExceptionType)
}

// publishOrder lays the sessions' starts and ends around their events.
func (r *resolver) publishOrder() []Event {
	var starts, ends []*sessionEdge
	var events []*pending
	for _, s := range r.order {
		edge := r.edges(s)
		if edge == nil {
			continue
		}
		starts = append(starts, edge)
		ends = append(ends, edge)
		events = append(events, s.events...)
	}
	slices.SortStableFunc(starts, func(a, b *sessionEdge) int {
		if a.s.depth != b.s.depth {
			return a.s.depth - b.s.depth
		}
		return compareNs(a.startNs, b.startNs)
	})
	slices.SortStableFunc(events, func(a, b *pending) int {
		if c := compareNs(a.ts, b.ts); c != 0 {
			return c
		}
		if a.rank != b.rank {
			return a.rank - b.rank
		}
		return bytes.Compare(a.span[:], b.span[:])
	})
	slices.SortStableFunc(ends, func(a, b *sessionEdge) int {
		if a.s.depth != b.s.depth {
			return b.s.depth - a.s.depth
		}
		return compareNs(a.endNs, b.endNs)
	})
	out := make([]Event, 0, len(starts)+len(events)+len(ends))
	for _, e := range starts {
		out = append(out, e.start)
	}
	for _, p := range events {
		out = append(out, p.event)
	}
	for _, e := range ends {
		out = append(out, e.end)
	}
	return out
}

// sessionEdge is a session's start and end in this assembly.
type sessionEdge struct {
	s              *session
	start, end     Event
	startNs, endNs int64
}

// edges is the session_start and session_end a session needs in this
// assembly, or nil when it needs none: a session is started and ended
// when its agent span is new (the unattributed session: when none of its
// records was published before), and re-attached and closed again when
// it was closed by an earlier assembly and gains events now.
func (r *resolver) edges(s *session) *sessionEdge {
	first, startNs, endNs := r.bounds(s)
	if !first && len(s.events) == 0 {
		return nil
	}
	spanPart := r.received
	if s.agent != nil {
		spanPart = s.agent.spanHex()
	}
	startID, endID := r.id(idStart, spanPart), r.id(idEnd, spanPart)
	if !first {
		count := strconv.Itoa(r.in.Trace.AssemblyCount)
		startID = r.id(idStart, spanPart, r.received, count)
		endID = r.id(idEnd, spanPart, r.received, count)
		earliest, latest := s.events[0].ts, s.events[0].ts
		for _, p := range s.events[1:] {
			earliest, latest = min(earliest, p.ts), max(latest, p.ts)
		}
		startNs = earliest - int64(attachLead)
		if !r.in.ValidFrom.IsZero() && endNs < r.in.ValidFrom.UnixNano() {
			endNs = latest + int64(attachLead)
		}
	}
	start := r.base(s, "session_start", startID, startNs)
	start["sensor_version"] = r.in.Trace.SourceVersion
	start["capture_prompts"] = r.in.Trace.Capture
	start["context"] = r.context(s)

	end := r.base(s, "session_end", endID, endNs)
	end["close_reason"] = closeNormalExit
	if s.agent != nil && s.agent.failed() {
		end["state"] = stateError
		block := map[string]any{}
		if class := errorClass(s.agent); class != "" {
			block["error_class"] = class
		}
		end["error"] = block
	}
	return &sessionEdge{
		s:       s,
		start:   Event{EventType: "session_start", SessionID: s.id, Attach: !first, Payload: start},
		end:     Event{EventType: "session_end", SessionID: s.id, Payload: end},
		startNs: startNs,
		endNs:   endNs,
	}
}

// bounds reports whether this is the session's first emission and the
// start and end it is dated at: an agent session's are its span's; the
// unattributed session's are its earliest record's start and its latest
// record's end.
func (r *resolver) bounds(s *session) (first bool, startNs, endNs int64) {
	if s.agent != nil {
		return !s.agent.fact.Assembled, s.agent.fact.StartNs, s.agent.fact.EndNs
	}
	first = true
	for i, n := range s.owned {
		if n.fact.Assembled {
			first = false
		}
		if i == 0 || n.fact.StartNs < startNs {
			startNs = n.fact.StartNs
		}
		if i == 0 || n.fact.EndNs > endNs {
			endNs = n.fact.EndNs
		}
	}
	return first, startNs, endNs
}

func (r *resolver) context(s *session) map[string]any {
	framework := r.in.Trace.Source
	if v := r.in.Trace.SourceVersion; v != "" {
		framework += "/" + v
	}
	ctx := map[string]any{
		"telemetry":           telemetryOTLP,
		"supports_directives": false,
		"frameworks":          []any{framework},
		"otel_trace_id":       hexID(r.in.Trace.Key.TraceID[:]),
		"otel_assembly":       string(r.in.Reason),
	}
	if s.agent == nil {
		ctx["otel_unattributed"] = true
		return ctx
	}
	ctx["otel_span_id"] = s.agent.spanHex()
	ctx["otel_scope"] = s.agent.fact.ScopeName
	if conv := metaText(s.agent.meta, attrConversationID); conv != "" {
		ctx["gen_ai_conversation_id"] = conv
	}
	return ctx
}

// The error classes a failed model call is filed under, read from the
// last segment of its class name (openai.NotFoundError is NotFoundError)
// as the sensor classifies a provider's exception: the first entry the
// name ends with wins, so a framework's own subclass name
// (pydantic_ai's ModelNotFoundError) files with its base.
var errorClassTypes = []struct {
	suffix, errorType string
}{
	{"RateLimitError", "rate_limit"},
	{"PermissionDeniedError", "permission"},
	{"PermissionError", "permission"},
	{"AuthenticationError", "authentication"},
	{"OAuthError", "authentication"},
	{"LengthFinishReasonError", "invalid_request"},
	{"ContentFilterFinishReasonError", "content_filter"},
	{"NotFoundError", "not_found"},
	{"UnprocessableEntityError", "invalid_request"},
	{"BadRequestError", "invalid_request"},
	{"ConflictError", "invalid_request"},
	{"ServiceUnavailableError", "overloaded"},
	{"InternalServerError", "api_error"},
	{"APITimeoutError", "timeout"},
	{"TimeoutError", "timeout"},
	{"TimeoutException", "timeout"},
	{"ConnectTimeout", "timeout"},
	{"ReadTimeout", "timeout"},
	{"WriteTimeout", "timeout"},
	{"PoolTimeout", "timeout"},
	{"APIConnectionError", "api_error"},
	{"APIStatusError", "api_error"},
	{"APIError", "api_error"},
}

// retryableErrorTypes are the llm_error types the taxonomy marks
// retryable.
var retryableErrorTypes = map[string]bool{
	"rate_limit": true, "overloaded": true, "timeout": true, "api_error": true,
}

func classifyErrorClass(class string) string {
	name := class
	if i := strings.LastIndexByte(name, '.'); i >= 0 {
		name = name[i+1:]
	}
	for _, e := range errorClassTypes {
		if name != "" && strings.HasSuffix(name, e.suffix) {
			return e.errorType
		}
	}
	return "other"
}

// cacheRead is the first present of the three cache-read spellings,
// never their sum, and whether any was sent.
func cacheRead(m map[string]any) (int64, bool) {
	for _, key := range []string{attrCacheRead, attrCacheReadDetails, attrCacheReadLegacy} {
		if metaHas(m, key) {
			return tokenCount(m, key), true
		}
	}
	return 0, false
}

// tokenCount is a token attribute: 0 when absent, -1 when it is not a
// non-negative whole number.
func tokenCount(m map[string]any, key string) int64 {
	n, present, ok := metaInt(m, key)
	switch {
	case !present:
		return 0
	case !ok || n < 0:
		return -1
	}
	return n
}

func metaHas(m map[string]any, key string) bool {
	_, ok := m[key]
	return ok
}

func metaText(m map[string]any, key string) string {
	switch v := m[key].(type) {
	case string:
		return v
	case json.Number:
		return v.String()
	case bool:
		return strconv.FormatBool(v)
	}
	return ""
}

// maxWholeNumber is the largest whole number a double holds exactly
// (2^53), the bound validation holds integers to.
const maxWholeNumber = 1 << 53

// metaInt is an attribute as an int64: a whole number, or a string of
// one. present is false when it is absent; ok is false when it is not a
// whole number.
func metaInt(m map[string]any, key string) (n int64, present, ok bool) {
	v, has := m[key]
	if !has {
		return 0, false, false
	}
	var s string
	switch x := v.(type) {
	case json.Number:
		s = x.String()
	case string:
		s = strings.TrimSpace(x)
	default:
		return 0, true, false
	}
	if i, err := strconv.ParseInt(s, 10, 64); err == nil {
		return i, true, i <= maxWholeNumber && i >= -maxWholeNumber
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f != float64(int64(f)) || f > maxWholeNumber || f < -maxWholeNumber {
		return 0, true, false
	}
	return int64(f), true, true
}

// metaNumber is an attribute as a float64: a number or a numeric
// string.
func metaNumber(m map[string]any, key string) (f float64, present, ok bool) {
	v, has := m[key]
	if !has {
		return 0, false, false
	}
	var s string
	switch x := v.(type) {
	case json.Number:
		s = x.String()
	case string:
		s = strings.TrimSpace(x)
	default:
		return 0, true, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, true, false
	}
	return f, true, true
}

func durationMs(n *node) int64 {
	d := n.fact.EndNs - n.fact.StartNs
	if d < 0 {
		return 0
	}
	return d / int64(time.Millisecond)
}

func stamp(ns int64) string {
	return time.Unix(0, ns).UTC().Format(time.RFC3339Nano)
}

func compareNs(a, b int64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}
