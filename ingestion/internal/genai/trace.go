package genai

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"slices"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/identity"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
)

// spanKind is what a span is to the mapping.
type spanKind int

const (
	// kindLink only links its parent to its children: every span of a
	// scope the table does not name, and a recognised span that is no
	// model call, tool or named agent (OpenAI Agents' nameless Agent
	// workflow root and its unknown spans, ADK's invoke_workflow,
	// Strands' execute_event_loop_cycle).
	kindLink spanKind = iota
	kindModel
	kindTool
	kindAgent
	// kindHandoff is OpenAI Agents' agent_handoff span: a link span
	// that also marks a hand-off.
	kindHandoff
)

// The gen_ai.operation.name values the mapping reads. OpGenerateContent
// is exported for the assembler, which counts Google ADK's
// generate_content spans against their log records.
const (
	opChat            = "chat"
	OpGenerateContent = "generate_content"
	opExecuteTool     = "execute_tool"
	opInvokeAgent     = "invoke_agent"
	opAgentHandoff    = "agent_handoff"
)

// adkTransferToolType is the gen_ai.tool.type of Google ADK's
// transfer_to_agent tool, which hands the conversation to a sibling
// agent.
const adkTransferToolType = "TransferToAgentTool"

// node is one staged span of a trace.
type node struct {
	fact     *otlpstage.StagedFact
	meta     map[string]any
	kind     spanKind
	source   Source // the span's own framework; zero for a foreign scope
	parent   *node  // nil for a root, or when the parent was not staged
	children []*node
}

// spanHex is the span id in lower-case hex, as ids and context name it.
func (n *node) spanHex() string { return hexID(n.fact.SpanID[:]) }

func (n *node) failed() bool { return n.fact.Status == statusError }

// traceIndex is a trace's spans by id, linked to their parents.
type traceIndex struct {
	spans map[[8]byte]*node
	// order is every span in a fixed order: by start, then span id, so
	// the mapping does not depend on the order facts were loaded in.
	order []*node
}

// indexTrace links a trace's span facts; its log facts are not part of
// the tree (they describe a call already present as a span).
func indexTrace(facts []otlpstage.StagedFact) *traceIndex {
	ix := &traceIndex{spans: map[[8]byte]*node{}}
	for i := range facts {
		f := &facts[i]
		if f.Kind != otlpstage.KindSpan {
			continue
		}
		if _, dup := ix.spans[f.SpanID]; dup {
			continue
		}
		n := &node{fact: f, meta: decodeMeta(f.Meta)}
		n.source, _ = SourceForScope(f.ScopeName)
		n.kind = classify(n)
		ix.spans[f.SpanID] = n
		ix.order = append(ix.order, n)
	}
	slices.SortFunc(ix.order, func(a, b *node) int {
		if a.fact.StartNs != b.fact.StartNs {
			if a.fact.StartNs < b.fact.StartNs {
				return -1
			}
			return 1
		}
		return bytes.Compare(a.fact.SpanID[:], b.fact.SpanID[:])
	})
	for _, n := range ix.order {
		if n.fact.ParentSpanID == ([8]byte{}) || n.fact.ParentSpanID == n.fact.SpanID {
			continue
		}
		if p, ok := ix.spans[n.fact.ParentSpanID]; ok {
			n.parent = p
			p.children = append(p.children, n)
		}
	}
	// A parent chain that loops (a malformed trace) is cut where the
	// loop closes, so every walk up a chain ends.
	for _, n := range ix.order {
		seen := map[*node]bool{n: true}
		for c := n; c.parent != nil; c = c.parent {
			if seen[c.parent] {
				p := c.parent
				p.children = slices.DeleteFunc(p.children, func(x *node) bool { return x == c })
				c.parent = nil
				break
			}
			seen[c.parent] = true
		}
	}
	return ix
}

// IsAgentSpan reports whether a span fact is an agent span by the rule
// the mapping uses: an invoke_agent span of a recognised scope with a
// non-empty gen_ai.agent.name. The receiver charges each one twice, for
// the session_start and session_end it becomes.
func IsAgentSpan(f otlpstage.Fact) bool {
	if f.Kind != otlpstage.KindSpan {
		return false
	}
	n := &node{fact: &otlpstage.StagedFact{Fact: f}}
	n.source, _ = SourceForScope(f.ScopeName)
	return classify(n) == kindAgent
}

// classify is the span's kind, from its scope and operation.
func classify(n *node) spanKind {
	if n.source.Label == "" {
		return kindLink // a scope the table does not name only links
	}
	switch n.fact.Op {
	case opChat, OpGenerateContent:
		return kindModel
	case opExecuteTool:
		return kindTool
	case opInvokeAgent:
		if identity.TrimRole(n.fact.AgentName) != "" {
			return kindAgent
		}
	case opAgentHandoff:
		return kindHandoff
	}
	return kindLink
}

// nearestAgent is the closest agent span among n's ancestors, or nil
// when there is none among the staged spans: the chain reaches a root,
// or is cut by a span that has not been staged.
func (n *node) nearestAgent() *node {
	for a := n.parent; a != nil; a = a.parent {
		if a.kind == kindAgent {
			return a
		}
	}
	return nil
}

// nearestAgentAssembledBy is the closest agent span among n's ancestors
// that was assembled in assembly `by` or an earlier one, skipping agent
// spans not yet assembled or assembled later: the ancestors n's session
// was published with when assembly `by` published it.
func (n *node) nearestAgentAssembledBy(by int) *node {
	for a := n.parent; a != nil; a = a.parent {
		if a.kind == kindAgent && a.fact.Assembled && a.fact.AssembledIn <= by {
			return a
		}
	}
	return nil
}

// modelAbove reports whether a model span lies between n and its
// nearest agent ancestor (or, with none, anywhere above it): a model
// span wrapped in another counts once, as the outer call.
func (n *node) modelAbove() bool {
	for a := n.parent; a != nil && a.kind != kindAgent; a = a.parent {
		if a.kind == kindModel {
			return true
		}
	}
	return false
}

// assembledModelBelow reports whether n's subtree holds a model span an
// earlier assembly already published: a late outer span must not count
// its call a second time.
func (n *node) assembledModelBelow() bool {
	for _, c := range n.children {
		if c.kind == kindModel && c.fact.Assembled {
			return true
		}
		if c.assembledModelBelow() {
			return true
		}
	}
	return false
}

// decodeMeta reads a fact's attribute object, numbers kept exact.
func decodeMeta(raw json.RawMessage) map[string]any {
	m := map[string]any{}
	if len(raw) == 0 {
		return m
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil || m == nil {
		return map[string]any{}
	}
	return m
}

func hexID(b []byte) string { return hex.EncodeToString(b) }
