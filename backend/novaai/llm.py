"""Ollama client (async, httpx) and a scripted fake with the same interface for tests and offline demos.

Interface used by the rest of the backend:
    await llm.list_models()                    -> set of installed tags
    await llm.show(tag)                        -> {"capabilities": [...], ...} or None when the tag is not installed
    llm.pull(tag)                              -> async iterator of progress dicts {"status", "total", "completed"}
    llm.chat(model, messages, tools=, options=, think=)  -> async iterator of chunks {"message": {"content", "tool_calls"?}, "done"}
    await llm.complete(model, messages, tools=, options=, think=) -> the whole reply as one message dict
"""
from __future__ import annotations

import json
from typing import Any, AsyncIterator, Callable, Optional

import httpx


class LLMError(RuntimeError):
    pass


class OllamaClient:
    def __init__(self, get_url: Callable[[], str], timeout: float = 300.0):
        self._get_url = get_url
        self._timeout = timeout

    def _client(self, timeout: float | None = None) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self._get_url(), timeout=timeout or self._timeout)

    async def alive(self) -> bool:
        try:
            async with self._client(3) as c:
                return (await c.get("/api/version")).status_code == 200
        except httpx.HTTPError:
            return False

    async def list_models(self) -> set[str]:
        try:
            async with self._client(5) as c:
                r = await c.get("/api/tags")
                r.raise_for_status()
                return {m["name"] for m in r.json().get("models", []) if "name" in m}
        except (httpx.HTTPError, ValueError, KeyError):
            return set()

    async def show(self, tag: str) -> Optional[dict]:
        try:
            async with self._client(10) as c:
                r = await c.post("/api/show", json={"model": tag})
                return r.json() if r.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            return None

    async def pull(self, tag: str) -> AsyncIterator[dict]:
        try:
            async with self._client(None) as c:
                async with c.stream("POST", "/api/pull", json={"model": tag, "stream": True}, timeout=None) as r:
                    if r.status_code != 200:
                        raise LLMError(f"pull {tag}: HTTP {r.status_code}")
                    async for line in r.aiter_lines():
                        if line.strip():
                            msg = json.loads(line)
                            if msg.get("error"):
                                raise LLMError(f"pull {tag}: {msg['error']}")
                            yield msg
        except httpx.HTTPError as e:
            raise LLMError(f"pull {tag}: {e}") from e

    def _body(self, model: str, messages: list, tools, options, think, stream: bool, keep_alive: str | None) -> dict:
        body: dict[str, Any] = {"model": model, "messages": messages, "stream": stream}
        if tools:
            body["tools"] = tools
        if options:
            body["options"] = options
        if think is not None:
            body["think"] = think
        if keep_alive:
            body["keep_alive"] = keep_alive
        return body

    async def chat(self, model: str, messages: list, tools: list | None = None, options: dict | None = None, think: bool | None = None,
                   keep_alive: str | None = "30m") -> AsyncIterator[dict]:
        for attempt in (0, 1):
            try:
                async with self._client() as c:
                    async with c.stream("POST", "/api/chat", json=self._body(model, messages, tools, options, think, True, keep_alive)) as r:
                        if r.status_code != 200:
                            detail = (await r.aread())[:300].decode("utf-8", "replace")
                            if attempt == 0 and think is not None and r.status_code == 400 and "think" in detail.lower():
                                think = None          # this model has no thinking mode: ask again without the flag
                                continue
                            raise LLMError(f"{model}: HTTP {r.status_code} {detail[:200]}")
                        async for line in r.aiter_lines():
                            if line.strip():
                                yield json.loads(line)
                        return
            except httpx.HTTPError as e:
                raise LLMError(f"{model}: {e}") from e

    async def warm(self, model: str) -> None:
        """Load the model into memory now (one token), so the first real message is not a cold start. Best effort."""
        try:
            async for _ in self.chat(model, [{"role": "user", "content": "hi"}], options={"num_predict": 1}, think=False):
                pass
        except LLMError:
            pass

    async def complete(self, model: str, messages: list, tools: list | None = None, options: dict | None = None, think: bool | None = None) -> dict:
        text, calls = [], []
        async for chunk in self.chat(model, messages, tools, options, think):
            m = chunk.get("message") or {}
            if m.get("content"):
                text.append(m["content"])
            calls.extend(m.get("tool_calls") or [])
        out: dict[str, Any] = {"role": "assistant", "content": "".join(text)}
        if calls:
            out["tool_calls"] = calls
        return out

    async def unload(self, model: str) -> None:
        try:
            async with self._client(10) as c:
                await c.post("/api/chat", json={"model": model, "messages": [], "keep_alive": 0})
        except httpx.HTTPError:
            pass


class FakeLLM:
    """Same interface, no network. `replies` is a list of strings / dicts (message dicts with tool_calls) / callables(model, messages, tools)
    consumed in order (the last one repeats). `installed` is the set of tags it claims to have; `tools_ok` the tags that report tool support."""

    def __init__(self, replies=None, installed=None, tools_ok=None, alive: bool = True, pull_steps: int = 4, fail_models: set[str] | None = None):
        self.replies = list(replies or ["Okay."])
        self.installed = set(installed or [])
        self.tools_ok = set(tools_ok) if tools_ok is not None else None
        self._alive = alive
        self.pull_steps = pull_steps
        self.fail_models = fail_models or set()
        self.calls: list[dict] = []

    async def alive(self) -> bool:
        return self._alive

    async def list_models(self) -> set[str]:
        return set(self.installed)

    async def show(self, tag: str) -> Optional[dict]:
        if tag not in self.installed:
            return None
        ok = self.tools_ok is None or tag in self.tools_ok
        return {"capabilities": ["completion"] + (["tools"] if ok else [])}

    async def pull(self, tag: str) -> AsyncIterator[dict]:
        if tag in self.fail_models:
            raise LLMError(f"pull {tag}: not found")
        for i in range(1, self.pull_steps + 1):
            yield {"status": f"pulling {tag}", "total": self.pull_steps * 100, "completed": i * 100}
        self.installed.add(tag)
        yield {"status": "success"}

    def _next(self, model, messages, tools):
        self.calls.append({"model": model, "messages": messages, "tools": tools})
        if model in self.fail_models:
            raise LLMError(f"{model}: unavailable")
        r = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        if callable(r):
            r = r(model, messages, tools)
        return {"role": "assistant", "content": r} if isinstance(r, str) else dict(r)

    async def chat(self, model: str, messages: list, tools=None, options=None, think=None, keep_alive=None) -> AsyncIterator[dict]:
        msg = self._next(model, messages, tools)
        text = msg.get("content", "")
        for i in range(0, len(text), 12):
            yield {"message": {"role": "assistant", "content": text[i:i + 12]}, "done": False}
        yield {"message": {"role": "assistant", "content": "", **({"tool_calls": msg["tool_calls"]} if msg.get("tool_calls") else {})}, "done": True}

    async def complete(self, model: str, messages: list, tools=None, options=None, think=None) -> dict:
        return self._next(model, messages, tools)

    async def unload(self, model: str) -> None:
        return None

    async def warm(self, model: str) -> None:
        self.warmed = getattr(self, "warmed", []) + [model]
