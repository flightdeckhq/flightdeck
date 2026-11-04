package genai

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/identity"
)

// The fixed identity of a GenAI session.
const (
	// ClientType is the client_type of every GenAI session: the
	// frameworks have no client type registry entry of their own, and
	// context.frameworks names the framework.
	ClientType = "otlp"
	// unknownIdentity stands in for a user or host the resource does not
	// name, as for every client.
	unknownIdentity = "unknown"
	// defaultAgentType is the agent_type of a resource that declares no
	// valid flightdeck.agent_type: a framework app runs in production
	// unless its operator says it is a coding agent.
	defaultAgentType = "production"
	// unknownServicePrefix starts the OpenTelemetry SDK's default
	// service.name (unknown_service:python), which names no app.
	unknownServicePrefix = "unknown_service"
	// strandsServiceName is the service.name Strands sets for every app,
	// which names the framework, not the app.
	strandsServiceName = "strands-agents"
)

// maxIdentityBytes bounds every part an agent id is derived from (flavor,
// user, host, agent name and role), and each hand-off agent name: the
// 256-byte agent_role limit validation enforces. Each part is cut before
// the id is derived, so the stored role and the id always agree.
const maxIdentityBytes = 256

// validAgentTypes is the locked agent_type vocabulary.
var validAgentTypes = map[string]bool{"coding": true, "production": true}

// traceIdentity is what a trace's identity resource says about every
// session in it.
type traceIdentity struct {
	flavor    string
	agentType string
	user      string
	host      string
	billing   string // flightdeck.billing_mode; "" leaves the otlp default
}

// newTraceIdentity reads the trace's identity resource (the allowlisted
// attributes of the resource that created its row) and its framework
// label.
func newTraceIdentity(resource json.RawMessage, label string) traceIdentity {
	attrs := map[string]any{}
	_ = json.Unmarshal(resource, &attrs)
	get := func(key string) string {
		s, _ := attrs[key].(string)
		return strings.TrimSpace(s)
	}
	id := traceIdentity{
		flavor:    get(attrFlavor),
		agentType: get(attrAgentType),
		user:      get(attrUserID),
		host:      get(attrHostName),
		billing:   get(attrBillingMode),
	}
	if id.flavor == "" {
		svc := get(attrServiceName)
		if svc != "" && !strings.HasPrefix(svc, unknownServicePrefix) && svc != strandsServiceName {
			id.flavor = svc
		}
	}
	if id.flavor == "" {
		id.flavor = label
	}
	if !validAgentTypes[id.agentType] {
		id.agentType = defaultAgentType
	}
	if id.user == "" {
		id.user = get(attrUserName)
	}
	if id.user == "" {
		id.user = unknownIdentity
	}
	if id.host == "" {
		id.host = unknownIdentity
	}
	id.flavor = cutIdentity(id.flavor)
	id.user = cutIdentity(id.user)
	id.host = cutIdentity(id.host)
	return id
}

// agentLabel is an agent span's name as identity uses it: trimmed and
// cut to maxIdentityBytes, then trimmed again so a cut that ends on a
// space leaves the role and the id it derives alike.
func agentLabel(name string) string {
	return identity.TrimRole(cutIdentity(identity.TrimRole(name)))
}

// rootAgentName is a root agent's agent_name: the flavor, so agents of
// the same name in different frameworks or apps stay apart, and its
// name.
func (t traceIdentity) rootAgentName(agent string) string {
	return t.flavor + "/" + agent
}

// agentID is the agent id of a session named agentName (for a child, its
// root's agent_name) under role ("" for a root).
func (t traceIdentity) agentID(agentName, role string) string {
	return identity.AgentID(t.agentType, t.user, t.host, ClientType, agentName, role)
}

// cutIdentity cuts s to maxIdentityBytes at a UTF-8 boundary.
func cutIdentity(s string) string {
	return truncateUTF8(s, maxIdentityBytes)
}

// truncateUTF8 cuts s to at most n bytes without splitting a rune.
func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
