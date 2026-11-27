//go:build scale

package store_test

// The scale check: every request the dashboard's pages send, timed
// through the real handlers on a seeded history of 100,000 and of
// 1,000,000 events, on SQLite and on Postgres, against a budget.
//
// It is outside the normal test run (build tag scale) because the
// fixtures take minutes to write and gigabytes to keep. Run it with
// `make test-scale` (CONTRIBUTING.md, "The scale check"):
//
//	SCALE_DIR           directory for the SQLite fixtures, their
//	                    manifests and the results (required)
//	SCALE_POSTGRES_URL  a Postgres database the role can create
//	                    databases from; without it only SQLite runs
//	SCALE_SIZES         sizes to run, default "100k,1m"
//	SCALE_BACKENDS      backends to run, default both ("sqlite", "postgres")
//	SCALE_LABEL         name of this run in the results files
//	SCALE_RESEED=1      write the fixtures again
//
// Each size's fixture is seeded once (storagetest.SeedScale, with the
// seeding time as its "now") and kept pristine; every run copies it,
// applies this checkout's migrations to the copy (timed: an index built
// on upgrade shows here), opens it as the binary does and times each
// request once cold (the first request on fresh connections) and three
// more times; warm is the median of those three. A warm time over the
// budget fails the test unless the request is in knownOverBudget, which
// fails it only past its ceiling or back within its budget; on SQLite
// the plan of every statement of a failing request is printed (on
// Postgres, run the server with auto_explain, as CONTRIBUTING.md
// documents, for EXPLAIN (ANALYZE, BUFFERS) of every slow statement).
// Postgres is opened with the binary's connection parameters
// (binaryPostgresURL).

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	apiapp "github.com/flightdeckhq/flightdeck/api/app"
	"github.com/flightdeckhq/flightdeck/api/internal/server"
	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// Budgets, per request, measured warm. A page that sends several
// requests at once waits for the slowest, so each one gets the whole
// budget. Half a second at 100,000 events is a page that settles
// without a visible wait on a busy laptop install (two months of heavy
// Claude Code use); a second and a half at 1,000,000 events is still
// well inside a dashboard's patience and twenty times inside the API's
// 30-second request timeout, for a year of a busy install or weeks of
// a production agent.
const (
	budget100k = 500 * time.Millisecond
	budget1M   = 1500 * time.Millisecond
)

// warmRuns is how many runs after the first the warm median is taken
// over: three keeps one slow outlier from deciding it.
const warmRuns = 3

// scaleSeed is the seed of every fixture.
const scaleSeed = 20261127

type scaleSize struct {
	name   string
	events int
	budget time.Duration
}

var allSizes = []scaleSize{
	{"100k", 100_000, budget100k},
	{"1m", 1_000_000, budget1M},
}

// manifest is what a fixture was seeded with; it sits beside the
// SQLite file (and names the Postgres database's fixture).
type manifest struct {
	Spec        storagetest.ScaleSpec  `json:"spec"`
	Stats       storagetest.ScaleStats `json:"stats"`
	SeedSeconds float64                `json:"seed_seconds"`
	FileBytes   int64                  `json:"file_bytes,omitempty"`
}

// result is one request's timings.
type result struct {
	Backend, Size, Name, Page, Path string
	Status                          int
	ColdMS, WarmMS, BudgetMS        float64
	Bytes                           int
}

func scaleSizes(t *testing.T) []scaleSize {
	want := os.Getenv("SCALE_SIZES")
	if want == "" {
		return allSizes
	}
	var out []scaleSize
	for _, name := range strings.Split(want, ",") {
		found := false
		for _, s := range allSizes {
			if s.name == strings.TrimSpace(name) {
				out = append(out, s)
				found = true
			}
		}
		if !found {
			t.Fatalf("SCALE_SIZES: unknown size %q", name)
		}
	}
	return out
}

