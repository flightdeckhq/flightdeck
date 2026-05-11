# Go guidelines

## Hard rules
- No magic strings or magic numbers. Use typed constants. For related values, use `iota`-based const groups so they form an enum-like type:
```gotype Status int
const (
StatusPending Status = iota
StatusActive
StatusClosed
)
  Exceptions: 0, 1, -1, "", in obvious arithmetic or sentinel slots.
- Every error is checked. Never `_ = err`. If you genuinely want to discard, comment why.
- Wrap errors when crossing a boundary: `fmt.Errorf("loading config: %w", err)`. Use `errors.Is` and `errors.As` to inspect.
- `context.Context` is the first parameter of any function that does I/O, blocks, or might be cancelled. Never store a Context in a struct.
- gofmt is non-negotiable. So is `go vet`. So is `golangci-lint` if configured.
- Exported identifiers have a doc comment that begins with the identifier name.

## Idiomatic Go
- Small interfaces. One to three methods is typical. Define interfaces at the consumer, not the producer.
- Accept interfaces, return concrete types.
- Composition via struct embedding. No inheritance.
- Receivers: pick value or pointer per type and stay consistent. Pointer receivers if the method mutates, if the struct is large, or if any method needs a pointer receiver.
- Constructors named `NewXxx`. Return concrete types from constructors, not interfaces, unless polymorphism is the point.
- Group related consts in a single `const ( ... )` block.
- Short names in small scopes (`i`, `r`, `ctx`), descriptive names in package API.
- No package name stutter: `http.Server` not `http.HTTPServer`.
- One package per directory. Internal packages under `internal/`.

## Errors
- Sentinel errors as exported vars: `var ErrNotFound = errors.New("user: not found")`.
- For errors that carry data, define a custom type with an `Error() string` method and an `Is(target error) bool` if needed.
- Don't use `panic` for control flow. Panic only on truly unrecoverable invariants (nil map you wrote, programmer error). Recover only at goroutine roots, never to suppress.

## Concurrency
- Goroutines have an owner who decides their lifetime. Pass `context.Context` so the owner can cancel.
- Channels: the writer closes. Never close from the reader. Never close twice.
- Use `golang.org/x/sync/errgroup` for groups of goroutines that can fail together.
- Prefer `sync.Mutex` as a value field, zero-usable. Embed only if methods are part of the type's API.
- Beware loop variable capture in goroutines (Go 1.22+ fixes the per-iteration scoping for `for` loops, but be explicit anyway in shared code).
- Detect races: run tests with `-race` in CI.

## API and packages
- No circular imports. If you have one, the abstraction is wrong.
- `init()` only for registering things (drivers, codecs, flags). Not for setup that should be explicit.
- Avoid `interface{}` (or `any`) in public APIs unless the genericity is the point. Use generics (Go 1.18+) for type-parameterized code.
- Don't use dot imports outside tests.

## Performance
- Pre-size slices and maps when you know the count: `make([]T, 0, n)`, `make(map[K]V, n)`.
- `strings.Builder` for repeated concatenation in a loop.
- Reuse buffers via `sync.Pool` only when profiling shows allocation pressure.
- `bytes.Buffer` and `bufio.Reader/Writer` around raw IO.

## Security
- Parameterized SQL only. `database/sql` placeholders, never string concatenation.
- `exec.Command(name, args...)` with separate args. Never `sh -c` with user input.
- Validate at trust boundaries.
- `crypto/rand` for tokens, never `math/rand`.
- `bcrypt` or `argon2` for password hashing.
- HTTP clients: always set `Timeout`. The default has none.

## Testing
- `_test.go` files alongside the code.
- Table-driven tests with `tt := tt` capture inside subtest closures (or per-iteration scoping in 1.22+).
- `t.Helper()` in helpers so failure lines point at callers.
- `t.Cleanup` over `defer` for test resource teardown.
- Race detector in CI: `go test -race ./...`.

## Banned patterns
- Naked returns in functions longer than a few lines
- `panic` for control flow
- `init()` doing nontrivial work
- `interface{}` / `any` in public APIs without justification
- `time.Sleep` in tests for synchronization (use channels or `sync` primitives)
- Returning `nil, nil` ambiguity (use a sentinel or a custom result type)

## Project-specific notes

Flightdeck conventions (see `CLAUDE.md`):

- **Schema + API discipline (rules 33–37).** The event payload schema is
  the contract between sensor and ingestion API — never change it without
  updating `ARCHITECTURE.md` first. All database schema changes go
  through `golang-migrate`: create a new numbered pair under
  `docker/postgres/migrations/` (`000NNN_description.up.sql` +
  `000NNN_description.down.sql`, exact inverses). Never modify an applied
  migration. Never add schema changes to `init.sql` (seed data only).
  No raw SQL lives outside `api/internal/store/`. Every event payload is
  validated at the ingestion API boundary before it reaches NATS.
  `GET /v1/events/:id/content` returns **404** when capture is disabled
  for that session — not 200 with empty data, not 403.
- **Analytics enums (rules 25–26).** The `group_by` and `metric` enums on
  `GET /v1/analytics` are locked lists. Adding a value requires updating
  `ARCHITECTURE.md` first. `estimated_cost` reads
  `api/internal/store/pricing.go` (`DECISIONS.md` D099); update the
  pricing table when provider list prices change.
- **Swagger discipline (rule 50).** Every new endpoint in `ingestion/` or
  `api/` gets full swaggo annotations (`@Summary`, `@Description`,
  `@Tags`, `@Accept`, `@Produce`, `@Param`, `@Success`, `@Failure`,
  `@Router`) before the task is considered complete. Regenerate the
  `docs/` directory via `swag init` and commit it.
- **Pre-push lint (rule 40e).** Run `golangci-lint run` from the
  component root before pushing. If `golangci-lint` is not on PATH,
  check `$(go env GOPATH)/bin/golangci-lint` or install it via
  `go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest`.
  `go test ./...` alone misses `unused` and other lints CI enforces.

