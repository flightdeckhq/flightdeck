package storagetest

// SeedScale writes a fleet's history straight through the storage
// module, for the scale check (api/internal/store/scale_test.go) and the
// retention tests: a year of runs is more than ingestion accepts (it
// refuses an event dated more than 48 hours back), so the rows are
// written the way the workers store them, without the pipeline.
//
// What it writes, in the proportions the plan for operating the binary
// reasons from (a Claude Code install with sub-agents beside Python
// agents in production):
//
//   - Claude Code runs on six developer laptops (capture on for most),
//     a quarter to a third of them spawning sub-agents, now and then two
//     levels deep; each LLM call is a post_call and about 1.3 tool
//     calls, some of them MCP tools.
//   - Python-sensor runs of eighteen production and CI flavors (capture
//     on for under half), CrewAI, LangGraph and OpenAI Agents crews with
//     child runs, embeddings, MCP list/call/read events, policy events,
//     LLM errors with and without a terminal flag.
//   - One Claude Agent SDK flavor and one flavor reported over
//     OpenTelemetry.
//
// About 30 models of seven providers, 20 flavors, eleven hosts, the
// locked agent_type and client_type vocabularies. Runs start over the
// whole span with a density that grows linearly from 30% to 100%, so
// the last week holds about 3% of the events and the last 90 days about
// 35%. Claude Code runs keep to weekdays.
//
// Every value comes from the seed and the spec: the same spec writes
// the same rows, ids included, on both backends. Nothing reads the
// clock.

