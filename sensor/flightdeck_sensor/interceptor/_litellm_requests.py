"""The provider requests litellm itself sends through the OpenAI SDK.

While a litellm call is in flight it runs under the litellm call's mark
(``base.OuterCall``), and the litellm wrapper reports it. The one SDK call
that is that litellm call's own is the provider request litellm's own
provider code sends through the OpenAI SDK on its behalf; the SDK
interceptors hand that request to the SDK untouched (and the OpenAI
interceptor's litellm request hook asks it for usage), and only that one.
Every other SDK call made while the litellm call is in flight -- by a
litellm callback, guardrail or custom provider, by a task the call
created, or by any other code -- is an ordinary call: policed when made,
reported, and captured as the session's capture setting says.

litellm's own request is told apart by the function that makes it: the
first frame above the SDK call that is neither the OpenAI SDK's nor the
sensor's is one of :data:`LITELLM_SDK_REQUESTS`. A litellm release that
moves a request into another function shows as a double count of it
(the litellm wrapper's report and the SDK interceptor's), which the
litellm tests catch, never as a call nobody reports.

Standard library only: the OpenAI interceptor imports this module, and it
must not import litellm.
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from types import FrameType

# The litellm functions that send a provider request through the OpenAI
# SDK, as (module, function): the chat completion, legacy completion and
# embedding requests of litellm's OpenAI and Azure routes, streamed or
# not, sync or async (measured on litellm 1.83.0 and 1.104.2; 1.104 sends
# an OpenAI embedding with its own HTTP handler, so its OpenAI embedding
# functions are 1.83's). The OpenAI-compatible providers litellm serves
# with the SDK send through the OpenAI route's functions.
LITELLM_SDK_REQUESTS = frozenset(
    {
        ("litellm.llms.openai.openai", "make_sync_openai_chat_completion_request"),
        ("litellm.llms.openai.openai", "make_openai_chat_completion_request"),
        ("litellm.llms.openai.openai", "make_sync_openai_embedding_request"),
        ("litellm.llms.openai.openai", "make_openai_embedding_request"),
        ("litellm.llms.openai.completion.handler", "completion"),
        ("litellm.llms.openai.completion.handler", "acompletion"),
        ("litellm.llms.openai.completion.handler", "streaming"),
        ("litellm.llms.openai.completion.handler", "async_streaming"),
        ("litellm.llms.azure.azure", "make_sync_azure_openai_chat_completion_request"),
        ("litellm.llms.azure.azure", "make_azure_openai_chat_completion_request"),
        ("litellm.llms.azure.azure", "embedding"),
        ("litellm.llms.azure.azure", "aembedding"),
        ("litellm.llms.azure.completion.handler", "completion"),
        ("litellm.llms.azure.completion.handler", "acompletion"),
        ("litellm.llms.azure.completion.handler", "streaming"),
        ("litellm.llms.azure.completion.handler", "async_streaming"),
    }
)

# The packages whose frames lie between the code making an SDK call and
# the point where a sensor interceptor asks who made it.
_BETWEEN = ("openai", "flightdeck_sensor")


def requested_by_litellm(frame: FrameType | None) -> bool:
    """Whether the SDK call in progress, seen from ``frame`` (a frame of the
    OpenAI SDK or of the sensor, or the frame that made the call), is a
    provider request litellm itself sends: the first frame from ``frame``
    outward that belongs to neither the OpenAI SDK nor the sensor is one
    of :data:`LITELLM_SDK_REQUESTS`."""
    while frame is not None:
        name = frame.f_globals.get("__name__", "")
        if not isinstance(name, str):
            return False
        if name.split(".", 1)[0] in _BETWEEN:
            frame = frame.f_back
            continue
        return (name, frame.f_code.co_name) in LITELLM_SDK_REQUESTS
    return False


def litellm_owns(sdk: str) -> bool:
    """The litellm call's mark's ``owns``: an SDK call made under it is the
    litellm call's own only when it is an OpenAI SDK request litellm itself
    sends. litellm sends nothing through the Anthropic or google-genai SDKs,
    so a call of theirs under the mark is never litellm's."""
    return sdk == "openai" and requested_by_litellm(sys._getframe(1))
