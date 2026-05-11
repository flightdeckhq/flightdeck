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
<!-- Add per-project rules here. -->
