"""Direct OpenAI SDK -- sync, async, streaming, responses, embeddings.

Copy-paste starter for the raw `openai` package. The sensor's patch()
covers OpenAI() and AsyncOpenAI() instances; streaming picks up token
counts via stream_options={include_usage: true} (sensor-injected).
"""
from __future__ import annotations

import asyncio, sys, time, uuid

try:
    import openai
except ImportError:
    print("SKIP: pip install openai to run this example")
    sys.exit(2)

import flightdeck_sensor
from _helpers import assert_event_landed, init_sensor, print_result

MODEL = "gpt-4o-mini"
HI = [{"role": "user", "content": "hi"}]

def main() -> None:
    session_id = str(uuid.uuid4())
    init_sensor(session_id)
    flightdeck_sensor.patch(providers=["openai"], quiet=True)
    print(f"[playground:02_direct_openai] session_id={session_id}")

    t0 = time.monotonic()
    r = openai.OpenAI().chat.completions.create(model=MODEL, max_tokens=5, messages=HI)
    print_result("OpenAI().chat.completions.create", True, int((time.monotonic() - t0) * 1000),
                 f"{r.usage.total_tokens} tokens")

    async def _call() -> None:
        await openai.AsyncOpenAI().chat.completions.create(
            model=MODEL, max_tokens=5, messages=HI)
    t0 = time.monotonic()
    asyncio.run(_call())
    print_result("AsyncOpenAI().chat.completions.create", True, int((time.monotonic() - t0) * 1000))

    t0 = time.monotonic()
    with openai.OpenAI().chat.completions.create(
            model=MODEL, max_tokens=5, messages=HI, stream=True) as s:
        for _ in s: pass
    print_result("OpenAI().chat.completions (stream)", True, int((time.monotonic() - t0) * 1000))

    t0 = time.monotonic()
    openai.OpenAI().responses.create(model=MODEL, input="hi", max_output_tokens=16)
    print_result("OpenAI().responses.create", True, int((time.monotonic() - t0) * 1000))

    t0 = time.monotonic()
    openai.OpenAI().embeddings.create(model="text-embedding-3-small", input="hi")
    print_result("OpenAI().embeddings.create", True, int((time.monotonic() - t0) * 1000))

    assert_event_landed(session_id, "post_call", timeout=8)
    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