import (
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash"
	"hash/fnv"
	"math"
	"math/rand/v2"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// ScaleSpec describes the history SeedScale writes.
type ScaleSpec struct {
	// Events is how many events to write. Whole run trees are written,
	// so the count overshoots it by at most one tree.
	Events int
	// Seed decides every choice. The same Seed, Events, End and Span
	// write the same rows.
	Seed uint64
	// End is the newest moment of the history: the dashboard's "now".
	// No row is dated after it.
	End time.Time
	// Span is how far before End the history reaches; zero is a year.
	Span time.Duration
}

// ScaleStats is what SeedScale wrote, with the ids of the rows a test
// looks for.
type ScaleStats struct {
	Agents, Sessions, ChildSessions, ParentStubs int
	Events, Content, Attachments, Directives     int
	ContentBytes                                 int64
	MaxDepth                                     int
	EventsByType                                 map[string]int
	SessionsByState                              map[string]int
	Oldest, Newest                               time.Time
	// Digest is an FNV-64a hash over every session and event key in the
	// order they were written; two runs of one spec give one digest.
	Digest uint64

	// LargestSession is the run with the most events (a long Claude
	// Code session, for the run drawer).
	LargestSession string
	// LargestSessionEvents is how many events it has.
	LargestSessionEvents int
	// LongRunningActive is an active run started most of the span ago
	// whose last event is seconds before End (a production daemon).
	LongRunningActive string
	// OldParent is a closed run, last seen long ago, whose child
	// RecentChild started a day before End.
	OldParent, RecentChild string
	// ParentStub is a parent row with no identity (the workers' lazy
	// create for a child whose parent never started); StubChild is its
	// child.
	ParentStub, StubChild string
	// DeepRoot is the root of a tree three levels deep.
	DeepRoot string
	// LostSession, StaleSession and ClosedSession are runs in those
	// states.
	LostSession, StaleSession, ClosedSession string
	// DirectiveSession has directives addressed to it.
	DirectiveSession string
	// ContentEvent is an event with captured content.
	ContentEvent string
	// Agent is the agent with the most runs.
	Agent string
}

// scaleSpan is the default history length.
const scaleSpan = 365 * 24 * time.Hour

// scaleFlushEvents is how many events one transaction writes. Eight
// thousand events with their runs and content keep a transaction to a
// few tens of megabytes on both backends.
const scaleFlushEvents = 8000

// Rows per INSERT statement. SQLite binds at most 32,766 parameters and
// Postgres 65,535; these stay under both for the widest table.
const (
	scaleSessionBatch = 400
	scaleEventBatch   = 400
	scaleContentBatch = 200
)

type scaleModel struct {
	id, served, provider string
	billing              string // "" follows the family
}

// scaleModels are canonical ids as the workers store them, all but the
// last two priced by the vendored catalogue.
var scaleModels = []scaleModel{
	{"claude-opus-4-6", "claude-opus-4-6", "anthropic", ""},              // 0
	{"claude-sonnet-4-6", "claude-sonnet-4-6", "anthropic", ""},          // 1
	{"claude-opus-4-5", "claude-opus-4-5-20251101", "anthropic", ""},     // 2
	{"claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "anthropic", ""}, // 3
	{"claude-haiku-4-5", "claude-haiku-4-5-20251001", "anthropic", ""},   // 4
	{"claude-3-5-haiku", "claude-3-5-haiku-20241022", "anthropic", ""},   // 5
	{"gpt-5.1", "gpt-5.1-2025-11-13", "openai", ""},                      // 6
	{"gpt-5", "gpt-5-2025-08-07", "openai", ""},                          // 7
	{"gpt-5-mini", "gpt-5-mini-2025-08-07", "openai", ""},                // 8
	{"gpt-5-nano", "gpt-5-nano-2025-08-07", "openai", ""},                // 9
	{"gpt-4.1", "gpt-4.1-2025-04-14", "openai", ""},                      // 10
	{"gpt-4.1-mini", "gpt-4.1-mini-2025-04-14", "openai", ""},            // 11
	{"gpt-4o", "gpt-4o-2024-11-20", "openai", ""},                        // 12
	{"gpt-4o-mini", "gpt-4o-mini-2024-07-18", "openai", ""},              // 13
	{"o3", "o3-2025-04-16", "openai", ""},                                // 14
	{"o4-mini", "o4-mini-2025-04-16", "openai", ""},                      // 15
	{"o3-mini", "o3-mini-2025-01-31", "openai", ""},                      // 16
	{"text-embedding-3-small", "text-embedding-3-small", "openai", ""},   // 17
	{"text-embedding-3-large", "text-embedding-3-large", "openai", ""},   // 18
	{"gemini-2.5-pro", "gemini-2.5-pro", "google", ""},                   // 19
	{"gemini-2.5-flash", "gemini-2.5-flash", "google", ""},               // 20
	{"gemini-2.0-flash", "gemini-2.0-flash-001", "google", ""},           // 21
	{"grok-4", "grok-4-0709", "xai", ""},                                 // 22
	{"grok-3-mini", "grok-3-mini", "xai", ""},                            // 23
	{"mistral-large-latest", "mistral-large-2411", "mistral", ""},        // 24
	{"codestral-latest", "codestral-2501", "mistral", ""},                // 25
	{"deepseek-chat", "deepseek-chat", "deepseek", ""},                   // 26
	{"deepseek-reasoner", "deepseek-reasoner", "deepseek", ""},           // 27
	{"llama3.3:70b", "llama3.3:70b", "meta", "local"},                    // 28
	{"qwen2.5-coder:32b", "qwen2.5-coder:32b", "other", "local"},         // 29
}

type scaleHost struct {
	name, user, os, arch, orchestration string
}

var scaleHosts = []scaleHost{
	{"mbp-ada", "ada", "Darwin", "arm64", ""},                        // 0
	{"mbp-brian", "brian", "Darwin", "arm64", ""},                    // 1
	{"xps-chen", "chen", "Linux", "x86_64", ""},                      // 2
	{"mbp-dana", "dana", "Darwin", "arm64", ""},                      // 3
	{"thinkpad-eli", "eli", "Linux", "x86_64", ""},                   // 4
	{"mbp-fatima", "fatima", "Darwin", "arm64", ""},                  // 5
	{"prod-agents-1", "svc-agents", "Linux", "x86_64", "kubernetes"}, // 6
	{"prod-agents-2", "svc-agents", "Linux", "x86_64", "kubernetes"}, // 7
	{"prod-agents-3", "svc-agents", "Linux", "x86_64", "kubernetes"}, // 8
	{"batch-worker-1", "svc-batch", "Linux", "x86_64", "docker"},     // 9
	{"ci-runner-1", "ci", "Linux", "x86_64", "github_actions"},       // 10
}

// scaleFamily is one flavor's runs.
type scaleFamily struct {
	flavor, client, agentType string
	framework                 string // versioned frameworks entry; "" for none
	roles                     []string
	spawnP                    float64
	models                    []int
	share                     float64 // share of the events
	minCalls, maxCalls        int
	captureP                  float64
	hosts                     []int
	mcp, embeddings, policy   bool
	billing                   string
	stepMin, stepMax          time.Duration
	toolsPerCall              float64
	// tail makes a run left open end on a call 30 s before End (a
	// daemon that is working right now).
	tail bool
}

var scaleFamilies = []scaleFamily{
	{flavor: "claude-code", client: "claude_code", agentType: "coding", framework: "claude-code/2.1.32",
		roles: []string{"Explore", "general-purpose", "Plan", "code-reviewer"}, spawnP: 0.3,
		models: []int{3, 1, 0, 2, 4}, share: 0.45, minCalls: 8, maxCalls: 220, captureP: 0.9,
		hosts: []int{0, 1, 2, 3, 4, 5}, mcp: true, billing: "subscription",
		stepMin: 4 * time.Second, stepMax: 90 * time.Second, toolsPerCall: 1.3},
	{flavor: "repo-maintainer", client: "claude_agent_sdk", agentType: "coding", framework: "claude-agent-sdk/0.1.9",
		models: []int{3, 4}, share: 0.03, minCalls: 5, maxCalls: 60, captureP: 0.5, hosts: []int{10},
		billing: "metered", stepMin: 2 * time.Second, stepMax: 30 * time.Second, toolsPerCall: 1.0},
	{flavor: "travel-planner", client: "otlp", agentType: "production", framework: "pydantic_ai/1.0.10",
		models: []int{20, 19}, share: 0.03, minCalls: 2, maxCalls: 25, captureP: 0.3, hosts: []int{7},
		billing: "metered", stepMin: time.Second, stepMax: 8 * time.Second, toolsPerCall: 0.8},
	{flavor: "support-triage", client: "flightdeck_sensor", agentType: "production", framework: "langchain/0.3.27",
		models: []int{13, 8}, share: 0.07, minCalls: 2, maxCalls: 30, captureP: 0.45, hosts: []int{6, 7},
		mcp: true, policy: true, billing: "metered", stepMin: 500 * time.Millisecond, stepMax: 6 * time.Second, toolsPerCall: 0.7},
	{flavor: "research-crew", client: "flightdeck_sensor", agentType: "production", framework: "crewai/0.130.0",
		roles: []string{"researcher", "writer", "reviewer"}, spawnP: 0.85,
		models: []int{6, 8, 3}, share: 0.06, minCalls: 2, maxCalls: 18, captureP: 0.45, hosts: []int{8},
		policy: true, billing: "metered", stepMin: time.Second, stepMax: 12 * time.Second, toolsPerCall: 0.9},
	{flavor: "invoice-extractor", client: "flightdeck_sensor", agentType: "production",
		models: []int{12, 13}, share: 0.04, minCalls: 1, maxCalls: 6, captureP: 0.3, hosts: []int{9},
		billing: "metered", stepMin: 300 * time.Millisecond, stepMax: 3 * time.Second, toolsPerCall: 0.2},
	{flavor: "code-review-bot", client: "flightdeck_sensor", agentType: "coding", framework: "langgraph/0.6.7",
		roles: []string{"diff-reader", "commenter"}, spawnP: 0.4,
		models: []int{3, 2}, share: 0.03, minCalls: 3, maxCalls: 25, captureP: 0.6, hosts: []int{10},
		billing: "metered", stepMin: time.Second, stepMax: 10 * time.Second, toolsPerCall: 0.8},
	{flavor: "lead-enricher", client: "flightdeck_sensor", agentType: "production", framework: "litellm/1.77.0",
		models: []int{26, 13, 24}, share: 0.03, minCalls: 1, maxCalls: 12, captureP: 0.3, hosts: []int{6},
		policy: true, billing: "metered", stepMin: 500 * time.Millisecond, stepMax: 4 * time.Second, toolsPerCall: 0.4},
	{flavor: "doc-summarizer", client: "flightdeck_sensor", agentType: "production", framework: "llama_index/0.14.2",
		models: []int{20, 21}, share: 0.03, minCalls: 1, maxCalls: 10, captureP: 0.4, hosts: []int{9},
		billing: "metered", stepMin: 500 * time.Millisecond, stepMax: 5 * time.Second, toolsPerCall: 0.3},
	{flavor: "sql-assistant", client: "flightdeck_sensor", agentType: "production", framework: "langgraph/0.6.7",
		roles: []string{"planner", "executor"}, spawnP: 0.4,
		models: []int{10, 11}, share: 0.03, minCalls: 2, maxCalls: 20, captureP: 0.4, hosts: []int{7},
		mcp: true, billing: "metered", stepMin: 500 * time.Millisecond, stepMax: 6 * time.Second, toolsPerCall: 1.0},
	{flavor: "onboarding-guide", client: "flightdeck_sensor", agentType: "production", framework: "openai_agents/0.3.3",
		roles: []string{"triage", "billing-agent", "setup-agent"}, spawnP: 0.5,
		models: []int{6, 9}, share: 0.03, minCalls: 2, maxCalls: 14, captureP: 0.45, hosts: []int{8},
		billing: "metered", stepMin: 500 * time.Millisecond, stepMax: 5 * time.Second, toolsPerCall: 0.6},
	{flavor: "pricing-analyst", client: "flightdeck_sensor", agentType: "production", framework: "pydantic_ai/1.0.10",
		models: []int{14, 15}, share: 0.02, minCalls: 2, maxCalls: 12, captureP: 0.4, hosts: []int{6},
		billing: "metered", stepMin: time.Second, stepMax: 15 * time.Second, toolsPerCall: 0.5},
	{flavor: "incident-scribe", client: "flightdeck_sensor", agentType: "production",
		models: []int{4, 3}, share: 0.02, minCalls: 1, maxCalls: 8, captureP: 0.5, hosts: []int{6},
		billing: "metered", stepMin: time.Second, stepMax: 8 * time.Second, toolsPerCall: 0.3},
	{flavor: "release-notes", client: "flightdeck_sensor", agentType: "coding",
		models: []int{1, 4}, share: 0.01, minCalls: 1, maxCalls: 6, captureP: 0.6, hosts: []int{10},
		billing: "metered", stepMin: time.Second, stepMax: 10 * time.Second, toolsPerCall: 0.2},
	{flavor: "kb-indexer", client: "flightdeck_sensor", agentType: "production", framework: "llama_index/0.14.2",
		models: []int{17, 18}, share: 0.03, minCalls: 4, maxCalls: 40, captureP: 0.3, hosts: []int{9},
		embeddings: true, billing: "metered", stepMin: 100 * time.Millisecond, stepMax: time.Second},
	{flavor: "eval-harness", client: "flightdeck_sensor", agentType: "coding", framework: "litellm/1.77.0",
		models: []int{3, 6, 19, 22, 24, 26, 27, 7, 16, 28, 29}, share: 0.04, minCalls: 5, maxCalls: 40, captureP: 0.5,
		hosts: []int{10, 2}, billing: "metered", stepMin: 300 * time.Millisecond, stepMax: 4 * time.Second},
	{flavor: "ticket-router", client: "flightdeck_sensor", agentType: "production",
		models: []int{9, 23}, share: 0.02, minCalls: 1, maxCalls: 4, captureP: 0.3, hosts: []int{7},
		billing: "metered", stepMin: 200 * time.Millisecond, stepMax: 2 * time.Second, toolsPerCall: 0.3},
	{flavor: "contract-reader", client: "flightdeck_sensor", agentType: "production",
		models: []int{19, 20}, share: 0.02, minCalls: 2, maxCalls: 10, captureP: 0.4, hosts: []int{8},
		billing: "metered", stepMin: time.Second, stepMax: 10 * time.Second, toolsPerCall: 0.2},
	{flavor: "data-cleaner", client: "flightdeck_sensor", agentType: "production",
		models: []int{26, 25, 27}, share: 0.02, minCalls: 2, maxCalls: 15, captureP: 0.3, hosts: []int{9},
		billing: "metered", stepMin: 300 * time.Millisecond, stepMax: 3 * time.Second, toolsPerCall: 0.5},
	{flavor: "sales-coach", client: "flightdeck_sensor", agentType: "production", framework: "langchain/0.3.27",
		models: []int{22, 23, 5}, share: 0.01, minCalls: 2, maxCalls: 10, captureP: 0.4, hosts: []int{7},
		billing: "metered", stepMin: time.Second, stepMax: 8 * time.Second, toolsPerCall: 0.4},
}

// Tool names of the Claude Code runs; the last ones are MCP tools.
var (
	scaleCCTools  = []string{"Read", "Read", "Read", "Edit", "Edit", "Bash", "Bash", "Grep", "Glob", "Write", "TodoWrite", "WebFetch"}
	scaleMCPTools = []struct{ server, tool string }{
		{"github", "create_pull_request"}, {"github", "get_issue"}, {"github", "list_commits"},
		{"linear", "create_issue"}, {"linear", "search_issues"},
		{"postgres", "query"}, {"sentry", "get_issue_details"}, {"filesystem", "read_file"},
	}
	scaleSensorTools = []string{"search_kb", "lookup_customer", "create_ticket", "send_email", "run_sql", "fetch_url", "calculator", "get_weather"}
	scaleErrorTypes  = []string{"rate_limit", "rate_limit", "overloaded", "api_error", "timeout", "context_overflow", "invalid_request"}
)

// SeedScale writes the history spec describes into db, which must be
// migrated and hold no runs yet, and reports what it wrote.
func SeedScale(ctx context.Context, db *storage.DB, spec ScaleSpec) (*ScaleStats, error) {
	if spec.Events <= 0 {
		return nil, fmt.Errorf("storagetest: SeedScale needs Events > 0")
	}
	if spec.End.IsZero() {
		return nil, fmt.Errorf("storagetest: SeedScale needs End")
	}
	if spec.Span <= 0 {
		spec.Span = scaleSpan
	}
	g := &scaleGen{
		db:      db,
		spec:    spec,
		end:     spec.End.UTC().Truncate(time.Millisecond),
		r:       rand.New(rand.NewPCG(spec.Seed, spec.Seed^0x9e3779b97f4a7c15)),
		agents:  map[string]*scaleAgent{},
		digest:  fnv.New64a(),
		stats:   &ScaleStats{EventsByType: map[string]int{}, SessionsByState: map[string]int{}},
		runSize: map[string]int{},
	}
	g.start = g.end.Add(-spec.Span)
	g.paragraphs = scaleParagraphs(g.r)
	if err := g.prepare(ctx); err != nil {
		return nil, err
	}
	if err := g.run(ctx); err != nil {
		return nil, err
	}
	return g.stats, nil
}

type scaleAgent struct {
	id, name, agentType, client, user, host string
	first, last                             time.Time
	sessions                                int
	tokens                                  int64
}

type scaleSession struct {
	id, flavor, agentType, host, framework, model, state string
	started, lastSeen                                    time.Time
	ended                                                *time.Time
	tokens                                               int64
	context                                              any // JSON text or nil
	agent                                                *scaleAgent
	client, parent, role                                 string
	capture                                              *bool
	tokenID                                              any
	tokenName                                            any
}

type scaleGen struct {
	db         *storage.DB
	spec       ScaleSpec
	r          *rand.Rand
	start, end time.Time
	tokenID    string
	paragraphs []string
	digest     hash.Hash64
	stats      *ScaleStats
	agents     map[string]*scaleAgent
	runSize    map[string]int

	pendingAgents   []*scaleAgent
	pendingSessions []*scaleSession
	events          [][]any
	content         [][]any
	attachments     [][]any
	directives      [][]any
}

// prepare reads the development token (every run is attributed to it,
// as a loopback binary's are) and writes the token policies the policy
// events refer to.
func (g *scaleGen) prepare(ctx context.Context) error {
	if err := g.db.QueryRowContext(ctx,
		`SELECT CAST(id AS TEXT) FROM access_tokens WHERE prefix = 'tok_dev_'`).Scan(&g.tokenID); err != nil {
		return fmt.Errorf("storagetest: development token: %w", err)
	}
	_, err := g.db.ExecContext(ctx, `
		INSERT INTO token_policies (scope, scope_value, token_limit, warn_at_pct, degrade_at_pct, degrade_to, block_at_pct)
		VALUES ('org', '', 5000000, 80, NULL, NULL, NULL),
		       ('flavor', 'support-triage', 400000, 80, 90, 'gpt-5-nano', 100),
		       ('flavor', 'lead-enricher', 200000, 75, NULL, NULL, 100)`)
	if err != nil {
		return fmt.Errorf("storagetest: token policies: %w", err)
	}
	return nil
}

// run writes the random history, then the landmark runs, then the
// agents' rollups.
func (g *scaleGen) run(ctx context.Context) error {
	// A family's share is of the events, so a tree is picked with its
	// share over the events one of its trees writes on average.
	weights := make([]float64, len(scaleFamilies))
	for i := range scaleFamilies {
		weights[i] = scaleFamilies[i].share / scaleFamilies[i].treeEvents()
	}
	g.landmarks()
	for g.stats.Events < g.spec.Events {
		fam := &scaleFamilies[pickWeighted(g.r, weights)]
		t := g.sampleStart(fam)
		host := fam.hosts[g.r.IntN(len(fam.hosts))]
		calls := fam.minCalls + int(float64(fam.maxCalls-fam.minCalls)*math.Pow(g.r.Float64(), 2.2))
		g.tree(fam, host, t, calls, "")
		if len(g.events) >= scaleFlushEvents {
			if err := g.flush(ctx); err != nil {
				return err
			}
		}
	}
	if err := g.flush(ctx); err != nil {
		return err
	}
	g.stats.Digest = g.digest.Sum64()
	return g.rollups(ctx)
}

// treeEvents is about how many events one of the family's trees
// writes: the mean of the calls' skewed draw, a call and its tool
// calls each, and the children a spawning root adds.
func (f *scaleFamily) treeEvents() float64 {
	calls := float64(f.minCalls) + float64(f.maxCalls-f.minCalls)/3.2
	perCall := 1 + f.toolsPerCall
	children := 0.0
	if len(f.roles) > 0 {
		children = f.spawnP * 2 * (2 + float64(max(3, f.maxCalls/5))/2) * perCall
	}
	return calls*perCall + 2 + children
}

func (g *scaleGen) daemonEvents() int { return clampInt(g.spec.Events/100, 20, 2400) }
func (g *scaleGen) largestCalls() int { return clampInt(g.spec.Events/400, 20, 2500) }

// sampleStart picks a run's start: density growing linearly from 0.3 to
// 1 over the span (inverse CDF), Claude Code runs on weekdays.
func (g *scaleGen) sampleStart(fam *scaleFamily) time.Time {
	for {
		u := g.r.Float64()
		x := (-0.3 + math.Sqrt(0.09+4*0.35*0.65*u)) / 0.7
		t := g.start.Add(time.Duration(x * float64(g.spec.Span)))
		if fam.client == "claude_code" {
			wd := t.Weekday()
			if (wd == time.Saturday || wd == time.Sunday) && g.r.Float64() > 0.15 {
				continue
			}
		}
		return t.Truncate(time.Millisecond)
	}
}

// tree writes a root run and its sub-agents. role is "" for a root.
func (g *scaleGen) tree(fam *scaleFamily, host int, t time.Time, calls int, forceState string) *scaleSession {
	root, spawns := g.session(fam, host, "", "", t, calls, 0, forceState)
	g.children(fam, host, root, spawns, 1)
	return root
}

// children writes the sub-agent runs spawned at the given times, and
// their own children one level further down with a smaller chance.
func (g *scaleGen) children(fam *scaleFamily, host int, parent *scaleSession, spawns []time.Time, depth int) {
	for _, at := range spawns {
		role := fam.roles[g.r.IntN(len(fam.roles))]
		calls := 2 + g.r.IntN(max(3, fam.maxCalls/5))
		child, sub := g.session(fam, host, role, parent.id, at, calls, depth, "")
		if child.lastSeen.After(parent.lastSeen) && parent.state != "closed" {
			parent.lastSeen = child.lastSeen
		}
		if depth > g.stats.MaxDepth {
			g.stats.MaxDepth = depth
		}
		if depth < 3 {
			g.children(fam, host, child, sub, depth+1)
		}
	}
}

// agent returns the agent of a family, host and role, creating it.
func (g *scaleGen) agent(fam *scaleFamily, host int, role string) *scaleAgent {
	key := fam.flavor + "|" + scaleHosts[host].name + "|" + role
	if a, ok := g.agents[key]; ok {
		return a
	}
	h := scaleHosts[host]
	name := fam.flavor
	if fam.client == "claude_code" {
		name = h.user + "@" + h.name
	}
	if role != "" {
		name += ":" + role
	}
	a := &scaleAgent{id: g.uuid(), name: name, agentType: fam.agentType, client: fam.client, user: h.user, host: h.name}
	g.agents[key] = a
	g.pendingAgents = append(g.pendingAgents, a)
	return a
}

// session writes one run: its row and its events. It returns the run
// and the times at which it spawned sub-agents.
func (g *scaleGen) session(fam *scaleFamily, host int, role, parent string, t time.Time, calls, depth int, forceState string) (*scaleSession, []time.Time) {
	h := scaleHosts[host]
	ag := g.agent(fam, host, role)
	model := scaleModels[fam.models[g.r.IntN(len(fam.models))]]
	capture := g.r.Float64() < fam.captureP
	s := &scaleSession{
		id: g.uuid(), flavor: fam.flavor, agentType: fam.agentType, host: h.name,
		model: model.id, started: t, agent: ag, client: fam.client, parent: parent, role: role,
		capture: &capture, tokenID: g.tokenID, tokenName: "Development Token",
	}
	// The plugin's sessions leave the bare framework column empty; its
	// label is only in context.frameworks.
	if fam.framework != "" && fam.client != "claude_code" {
		s.framework = fam.framework[:strings.IndexByte(fam.framework, '/')]
	}
	s.context = g.contextJSON(fam, h)
	g.pendingSessions = append(g.pendingSessions, s)
	g.stats.Sessions++
	if parent != "" {
		g.stats.ChildSessions++
	}

	// The run's fate: most end normally; some crash and are reaped,
	// some are left lost or stale.
	fate := "normal"
	switch p := g.r.Float64(); {
	case forceState != "":
		fate = forceState
	case p < 0.03:
		fate = "reaped"
	case p < 0.04:
		fate = "lost"
	case p < 0.045:
		fate = "stale"
	}

	var spawns []time.Time
	nSpawn := 0
	if len(fam.roles) > 0 && depth < 3 && g.r.Float64() < fam.spawnP/float64(depth*3+1) {
		nSpawn = 1 + g.r.IntN(3)
	}
	spawnAt := map[int]bool{}
	for range nSpawn {
		spawnAt[g.r.IntN(calls)] = true
	}

	ev := &scaleRun{g: g, fam: fam, s: s, model: model, t: t}
	ev.emit("session_start", nil, func(p map[string]any) { p["sensor_version"] = "0.8.0" })
	if fam.mcp && fam.client != "claude_code" {
		ev.mcpList()
	}
	open := false
	for i := 0; i < calls; i++ {
		if !ev.step() {
			open = true
			break
		}
		ev.call(i)
		if spawnAt[i] {
			if fam.client == "claude_code" {
				ev.tool("Task", false)
			}
			spawns = append(spawns, ev.t)
		}
		if ev.blocked {
			break
		}
	}
	if !open && ev.step() {
		switch fate {
		case "normal":
			reason := "normal_exit"
			if ev.blocked {
				reason = "policy_block"
			} else if g.r.Float64() < 0.01 {
				reason = "directive_shutdown"
				g.directive(s, ev.t, true)
			}
			ev.end(reason)
			s.state = "closed"
		case "reaped":
			// The reaper's synthetic session_end, a day after the run
			// went silent; the run's last_seen_at stays at its last
			// real event. A run silent for less than a day is lost.
			reap := s.lastSeen.Add(24 * time.Hour)
			if reap.Before(g.end) {
				seen := s.lastSeen
				ev.t = reap
				ev.end("orphan_timeout")
				s.lastSeen = seen
				s.state = "closed"
			} else {
				s.state = "lost"
			}
		case "open":
			// Left running: the state follows from its last event.
		default:
			s.state = fate
		}
	}
	if fate == "open" && fam.tail && ev.t.Before(g.end.Add(-30*time.Second)) {
		ev.t = g.end.Add(-30 * time.Second)
		ev.call(calls)
	}
	if s.state == "" {
		// Still running at End.
		if g.end.Sub(s.lastSeen) <= 2*time.Minute {
			s.state = "active"
		} else {
			s.state = "idle"
		}
	}
	if s.state == "closed" && s.ended == nil {
		e := s.lastSeen
		s.ended = &e
	}
	if fam.client == "claude_code" && parent == "" && g.r.Float64() < 0.1 {
		for range 1 + g.r.IntN(3) {
			at := s.started.Add(time.Duration(g.r.Int64N(int64(s.lastSeen.Sub(s.started)) + 1))).Truncate(time.Millisecond)
			g.attachments = append(g.attachments, []any{g.uuid(), s.id, at})
			g.stats.Attachments++
		}
	}
	g.stats.SessionsByState[s.state]++
	ag.sessions++
	ag.tokens += s.tokens
	if ag.first.IsZero() || s.started.Before(ag.first) {
		ag.first = s.started
	}
	if s.lastSeen.After(ag.last) {
		ag.last = s.lastSeen
	}
	if n := g.runSize[s.id]; n > g.stats.LargestSessionEvents {
		g.stats.LargestSessionEvents, g.stats.LargestSession = n, s.id
	}
	switch s.state {
	case "lost":
		g.stats.LostSession = s.id
	case "stale":
		g.stats.StaleSession = s.id
	case "closed":
		if g.stats.ClosedSession == "" {
			g.stats.ClosedSession = s.id
		}
	}
	return s, spawns
}

// directive records a shutdown directive for a run, delivered and
// acknowledged when the run took it.
func (g *scaleGen) directive(s *scaleSession, at time.Time, delivered bool) {
	var deliveredAt, ackAt any
	if delivered {
		deliveredAt, ackAt = at.Add(-2*time.Second), at.Add(-time.Second)
	}
	g.directives = append(g.directives, []any{
		g.uuid(), s.id, nil, "shutdown", "stopped from the dashboard", at.Add(-3 * time.Second), deliveredAt, ackAt,
	})
	g.stats.Directives++
	g.stats.DirectiveSession = s.id
}

// contextJSON is the run's sessions.context as its client writes it.
func (g *scaleGen) contextJSON(fam *scaleFamily, h scaleHost) any {
	c := map[string]any{
		"hostname": h.name, "os": h.os, "arch": h.arch, "user": h.user,
		"supports_directives": true,
	}
	if fam.framework != "" {
		c["frameworks"] = []string{fam.framework}
	}
	switch fam.client {
	case "claude_code":
		c["git_repo"] = []string{"flightdeck", "billing-service", "web-app", "infra"}[g.r.IntN(4)]
		c["git_branch"] = []string{"main", "main", "feat/search", "fix/login-redirect", "chore/deps"}[g.r.IntN(5)]
		servers := []map[string]any{}
		for _, name := range []string{"github", "linear", "postgres", "sentry", "filesystem"}[:2+g.r.IntN(4)] {
			servers = append(servers, map[string]any{"name": name, "transport": "stdio"})
		}
		c["mcp_servers"] = servers
	case "otlp":
		c["telemetry"] = "otlp"
	default:
		c["python_version"] = []string{"3.12.7", "3.11.10", "3.13.1"}[g.r.IntN(3)]
		c["process_name"] = "python3"
		c["git_repo"] = "agents"
		c["git_branch"] = "main"
		if h.orchestration != "" {
			c["orchestration"] = h.orchestration
		}
		if fam.mcp {
			c["mcp_servers"] = []map[string]any{{"name": "kb-search", "transport": "streamable-http"}}
		}
	}
	b, _ := json.Marshal(c)
	return string(b)
}

// scaleRun writes the events of one run in order.
type scaleRun struct {
	g       *scaleGen
	fam     *scaleFamily
	s       *scaleSession
	model   scaleModel
	t       time.Time
	blocked bool
	warned  bool
}

// step advances the run's clock by one gap; false when that passes End
// (the run is still going).
func (r *scaleRun) step() bool {
	span := r.fam.stepMax - r.fam.stepMin
	next := r.t.Add(r.fam.stepMin + time.Duration(r.g.r.Int64N(int64(span)+1))).Truncate(time.Millisecond)
	if next.After(r.g.end) {
		return false
	}
	r.t = next
	return true
}

// emit appends one event; fill adds payload keys, cols overrides
// columns by name.
func (r *scaleRun) emit(eventType string, cols map[string]any, fill func(map[string]any)) string {
	g := r.g
	id := g.uuid()
	payload := map[string]any{}
	if fill != nil {
		fill(payload)
	}
	var payloadText any
	if len(payload) > 0 {
		b, _ := json.Marshal(payload)
		payloadText = string(b)
	}
	col := func(name string) any {
		if v, ok := cols[name]; ok {
			return v
		}
		return nil
	}
	hasContent := cols["has_content"] == true
	g.events = append(g.events, []any{
		id, r.s.id, r.s.flavor, eventType, col("model"),
		col("tokens_input"), col("tokens_output"), col("tokens_total"),
		orZero(col("tokens_cache_read")), orZero(col("tokens_cache_creation")), col("tokens_reasoning"),
		col("model_requested"), col("model_served"), col("provider"), col("billing_mode"), col("platform"),
		col("cost_reported"), col("cost_source"),
		col("latency_ms"), col("tool_name"), hasContent, r.t, payloadText,
	})
	_, _ = g.digest.Write([]byte(id + r.s.id + eventType + storage.FormatTime(r.t)))
	g.stats.Events++
	g.stats.EventsByType[eventType]++
	g.runSize[r.s.id]++
	if g.stats.Oldest.IsZero() || r.t.Before(g.stats.Oldest) {
		g.stats.Oldest = r.t
	}
	if r.t.After(g.stats.Newest) {
		g.stats.Newest = r.t
	}
	if r.t.After(r.s.lastSeen) {
		r.s.lastSeen = r.t
	}
	return id
}

func orZero(v any) any {
	if v == nil {
		return 0
	}
	return v
}

// llmCols are the columns of an LLM call on the run's model.
func (r *scaleRun) llmCols(m scaleModel, in, out, cacheRead, cacheWrite int, latency int) map[string]any {
	billing := r.fam.billing
	if m.billing != "" {
		billing = m.billing
	}
	cols := map[string]any{
		"model": m.id, "model_requested": m.served, "model_served": m.served, "provider": m.provider,
		"billing_mode": billing, "tokens_input": in, "tokens_output": out, "tokens_total": in + out,
		"tokens_cache_read": cacheRead, "tokens_cache_creation": cacheWrite, "latency_ms": latency,
	}
	if billing == "metered" {
		cols["platform"] = "direct"
	}
	if m.provider == "openai" && strings.HasPrefix(m.id, "o") || m.id == "deepseek-reasoner" {
		cols["tokens_reasoning"] = out / 3
	}
	if r.fam.flavor == "lead-enricher" && r.g.r.Float64() < 0.5 {
		cols["cost_reported"] = float64(in+out) * 0.0000004
		cols["cost_source"] = "provider"
	}
	return cols
}

// call writes one LLM call (post_call, or embeddings) and the tool calls
// that follow it, with the errors and policy events a run meets.
func (r *scaleRun) call(i int) {
	g := r.g
	m := r.model
	if len(r.fam.models) > 1 && g.r.Float64() < 0.05 {
		m = scaleModels[r.fam.models[g.r.IntN(len(r.fam.models))]]
	}
	if r.fam.embeddings {
		in := 200 + g.r.IntN(6000)
		cols := r.llmCols(m, in, 0, 0, 0, 40+g.r.IntN(400))
		cols["tokens_output"] = nil
		cols["tokens_total"] = in
		cols["has_content"] = *r.s.capture
		id := r.emit("embeddings", cols, nil)
		r.s.tokens += int64(in)
		if *r.s.capture {
			r.embeddingsContent(id, m)
		}
		return
	}
	if g.r.Float64() < 0.006 {
		r.llmError(m)
		if r.blocked {
			return
		}
	}
	var in, out, cacheRead, cacheWrite int
	if r.fam.client == "claude_code" {
		in = 3 + g.r.IntN(400)
		cacheRead = 8000 + i*900 + g.r.IntN(30000)
		cacheWrite = g.r.IntN(4000)
		out = 40 + int(3000*math.Pow(g.r.Float64(), 3))
	} else {
		in = 300 + i*350 + g.r.IntN(2500)
		out = 30 + g.r.IntN(900)
	}
	cols := r.llmCols(m, in, out, cacheRead, cacheWrite, 400+int(30000*math.Pow(g.r.Float64(), 2.5)))
	cols["has_content"] = *r.s.capture
	stop := "end_turn"
	if r.fam.toolsPerCall > 0 && g.r.Float64() < 0.7 {
		stop = "tool_use"
	}
	estimated := r.fam.client == "flightdeck_sensor" && g.r.Float64() < 0.1
	id := r.emit("post_call", cols, func(p map[string]any) {
		p["stop_reason"] = stop
		if g.r.Float64() < 0.6 {
			p["streaming"] = map[string]any{"ttft_ms": 200 + g.r.IntN(2500), "chunk_count": 5 + g.r.IntN(400)}
		}
		if estimated {
			p["estimated_via"] = []string{"tiktoken", "heuristic"}[g.r.IntN(2)]
		}
		if r.fam.client == "claude_code" {
			p["service_tier"] = "standard"
		}
	})
	r.s.tokens += int64(in + out)
	if *r.s.capture {
		r.callContent(id, m, i)
	}
	if r.fam.policy {
		r.policy(m)
	}
	// Tool calls: about toolsPerCall per call.
	n := 0
	for f := r.fam.toolsPerCall; f > 0; f-- {
		if g.r.Float64() < f {
			n++
		}
	}
	for range n {
		if !r.step() {
			return
		}
		if r.fam.mcp && g.r.Float64() < 0.12 {
			r.mcpCall()
			continue
		}
		if r.fam.client == "claude_code" {
			r.tool(scaleCCTools[g.r.IntN(len(scaleCCTools))], g.r.Float64() < 0.03)
		} else {
			r.tool(scaleSensorTools[g.r.IntN(len(scaleSensorTools))], g.r.Float64() < 0.02)
		}
	}
}

// tool writes a tool_call, failed when failed.
func (r *scaleRun) tool(name string, failed bool) {
	g := r.g
	dur := 20 + int(20000*math.Pow(g.r.Float64(), 4))
	cols := map[string]any{"tool_name": name}
	if r.fam.client == "claude_code" {
		cols["latency_ms"] = dur
	}
	r.emit("tool_call", cols, func(p map[string]any) {
		if r.fam.client == "claude_code" {
			p["tool_use_id"] = "toolu_" + strings.ReplaceAll(g.uuid(), "-", "")[:24]
			p["duration_ms"] = dur
		}
		if failed {
			p["error"] = map[string]any{"error_type": "other", "error_message": "command exited with status 1"}
		}
	})
}

// mcpCall writes an MCP tool call, and now and then the MCP policy
// event that preceded it.
func (r *scaleRun) mcpCall() {
	g := r.g
	srv := scaleMCPTools[g.r.IntN(len(scaleMCPTools))]
	if r.fam.client != "claude_code" {
		srv.server, srv.tool = "kb-search", []string{"search", "fetch_doc"}[g.r.IntN(2)]
	}
	if p := g.r.Float64(); p < 0.025 {
		eventType := "policy_mcp_warn"
		if p < 0.006 {
			eventType = "policy_mcp_block"
		}
		r.emit(eventType, map[string]any{"tool_name": srv.tool}, func(pl map[string]any) {
			pl["server_name"] = srv.server
			pl["server_url"] = "stdio://" + srv.server
			pl["fingerprint"] = fmt.Sprintf("%016x", g.r.Uint64())
			pl["originating_call_context"] = "call_tool"
			pl["policy_decision"] = map[string]any{
				"decision": strings.TrimPrefix(eventType, "policy_mcp_"), "scope": "global",
				"matched_entry_id": scaleEntryIDs[g.r.IntN(len(scaleEntryIDs))],
			}
		})
		if eventType == "policy_mcp_block" {
			return
		}
	}
	name := srv.tool
	if r.fam.client == "claude_code" {
		name = "mcp__" + srv.server + "__" + srv.tool
	}
	failed := g.r.Float64() < 0.04
	dur := 50 + g.r.IntN(3000)
	id := r.emit("mcp_tool_call", map[string]any{"tool_name": name, "latency_ms": dur, "has_content": *r.s.capture}, func(p map[string]any) {
		p["server_name"] = srv.server
		p["transport"] = "stdio"
		p["duration_ms"] = dur
		if r.fam.client == "claude_code" {
			p["mcp_server"] = map[string]any{"name": srv.server, "source": "project"}
			p["tool_use_id"] = "toolu_" + strings.ReplaceAll(g.uuid(), "-", "")[:24]
		}
		if failed {
			p["error"] = map[string]any{"error_type": "mcp_tool_error", "error_message": "tool returned an error"}
		}
	})
	if *r.s.capture {
		r.toolContent(id, srv.tool)
	}
}

// scaleEntryIDs are the MCP policy entries the policy events matched.
var scaleEntryIDs = []string{
	"3f1c2a9e-5b7d-4c11-9a0e-1d2b3c4d5e6f", "8a7b6c5d-4e3f-4a1b-8c9d-0e1f2a3b4c5d",
	"c0ffee00-1234-4abc-8def-0123456789ab", "deadbeef-0000-4111-8222-333344445555",
}

// mcpList writes a sensor run's MCP discovery at its start.
func (r *scaleRun) mcpList() {
	if !r.step() {
		return
	}
	r.emit("mcp_tool_list", nil, func(p map[string]any) {
		p["server_name"] = "kb-search"
		p["transport"] = "streamable-http"
		p["count"] = 2
		p["item_names"] = []string{"search", "fetch_doc"}
	})
}

// llmError writes a failed call; a terminal one blocks the run.
func (r *scaleRun) llmError(m scaleModel) {
	g := r.g
	terminal := g.r.Float64() < 0.2
	et := scaleErrorTypes[g.r.IntN(len(scaleErrorTypes))]
	cols := map[string]any{"model": m.id, "model_requested": m.served, "provider": m.provider, "latency_ms": 100 + g.r.IntN(5000)}
	r.emit("llm_error", cols, func(p map[string]any) {
		p["error"] = map[string]any{"error_type": et, "provider": m.provider, "http_status": 429, "error_message": et + " from provider"}
		if r.fam.client != "claude_code" {
			p["terminal"] = terminal
		}
		p["retry_attempt"] = 1 + g.r.IntN(3)
	})
	if terminal && r.fam.client != "claude_code" && g.r.Float64() < 0.3 {
		r.blocked = true
	}
	_ = r.step()
}

// policy writes the token policy events a run of a policed flavor
// meets: a warning, now and then a degrade or a block.
func (r *scaleRun) policy(m scaleModel) {
	g := r.g
	if r.warned {
		return
	}
	switch p := g.r.Float64(); {
	case p < 0.004:
		r.warned = true
		r.emit("policy_block", map[string]any{"model": m.id, "model_requested": m.served}, func(pl map[string]any) {
			pl["source"] = "server"
			pl["threshold_pct"] = 100
			pl["tokens_used"] = r.s.tokens
			pl["token_limit"] = 400000
			pl["policy_decision"] = map[string]any{"decision": "block", "scope": "flavor"}
		})
		r.blocked = true
	case p < 0.012:
		r.warned = true
		r.emit("policy_degrade", map[string]any{"model": m.id, "model_requested": m.served}, func(pl map[string]any) {
			pl["source"] = "server"
			pl["threshold_pct"] = 90
			pl["from_model"] = m.id
			pl["to_model"] = "gpt-5-nano"
			pl["policy_decision"] = map[string]any{"decision": "degrade", "scope": "flavor"}
		})
	case p < 0.05:
		r.warned = true
		r.emit("policy_warn", map[string]any{"model": m.id, "model_requested": m.served}, func(pl map[string]any) {
			pl["source"] = "server"
			pl["threshold_pct"] = 80
			pl["tokens_used"] = r.s.tokens
			pl["token_limit"] = 400000
			pl["policy_decision"] = map[string]any{"decision": "warn", "scope": "flavor"}
		})
	}
}

// end writes the run's session_end.
func (r *scaleRun) end(reason string) {
	r.emit("session_end", nil, func(p map[string]any) {
		p["close_reason"] = reason
		if r.fam.client == "claude_code" && reason == "normal_exit" {
			p["end_reason"] = []string{"prompt_input_exit", "clear", "logout", "other"}[r.g.r.IntN(4)]
		}
	})
	e := r.t
	r.s.ended = &e
}

// callContent writes the captured content of an LLM call: Claude Code
// stores one turn, the sensor every message sent so far.
func (r *scaleRun) callContent(eventID string, m scaleModel, i int) {
	g := r.g
	var messages []map[string]any
	var system, tools any
	if r.fam.client == "claude_code" {
		messages = []map[string]any{
			{"role": "user", "content": g.text(1 + g.r.IntN(3))},
			{"role": "assistant", "content": []map[string]any{
				{"type": "thinking", "thinking": g.text(1 + g.r.IntN(2))},
				{"type": "tool_use", "id": "toolu_x", "name": "Edit", "input": map[string]any{"file_path": "src/app.ts", "new_string": g.text(1 + g.r.IntN(5))}},
			}},
		}
	} else {
		system = "You are the " + r.fam.flavor + " agent. " + g.text(1)
		tools = []map[string]any{{"name": "search_kb", "description": "Search the knowledge base", "input_schema": map[string]any{"type": "object"}}}
		n := min(2+2*i, 24)
		for k := range n {
			role := "user"
			if k%2 == 1 {
				role = "assistant"
			}
			messages = append(messages, map[string]any{"role": role, "content": g.text(1)})
		}
	}
	response := map[string]any{"content": []map[string]any{{"type": "text", "text": g.text(1 + g.r.IntN(4))}}, "stop_reason": "end_turn"}
	r.addContent(eventID, m, system, messages, tools, response, nil, nil, nil)
}

func (r *scaleRun) toolContent(eventID, tool string) {
	g := r.g
	r.addContent(eventID, r.model, nil, []map[string]any{}, nil, map[string]any{}, nil,
		map[string]any{"name": tool, "arguments": map[string]any{"query": g.text(1)[:120]}},
		map[string]any{"content": []map[string]any{{"type": "text", "text": g.text(1 + g.r.IntN(3))}}})
}

func (r *scaleRun) embeddingsContent(eventID string, m scaleModel) {
	g := r.g
	input := []string{g.text(1), g.text(1)}
	r.addContent(eventID, m, nil, []map[string]any{}, nil, map[string]any{}, input, nil, nil)
	// The vectors themselves are cut to the marker, as the size limit
	// cuts them for any realistic batch.
	last := r.g.content[len(r.g.content)-1]
	last[11] = `"[embedding vectors cut: 2 x 1536 floats]"`
}

func (r *scaleRun) addContent(eventID string, m scaleModel, system any, messages any, tools any, response any, input any, toolInput any, toolOutput any) {
	g := r.g
	js := func(v any) any {
		if v == nil {
			return nil
		}
		b, _ := json.Marshal(v)
		return string(b)
	}
	row := []any{eventID, r.s.id, m.provider, m.id, system, js(messages), js(tools), js(response), js(input), js(toolInput), js(toolOutput), nil, r.t}
	for _, v := range row {
		if s, ok := v.(string); ok {
			g.stats.ContentBytes += int64(len(s))
		}
	}
	g.content = append(g.content, row)
	g.stats.Content++
	if g.stats.ContentEvent == "" {
		g.stats.ContentEvent = eventID
	}
}

// landmarks writes the runs a test can name: a production daemon
// active for most of the span, an old parent with a child from
// yesterday, a parent stub, a deep tree, the largest run, a lost and a
// stale run.
func (g *scaleGen) landmarks() {
	cc := &scaleFamilies[0]
	daemon := &scaleFamilies[3]

	// The daemon: events every few hours, the last one 30 s before End.
	n := g.daemonEvents()
	begin := g.end.Add(-time.Duration(float64(g.spec.Span) * 300 / 365))
	gap := g.end.Add(-30*time.Second).Sub(begin) / time.Duration(n)
	d, _ := g.session(&scaleFamily{
		flavor: daemon.flavor, client: daemon.client, agentType: daemon.agentType, framework: daemon.framework,
		models: daemon.models, billing: daemon.billing, captureP: 0, stepMin: gap / 2, stepMax: gap, tail: true,
	}, 6, "", "", begin, n-1, 0, "open")
	g.stats.LongRunningActive = d.id

	// An old closed parent and a child that started a day before End.
	old, _ := g.session(cc, 1, "", "", g.end.Add(-120*24*time.Hour), 30, 0, "normal")
	g.stats.OldParent = old.id
	child, _ := g.session(cc, 1, "Explore", old.id, g.end.Add(-24*time.Hour), 8, 1, "normal")
	g.stats.RecentChild = child.id

	// A parent stub: the child's parent never started.
	stub := &scaleSession{
		id: g.uuid(), flavor: "unknown", agentType: "unknown", state: "active",
		started: g.end.Add(-200 * 24 * time.Hour), tokenID: nil, tokenName: nil,
	}
	stub.lastSeen = stub.started
	g.pendingSessions = append(g.pendingSessions, stub)
	g.stats.Sessions++
	g.stats.ParentStubs++
	g.stats.SessionsByState["active"]++
	g.stats.ParentStub = stub.id
	crew := &scaleFamilies[4]
	sc, _ := g.session(crew, 8, "researcher", stub.id, stub.started.Add(time.Second), 5, 1, "normal")
	g.stats.StubChild = sc.id

	// A tree three levels deep, ten days back.
	root, _ := g.session(cc, 0, "", "", g.end.Add(-10*24*time.Hour), 20, 0, "normal")
	parent := root
	for depth := 1; depth <= 3; depth++ {
		c, _ := g.session(cc, 0, cc.roles[depth%len(cc.roles)], parent.id, parent.started.Add(time.Duration(depth)*time.Minute), 4, depth, "normal")
		parent = c
	}
	g.stats.MaxDepth = max(g.stats.MaxDepth, 3)
	g.stats.DeepRoot = root.id

	// The largest run, twenty days back.
	big := &scaleFamily{}
	*big = *cc
	big.roles = nil
	g.session(big, 2, "", "", g.end.Add(-20*24*time.Hour), g.largestCalls(), 0, "normal")

	// A lost and a stale run, and directives for one closed run.
	g.session(cc, 3, "", "", g.end.Add(-60*24*time.Hour), 10, 0, "lost")
	stale, _ := g.session(daemon, 7, "", "", g.end.Add(-3*time.Hour), 6, 0, "stale")
	g.directive(stale, stale.lastSeen, false)
	g.directives = append(g.directives, []any{g.uuid(), nil, daemon.flavor, "shutdown", "flavor stop", g.end.Add(-30 * 24 * time.Hour), g.end.Add(-30 * 24 * time.Hour), nil})
	g.stats.Directives++
}

// flush writes everything buffered in one transaction: agents, runs,
// events, content, attachments, directives, in foreign-key order.
func (g *scaleGen) flush(ctx context.Context) error {
	tx, err := g.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("storagetest: seed begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var agents [][]any
	for _, a := range g.pendingAgents {
		agents = append(agents, []any{a.id, a.agentType, a.client, a.name, a.user, a.host, g.start, g.start})
	}
	var sessions [][]any
	for _, s := range g.pendingSessions {
		var agentID, client, agentName, parent, role, capture, host, framework, model any
		if s.agent != nil {
			agentID, client, agentName = s.agent.id, s.client, s.agent.name
		}
		if s.parent != "" {
			parent = s.parent
		}
		if s.role != "" {
			role = s.role
		}
		if s.capture != nil {
			capture = *s.capture
		}
		if s.host != "" {
			host = s.host
		}
		if s.framework != "" {
			framework = s.framework
		}
		if s.model != "" {
			model = s.model
		}
		var ended any
		if s.ended != nil {
			ended = *s.ended
		}
		_, _ = g.digest.Write([]byte(s.id + s.state + storage.FormatTime(s.started)))
		sessions = append(sessions, []any{
			s.id, s.flavor, s.agentType, host, framework, model, s.state, s.started, s.lastSeen, ended,
			s.tokens, s.context, s.tokenID, s.tokenName, agentID, client, agentName, parent, role, capture,
		})
	}
	steps := []struct {
		table, cols string
		rows        [][]any
		batch       int
	}{
		{"agents", "agent_id, agent_type, client_type, agent_name, user_name, hostname, first_seen_at, last_seen_at", agents, scaleSessionBatch},
		{"sessions", "session_id, flavor, agent_type, host, framework, model, state, started_at, last_seen_at, ended_at, " +
			"tokens_used, context, token_id, token_name, agent_id, client_type, agent_name, parent_session_id, agent_role, capture_prompts",
			sessions, scaleSessionBatch},
		{"events", "id, session_id, flavor, event_type, model, tokens_input, tokens_output, tokens_total, " +
			"tokens_cache_read, tokens_cache_creation, tokens_reasoning, model_requested, model_served, provider, billing_mode, platform, " +
			"cost_reported, cost_source, latency_ms, tool_name, has_content, occurred_at, payload", g.events, scaleEventBatch},
		{"event_content", "event_id, session_id, provider, model, system_prompt, messages, tools, response, input, tool_input, tool_output, embedding_output, captured_at",
			g.content, scaleContentBatch},
		{"session_attachments", "id, session_id, attached_at", g.attachments, scaleSessionBatch},
		{"directives", "id, session_id, flavor, action, reason, issued_at, delivered_at, acknowledged_at", g.directives, scaleSessionBatch},
	}
	for _, st := range steps {
		if err := insertRows(ctx, tx, st.table, st.cols, st.rows, st.batch); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("storagetest: seed commit: %w", err)
	}
	g.stats.Agents += len(g.pendingAgents)
	g.pendingAgents, g.pendingSessions = nil, nil
	g.events, g.content, g.attachments, g.directives = nil, nil, nil, nil
	return nil
}

// insertRows writes rows with multi-row INSERT statements of at most
// batch rows each.
func insertRows(ctx context.Context, tx *sql.Tx, table, cols string, rows [][]any, batch int) error {
	for len(rows) > 0 {
		n := min(batch, len(rows))
		chunk := rows[:n]
		rows = rows[n:]
		width := len(chunk[0])
		var b strings.Builder
		b.WriteString("INSERT INTO " + table + " (" + cols + ") VALUES ")
		args := make([]any, 0, n*width)
		for i, row := range chunk {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteByte('(')
			for j := range row {
				if j > 0 {
					b.WriteByte(',')
				}
				fmt.Fprintf(&b, "$%d", len(args)+j+1)
			}
			b.WriteByte(')')
			args = append(args, row...)
		}
		if _, err := tx.ExecContext(ctx, b.String(), args...); err != nil {
			return fmt.Errorf("storagetest: seed %s: %w", table, err)
		}
	}
	return nil
}

// rollups sets each agent's totals and first and last seen from its
// runs, as the workers maintain them.
func (g *scaleGen) rollups(ctx context.Context) error {
	tx, err := g.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("storagetest: seed rollups: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	most := 0
	for _, a := range g.agents {
		if _, err := tx.ExecContext(ctx, `UPDATE agents SET total_sessions = $1, total_tokens = $2,
			first_seen_at = $3, last_seen_at = $4 WHERE agent_id = $5`,
			a.sessions, a.tokens, a.first, a.last, a.id); err != nil {
			return fmt.Errorf("storagetest: seed rollup %s: %w", a.id, err)
		}
		if a.sessions > most || (a.sessions == most && a.id < g.stats.Agent) {
			most, g.stats.Agent = a.sessions, a.id
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("storagetest: seed rollups commit: %w", err)
	}
	return nil
}

// uuid is a random version-4 UUID from the seeded generator.
func (g *scaleGen) uuid() string {
	var b [16]byte
	binary.LittleEndian.PutUint64(b[:8], g.r.Uint64())
	binary.LittleEndian.PutUint64(b[8:], g.r.Uint64())
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// text is n paragraphs of the generator's pool, about 450 bytes each.
func (g *scaleGen) text(n int) string {
	parts := make([]string, n)
	for i := range parts {
		parts[i] = g.paragraphs[g.r.IntN(len(g.paragraphs))]
	}
	return strings.Join(parts, "\n\n")
}

// scaleParagraphs builds the pool content is drawn from: prose-shaped
// text, so its size and compressibility are those of real prompts.
func scaleParagraphs(r *rand.Rand) []string {
	words := strings.Fields(`the a to of and in is that for it on with as this be are from by at or
		function return error request response user session agent model token tool file test value
		config server client query result update create delete check build deploy branch commit review
		please can you we should will could would need make sure into when then also only each which
		database index table column migration handler store event content message system prompt cache`)
	out := make([]string, 256)
	for i := range out {
		var b strings.Builder
		for b.Len() < 450 {
			if b.Len() > 0 {
				b.WriteByte(' ')
			}
			b.WriteString(words[r.IntN(len(words))])
		}
		b.WriteByte('.')
		out[i] = b.String()
	}
	return out
}

func pickWeighted(r *rand.Rand, weights []float64) int {
	total := 0.0
	for _, w := range weights {
		total += w
	}
	x := r.Float64() * total
	for i, w := range weights {
		if x < w {
			return i
		}
		x -= w
	}
	return len(weights) - 1
}

func clampInt(v, lo, hi int) int { return min(max(v, lo), hi) }