func scaleDir(t *testing.T) string {
	dir := os.Getenv("SCALE_DIR")
	if dir == "" {
		t.Skip("SCALE_DIR not set; the scale check needs a directory for its fixtures")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

// TestScale is the scale check.
func TestScale(t *testing.T) {
	dir := scaleDir(t)
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	store.LoadPricing()
	label := os.Getenv("SCALE_LABEL")
	if label == "" {
		label = "run"
	}
	var backends []storage.Backend
	only := os.Getenv("SCALE_BACKENDS")
	if only == "" || strings.Contains(only, "sqlite") {
		backends = append(backends, storage.SQLite)
	}
	if os.Getenv("SCALE_POSTGRES_URL") != "" && (only == "" || strings.Contains(only, "postgres")) {
		backends = append(backends, storage.Postgres)
	}
	var all []result
	for _, b := range backends {
		for _, size := range scaleSizes(t) {
			t.Run(string(b)+"/"+size.name, func(t *testing.T) {
				res := runScale(t, dir, b, size)
				all = append(all, res...)
				writeResults(t, filepath.Join(dir, fmt.Sprintf("results-%s-%s-%s.json", label, b, size.name)), res)
			})
		}
	}
	printTable(all)
}

func runScale(t *testing.T, dir string, b storage.Backend, size scaleSize) []result {
	ctx := context.Background()
	man, workURL := workingCopy(t, dir, b, size)

	start := time.Now()
	if err := storage.Migrate(ctx, workURL); err != nil {
		t.Fatalf("migrate the working copy: %v", err)
	}
	t.Logf("%s %s: migrations on the working copy took %v", b, size.name, time.Since(start).Round(time.Millisecond))

	start = time.Now()
	db, err := storage.Open(ctx, workURL)
	if err != nil {
		t.Fatalf("open the working copy: %v", err)
	}
	defer func() { _ = db.Close() }()
	t.Logf("%s %s: open took %v", b, size.name, time.Since(start).Round(time.Millisecond))
	// As the binary does after migrating, before it serves.
	took, err := db.GatherStatistics(ctx)
	if err != nil {
		t.Fatalf("planner statistics: %v", err)
	}
	t.Logf("%s %s: gathering the planner statistics took %v", b, size.name, took.Round(time.Millisecond))
	if err := store.SyncPricingTable(ctx, db); err != nil {
		t.Fatalf("pricing: %v", err)
	}
	st := store.New(db, storage.NewBus(db))
	handler := server.NewForTesting("", st, nil, "", nil).Handler

	var out []result
	measured := map[string]bool{}
	for _, c := range dashboardRequests(man) {
		r := result{Backend: string(b), Size: size.name, Name: c.name, Page: c.page, Path: c.path,
			BudgetMS: ms(size.budget)}
		var warm []time.Duration
		for run := 0; run <= warmRuns; run++ {
			d, status, n := serve(handler, c.path)
			r.Status, r.Bytes = status, n
			if run == 0 {
				r.ColdMS = ms(d)
			} else {
				warm = append(warm, d)
			}
		}
		sort.Slice(warm, func(i, j int) bool { return warm[i] < warm[j] })
		r.WarmMS = ms(warm[len(warm)/2])
		if r.Status != http.StatusOK {
			t.Errorf("%s: %s answered %d", c.name, c.path, r.Status)
		}
		measured[c.name] = true
		known := knownSlowFor(b, size.name, c.name)
		explain := func() {
			if b == storage.SQLite {
				explainSQLite(t, db, handler, c.path)
			}
		}
		switch {
		case known != nil && r.WarmMS > ms(known.ceiling):
			t.Errorf("%s %s %s: warm %.0f ms, past its known ceiling of %v (#347: %s) (%s)",
				b, size.name, c.name, r.WarmMS, known.ceiling, known.reason, c.path)
			explain()
		case known != nil && r.WarmMS <= r.BudgetMS && !known.atTheLine:
			t.Errorf("%s %s %s: warm %.0f ms, within its %.0f ms budget again: take it off knownOverBudget",
				b, size.name, c.name, r.WarmMS, r.BudgetMS)
		case known != nil:
			t.Logf("%s %s %s: warm %.0f ms against a %.0f ms budget, known (#347: %s)",
				b, size.name, c.name, r.WarmMS, r.BudgetMS, known.reason)
		case r.WarmMS > r.BudgetMS:
			t.Errorf("%s %s %s: warm %.0f ms over the %.0f ms budget (%s)", b, size.name, c.name, r.WarmMS, r.BudgetMS, c.path)
			explain()
		}
		out = append(out, r)
	}
	for _, k := range knownOverBudget {
		if k.backend == b && k.size == size.name && !measured[k.name] {
			t.Errorf("knownOverBudget lists %s %s %q, which the check no longer times: rename or remove it", b, size.name, k.name)
		}
	}
	return out
}

// knownSlow is a request over its budget today. The check logs it, and
// fails when it passes its ceiling (a regression), and, unless it sits
// at the line, when it comes back within its budget (the list is then
// stale). A request not listed fails as soon as it is over its budget.
// The work that would bring them within their budgets is on the
// roadmap issue #347.
type knownSlow struct {
	backend storage.Backend
	size    string
	name    string
	// ceiling is the warm time past which the request has regressed:
	// about half again its measured time, which run-to-run noise on a
	// busy machine stays inside.
	ceiling time.Duration
	// atTheLine marks a request measured on both sides of its budget
	// in repeated runs: within it is no news, past the ceiling is.
	atTheLine bool
	reason    string
}

// knownOverBudget is every request over its budget on this checkout,
// measured by repeated runs of the check.
var knownOverBudget = []knownSlow{
	{storage.SQLite, "1m", "events 30d facets", 4500 * time.Millisecond, false,
		"about 20 grouped scans of the window, one per facet (3.05-3.08 s)"},
	{storage.SQLite, "1m", "estimated_cost by flavor 90d", 4500 * time.Millisecond, false,
		"each metered call looks up its price row (2.87-3.16 s)"},
	{storage.SQLite, "1m", "estimated_cost by model,provider 90d", 5 * time.Second, false,
		"each metered call looks up its price row (3.02-3.37 s)"},
	{storage.SQLite, "1m", "tokens by framework 90d", 2700 * time.Millisecond, false,
		"every event joins its run and unnests context.frameworks (1.76-1.78 s)"},
	{storage.SQLite, "1m", "fleet", 2200 * time.Millisecond, true,
		"the context facets count every run's context (1.42-1.49 s here, 1.52 s seen under contention)"},
	{storage.Postgres, "1m", "estimated_cost by flavor 90d", 3600 * time.Millisecond, false,
		"each metered call looks up its price row (2.34-2.47 s)"},
	{storage.Postgres, "1m", "estimated_cost by model,provider 90d", 3800 * time.Millisecond, false,
		"each metered call looks up its price row (2.49-2.53 s)"},
	{storage.Postgres, "1m", "fleet", 2200 * time.Millisecond, true,
		"the context facets count every run's context (1.40-1.43 s, within 7% of the budget)"},
}

func knownSlowFor(b storage.Backend, size, name string) *knownSlow {
	for i := range knownOverBudget {
		k := &knownOverBudget[i]
		if k.backend == b && k.size == size && k.name == name {
			return k
		}
	}
	return nil
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

// serve runs one request through the handler.
func serve(h http.Handler, path string) (time.Duration, int, int) {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	start := time.Now()
	h.ServeHTTP(rec, req)
	return time.Since(start), rec.Code, rec.Body.Len()
}

// explainSQLite prints the plan and the time of every statement the
// request runs.
func explainSQLite(t *testing.T, db *storage.DB, h http.Handler, path string) {
	type stmt struct {
		query string
		args  []any
	}
	var mu sync.Mutex
	var stmts []stmt
	storage.SetQueryTrace(func(q string, args []any) {
		if strings.HasPrefix(strings.TrimSpace(q), "EXPLAIN") {
			return
		}
		mu.Lock()
		stmts = append(stmts, stmt{q, args})
		mu.Unlock()
	})
	serve(h, path)
	storage.SetQueryTrace(nil)
	for i, s := range stmts {
		start := time.Now()
		n := 0
		if rows, err := db.Reader().Query(s.query, s.args...); err == nil {
			for rows.Next() {
				n++
			}
			_ = rows.Close()
		}
		took := time.Since(start)
		var plan strings.Builder
		rows, err := db.Reader().Query("EXPLAIN QUERY PLAN "+s.query, s.args...)
		if err != nil {
			t.Logf("explain: %v", err)
			continue
		}
		for rows.Next() {
			var id, parent, notused int
			var detail string
			if err := rows.Scan(&id, &parent, &notused, &detail); err == nil {
				fmt.Fprintf(&plan, "\n      %d<-%d %s", id, parent, detail)
			}
		}
		_ = rows.Close()
		t.Logf("  statement %d: %v, %d rows\n    %s\n    args %v\n    plan:%s", i+1, took.Round(time.Millisecond), n,
			oneLine(s.query), s.args, plan.String())
	}
}

func oneLine(q string) string { return strings.Join(strings.Fields(q), " ") }

// workingCopy returns the fixture's manifest and the URL of a fresh copy
// of it, seeding the fixture first when it does not exist.
func workingCopy(t *testing.T, dir string, b storage.Backend, size scaleSize) (manifest, string) {
	ctx := context.Background()
	manPath := filepath.Join(dir, fmt.Sprintf("scale-%s-%s.json", size.name, b))
	reseed := os.Getenv("SCALE_RESEED") == "1"
	var man manifest
	if raw, err := os.ReadFile(manPath); err == nil && !reseed {
		if err := json.Unmarshal(raw, &man); err != nil {
			t.Fatalf("%s: %v", manPath, err)
		}
	} else {
		man = seedFixture(t, dir, b, size, manPath)
	}
	switch b {
	case storage.SQLite:
		pristine := filepath.Join(dir, "scale-"+size.name+".db")
		work := filepath.Join(dir, "work-"+size.name+".db")
		for _, suffix := range []string{"", "-wal", "-shm", ".migrate.lock"} {
			_ = os.Remove(work + suffix)
		}
		start := time.Now()
		if err := copyFile(pristine, work); err != nil {
			t.Fatalf("copy %s: %v", pristine, err)
		}
		t.Logf("sqlite %s: working copy in %v", size.name, time.Since(start).Round(time.Millisecond))
		return man, storage.SQLiteURL(work)
	default:
		admin := openPostgresAdmin(t)
		defer func() { _ = admin.Close() }()
		work := "fd_work_" + size.name
		if _, err := admin.ExecContext(ctx, `DROP DATABASE IF EXISTS `+work+` WITH (FORCE)`); err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		if _, err := admin.ExecContext(ctx, `CREATE DATABASE `+work+` TEMPLATE fd_scale_`+size.name); err != nil {
			t.Fatal(err)
		}
		t.Logf("postgres %s: working copy in %v", size.name, time.Since(start).Round(time.Millisecond))
		u := postgresURLFor(t, work)
		// A fresh copy has no planner statistics until autovacuum
		// reaches it; the database it was copied from was analyzed
		// once seeded, so the copy is too, as a live database is.
		db, err := storage.Open(ctx, u)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = db.Close() }()
		if _, err := db.ExecContext(ctx, `ANALYZE`); err != nil {
			t.Fatal(err)
		}
		return man, binaryPostgresURL(t, u)
	}
}

// copyFile copies a closed SQLite file to dst.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// workersLockTimeoutMillis is the workers' writer.LockTimeout, which
// the api module cannot import from the workers module.
const workersLockTimeoutMillis = 8000

// binaryPostgresURL is u with the connection parameters the flightdeck
// binary gives every pool of its process (cmd/flightdeck connectionURL):
// the query API's jit=off and the workers' lock timeout. The check
// times Postgres as the binary connects to it: through a plain
// storage.Open the server's defaults apply, and Postgres JIT-compiles
// the dashboard's queries, which the binary never has it do.
func binaryPostgresURL(t *testing.T, u string) string {
	parsed, err := url.Parse(u)
	if err != nil {
		t.Fatal("the Postgres URL does not parse")
	}
	q := parsed.Query()
	if q.Get("lock_timeout") == "" {
		q.Set("lock_timeout", strconv.Itoa(workersLockTimeoutMillis))
	}
	parsed.RawQuery = q.Encode()
	return apiapp.DatabaseURL(parsed.String())
}

// seedFixture writes a size's pristine fixture and its manifest.
func seedFixture(t *testing.T, dir string, b storage.Backend, size scaleSize, manPath string) manifest {
	ctx := context.Background()
	spec := storagetest.ScaleSpec{Events: size.events, Seed: scaleSeed, End: time.Now().UTC().Truncate(time.Minute)}
	var u string
	var file string
	switch b {
	case storage.SQLite:
		file = filepath.Join(dir, "scale-"+size.name+".db")
		for _, suffix := range []string{"", "-wal", "-shm", ".migrate.lock"} {
			_ = os.Remove(file + suffix)
		}
		u = storage.SQLiteURL(file)
	default:
		admin := openPostgresAdmin(t)
		name := "fd_scale_" + size.name
		if _, err := admin.ExecContext(ctx, `DROP DATABASE IF EXISTS `+name+` WITH (FORCE)`); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.ExecContext(ctx, `CREATE DATABASE `+name); err != nil {
			t.Fatal(err)
		}
		_ = admin.Close()
		u = postgresURLFor(t, name)
	}
	if err := storage.Migrate(ctx, u); err != nil {
		t.Fatalf("migrate the fixture: %v", err)
	}
	db, err := storage.Open(ctx, u)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	stats, err := storagetest.SeedScale(ctx, db, spec)
	if err != nil {
		t.Fatalf("seed %s %s: %v", b, size.name, err)
	}
	man := manifest{Spec: spec, Stats: *stats, SeedSeconds: time.Since(start).Seconds()}
	if b == storage.Postgres {
		if _, err := db.ExecContext(ctx, `VACUUM ANALYZE`); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if file != "" {
		if fi, err := os.Stat(file); err == nil {
			man.FileBytes = fi.Size()
		}
	}
	raw, _ := json.MarshalIndent(man, "", "  ")
	if err := os.WriteFile(manPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("%s %s: seeded %d events, %d runs, %d content rows in %.0f s", b, size.name,
		stats.Events, stats.Sessions, stats.Content, man.SeedSeconds)
	return man
}

func openPostgresAdmin(t *testing.T) *storage.DB {
	db, err := storage.Open(context.Background(), os.Getenv("SCALE_POSTGRES_URL"))
	if err != nil {
		t.Fatalf("SCALE_POSTGRES_URL: %v", err)
	}
	return db
}

// postgresURLFor is SCALE_POSTGRES_URL with another database name.
func postgresURLFor(t *testing.T, name string) string {
	u, err := url.Parse(os.Getenv("SCALE_POSTGRES_URL"))
	if err != nil {
		t.Fatal("SCALE_POSTGRES_URL does not parse")
	}
	u.Path = "/" + name
	return u.String()
}

func writeResults(t *testing.T, path string, res []result) {
	raw, _ := json.MarshalIndent(res, "", "  ")
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Errorf("results: %v", err)
	}
}

func printTable(all []result) {
	fmt.Println("| backend | size | page | request | cold ms | warm ms | budget ms | bytes |")
	fmt.Println("|---|---|---|---|---|---|---|---|")
	for _, r := range all {
		mark := ""
		if r.WarmMS > r.BudgetMS {
			mark = " **over**"
		}
		fmt.Printf("| %s | %s | %s | %s | %.1f | %.1f%s | %.0f | %d |\n",
			r.Backend, r.Size, r.Page, r.Name, r.ColdMS, r.WarmMS, mark, r.BudgetMS, r.Bytes)
	}
}

// scaleCase is one request a page sends.
type scaleCase struct {
	page, name, path string
}

// iso renders a time as the dashboard sends it.
func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// dashboardRequests lists the requests the dashboard's pages send, as
// the browser sends them (captured from each page of a binary on a
// seeded fixture), with the fixture's ids and "now" filled in, and the
// variations a user reaches with the pages' filters, facets and paging.
func dashboardRequests(man manifest) []scaleCase {
	st := man.Stats
	now := man.Spec.End
	day := 24 * time.Hour
	q := url.QueryEscape
	window := func(d time.Duration) string {
		return "from=" + q(iso(now.Add(-d))) + "&to=" + q(iso(now))
	}
	var cases []scaleCase
	add := func(page, name, path string) { cases = append(cases, scaleCase{page, name, path}) }

	// Fleet: on load, then one full run detail per run of the swimlane
	// (the daemon's and the largest run's are the heaviest of those).
	add("fleet", "fleet", "/v1/fleet?page=1&per_page=200")
	add("fleet", "sessions 24h with parents", "/v1/sessions?from="+q(iso(now.Add(-day)))+"&include_parents=true&limit=100")
	add("fleet", "events last minute", "/v1/events?"+window(time.Minute)+"&order=desc&limit=1000")
	add("fleet", "events last hour", "/v1/events?"+window(time.Hour)+"&order=desc&limit=1000")
	add("fleet", "custom directives", "/v1/directives/custom")
	add("fleet", "run detail, daemon", "/v1/sessions/"+st.LongRunningActive)
	add("fleet", "run detail, largest run", "/v1/sessions/"+st.LargestSession)

	// Agents: the fleet roster, then one summary per agent row.
	add("agents", "agent summary 7d", "/v1/agents/"+st.Agent+"/summary?period=7d&bucket=day")
	add("agents", "agent summary 30d", "/v1/agents/"+st.Agent+"/summary?period=30d&bucket=day")
	add("agents", "agents listing", "/v1/agents?sort=last_seen_at&order=desc&limit=25&offset=0")
	add("agents", "agents search", "/v1/agents?search=ada&sort=last_seen_at&order=desc&limit=25&offset=0")

	// Events (the Investigate page): the list, its facets, filters, the
	// search bar and a deep page.
	w7 := window(7 * day)
	add("events", "events 7d page 1", "/v1/events?"+w7+"&order=desc&limit=50&offset=0")
	add("events", "events 7d facets", "/v1/events?"+w7+"&facets=true")
	add("events", "events 7d deep page", fmt.Sprintf("/v1/events?%s&order=desc&limit=50&offset=%d", w7, min(st.Events/50, 100_000)))
	add("events", "events 30d flavor+type", "/v1/events?"+window(30*day)+"&flavor=claude-code&event_type=post_call&order=desc&limit=50&offset=0")
	add("events", "events 7d os filter", "/v1/events?"+w7+"&os=Darwin&order=desc&limit=50&offset=0")
	add("events", "events 7d error filter", "/v1/events?"+w7+"&error_type=rate_limit&order=desc&limit=50&offset=0")
	add("events", "events 7d search", "/v1/events?"+w7+"&q="+q("%claude%")+"&order=desc&limit=50&offset=0")
	add("events", "events 7d facets, flavor", "/v1/events?"+w7+"&flavor=support-triage&facets=true")
	add("events", "events 30d facets", "/v1/events?"+window(30*day)+"&facets=true")

	// The sessions listing: the pages' 24 h load above, and the agent
	// drawer's runs, filtered and paged.
	from7 := "from=" + q(iso(now.Add(-7*day)))
	add("events", "sessions 7d", "/v1/sessions?"+from7+"&limit=25&offset=0&sort=started_at&order=desc")
	add("events", "sessions 7d deep page", fmt.Sprintf("/v1/sessions?%s&limit=25&offset=%d&sort=started_at&order=desc", from7, st.Sessions/60))
	add("events", "sessions 7d error filter", "/v1/sessions?"+from7+"&error_type=rate_limit&limit=25&offset=0")
	add("events", "sessions 30d of an agent", "/v1/sessions?from="+q(iso(now.Add(-30*day)))+"&agent_id="+st.Agent+"&limit=25&offset=0&sort=started_at&order=desc")

	// Analytics: the page's charts as it loads them (30 days)...
	for _, qs := range []string{
		"range=30d&metric=sessions&group_by=flavor",
		"metric=latency_avg&group_by=model&range=30d",
		"metric=tokens&group_by=model&range=30d",
		"range=30d&metric=tokens&group_by=provider",
		"metric=latency_p50&group_by=model&range=30d",
		"metric=sessions&group_by=agent_type&range=30d",
		"metric=sessions&group_by=model&range=30d",
		"metric=sessions&group_by=framework&range=30d",
		"metric=latency_p95&group_by=model&range=30d",
		"metric=child_token_sum&group_by=parent_session_id%2Cagent_role&range=30d&filter_is_sub_agent=true",
		"metric=estimated_cost&group_by=provider&range=30d",
	} {
		add("analytics", "page: "+qs, "/v1/analytics?"+qs)
	}
	// ...every metric with one dimension and with two, over 7, 30 and
	// 90 days...
	metrics := []string{"tokens", "sessions", "latency_avg", "latency_p50", "latency_p95", "policy_events",
		"estimated_cost", "parent_token_sum", "child_token_sum", "child_count", "parent_to_first_child_latency_ms"}
	for _, rng := range []string{"7d", "30d", "90d"} {
		for _, m := range metrics {
			two := "model,provider"
			if store.IsSubagentMetric(m) {
				two = "parent_session_id,agent_role"
			}
			add("analytics", m+" by flavor "+rng, "/v1/analytics?metric="+m+"&group_by=flavor&range="+rng+"&granularity=day")
			add("analytics", m+" by "+two+" "+rng, "/v1/analytics?metric="+m+"&group_by="+q(two)+"&range="+rng+"&granularity=day")
		}
	}
	// ...and every dimension over 90 days.
	for _, dim := range []string{"flavor", "model", "framework", "host", "agent_type", "team", "provider", "agent_role", "parent_session_id"} {
		add("analytics", "tokens by "+dim+" 90d", "/v1/analytics?metric=tokens&group_by="+dim+"&range=90d")
	}

	// Search (the command palette, and its recent agents).
	add("search", "search claude", "/v1/search?q=claude")
	add("search", "search session prefix", "/v1/search?q="+st.LargestSession[:8])
	add("search", "search error", "/v1/search?q=rate_limit")
	add("search", "recent agents", "/v1/agents?sort=last_seen_at&order=desc&limit=5")

	// The run drawer of the largest run: its detail, its children, an
	// older page of events, one event's content.
	add("drawer", "run detail", "/v1/sessions/"+st.LargestSession+"?events_limit=100")
	add("drawer", "run children", "/v1/sessions?parent_session_id="+st.DeepRoot+"&limit=1")
	add("drawer", "older events", "/v1/events?from=1970-01-01T00%3A00%3A00Z&session_id="+st.LargestSession+
		"&before="+q(iso(now.Add(-19*day)))+"&order=desc&limit=200")
	add("drawer", "content", "/v1/events/"+st.ContentEvent+"/content")

	// MCP protection: the policy page's metrics, read from events.
	add("mcp", "mcp metrics 30d", "/v1/mcp-policies/global/metrics?period=30d")
	return cases
}
