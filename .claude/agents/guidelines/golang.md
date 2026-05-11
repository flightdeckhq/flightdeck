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
<!-- Add per-project rules here. -->
