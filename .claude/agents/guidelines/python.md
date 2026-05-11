# Python guidelines

## Hard rules
- No magic strings or magic numbers anywhere. Define module-level constants in UPPER_SNAKE_CASE, or use `enum.Enum` / `enum.IntEnum` / `enum.StrEnum` for related values. The only exceptions are 0, 1, -1, "", and identity test values in tests.
- Type hints on every public function and method. Use modern syntax (`list[int]`, `X | None`, `Self`) on Python 3.10+.
- All public functions, classes, and modules have docstrings. Use Google style or NumPy style consistently within a project.
- Use `pathlib.Path` for filesystem paths, never `os.path`.
- Use `logging` (or `structlog`) with module-level loggers (`logger = logging.getLogger(__name__)`). Never `print` for diagnostics.
- f-strings only for formatting. Not `%` and not `.format()`.
- Use `is` / `is not` for `None`, `True`, `False`. Use `==` for value comparison.
- Compare types with `isinstance`, never `type(x) == X`.
- Context managers (`with`) for any resource that opens and closes (files, sockets, sessions, locks).
- Prefer composition over inheritance. Inherit only when there is a true is-a relationship.
- One public class per file when classes are non-trivial.

## Idiomatic Python
- Comprehensions for transforms, generators for large or streaming data.
- `enumerate(x)` instead of indexing with `range(len(x))`.
- `zip(a, b, strict=True)` when iterating pairs of equal length.
- `dict.get(k, default)` over `if k in d`.
- `collections.defaultdict`, `collections.Counter`, `itertools.chain`, `functools.cache` where they fit.
- `dataclasses` (or pydantic v2 for validated I/O models) instead of dict-shaped objects.
- Use `TYPE_CHECKING` for import cycles and type-only imports.
- `pathlib.Path.read_text()` / `.write_text()` over `open` for one-shot reads.

## Error handling
- Never bare `except:`. Catch specific exception classes.
- Never silently swallow exceptions. If you catch and ignore, leave a comment explaining why.
- Wrap and re-raise with `raise NewError(...) from err` to preserve cause.
- Define a project-specific exception hierarchy (`AppError` base, then domain-specific subclasses).
- Validate inputs at trust boundaries (HTTP, message queue, file ingest), not deep inside.

## Concurrency and async
- Don't mix sync and async carelessly. A sync function called from async code blocks the event loop. Use `asyncio.to_thread` for blocking calls.
- Always set timeouts on network calls (`httpx`, `aiohttp`, db drivers).
- Cancel tasks deterministically. Use `asyncio.TaskGroup` (3.11+) over manual `gather`.
- Don't share mutable state across tasks without a lock or a queue.

## Performance
- Set membership (`x in some_set`) is O(1). List membership is O(n). Choose accordingly.
- Avoid quadratic loops over growing lists. If you find yourself doing one, reach for a dict or set.
- For large numeric work, NumPy or Polars beats pure Python. Don't reinvent vectorization.
- Don't optimize before measuring. Use `cProfile` or `pyinstrument`.

## Security
- Never `eval`, never `exec` on input you didn't fully construct.
- `pickle` only for fully-trusted data. For untrusted, use JSON or msgpack.
- `subprocess.run([...])` with a list, never `shell=True` on user input.
- Parameterized queries always. No f-string SQL.
- Secrets from env or a secret manager, never in code or logs. Scrub before logging.
- `hashlib` for non-password hashing. `bcrypt`, `argon2-cffi`, or `passlib` for passwords. Never SHA for passwords.
- `secrets` module for tokens, never `random`.

## Testing
- pytest. Fixtures over `setUp`/`tearDown`.
- Test names describe behavior: `test_returns_empty_list_when_user_has_no_orders`.
- One concept per test. Multiple asserts on the same concept is fine.
- Parametrize with `pytest.mark.parametrize` instead of looping.
- No network, no real DB, no real time in unit tests. Use fakes or `freezegun`.

## Banned patterns
- `from module import *`
- Mutable default arguments (`def f(x=[]):`)
- Global mutable state (module-level lists, dicts being mutated by functions)
- Catching `Exception` at the top of a function "just in case"
- Returning different types from one function based on flags (`-> str | int | None`)
- Comments that restate the code instead of explaining why

## Project-specific notes

Flightdeck conventions (see `CLAUDE.md`):

- **Sensor discipline (rules 27–32).** `flightdeck-sensor` is a library
  wrapper, not an OS agent. Never introduce synchronous blocking calls on
  the LLM hot path; all control-plane communication is fire-and-forget or
  background. Never raise exceptions on connectivity failures when
  `FLIGHTDECK_UNAVAILABLE_POLICY=continue` — fail open. Never add
  background threads / polling loops / daemon threads beyond the existing
  event-queue drain thread; if a feature requires background activity
  independent of LLM calls, it does not belong in the sensor. Do not
  rewrite the token-counting logic carried over from `tokencap`; extend
  it. `capture_prompts` defaults to `False` — never flip the default. The
  `init()` `limit` param fires WARN only; never upgrade a local limit to
  BLOCK or DEGRADE regardless of server policy (see `DECISIONS.md` D035).
- **Capture posture (rules 18–21).** When `capture_prompts=False`, event
  payloads contain only token counts, model names, latency, and tool
  names — no message content, no system prompts, no tool inputs / outputs,
  no response text. Content lives in `event_content` only, never inline
  in `events`. Preserve provider terminology — do not normalize
  Anthropic's `system + messages` into OpenAI's `messages`-only shape (or
  vice versa).
- **Playground discipline (rules 40a.A / 40a.B).** Every playground script
  declares a meaningful `agent_type` and `flavor` (never `"unknown"`,
  never empty, never inherited defaults); `flavor` is a required keyword-
  only parameter in `playground/_helpers.py::init_sensor`. Default
  `capture_prompts=True` in the helper — playground is the highest-
  fidelity smoke surface.
- **Pre-push lint (rule 40e).** `ruff check .` and `ruff format --check .`
  from the component root; `mypy --strict flightdeck_sensor/` for the
  sensor. Don't trust `make lint` alone.

