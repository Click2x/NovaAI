"""The tools the tools model may call during a chat turn. Small on purpose: they touch only her own memory and the clock.
Each tool returns a short plain string that is fed back to the voice model as data (never as instructions)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Callable

from .memory import Memory

SPECS: list[dict] = [
    {"type": "function", "function": {"name": "remember", "description": "Save one fact about the user for later (a preference, a name, a plan, something they asked you to remember).",
                                      "parameters": {"type": "object", "properties": {"fact": {"type": "string", "description": "One short sentence, third person or 'the user'."}}, "required": ["fact"]}}},
    {"type": "function", "function": {"name": "recall", "description": "Look up what you remember about a topic.",
                                      "parameters": {"type": "object", "properties": {"topic": {"type": "string"}}, "required": ["topic"]}}},
    {"type": "function", "function": {"name": "forget", "description": "Delete remembered facts that mention the given words, when the user asks you to forget something.",
                                      "parameters": {"type": "object", "properties": {"topic": {"type": "string"}}, "required": ["topic"]}}},
    {"type": "function", "function": {"name": "current_time", "description": "The current local date and time.", "parameters": {"type": "object", "properties": {}}}},
]


class Toolbox:
    def __init__(self, memory: Memory, now: Callable[[], datetime] = datetime.now):
        self.memory = memory
        self.now = now

    def run(self, name: str, args: Any) -> str:
        args = args if isinstance(args, dict) else {}
        try:
            if name == "remember":
                fid = self.memory.add_fact(str(args.get("fact", "")), source="tool")
                return "Saved." if fid else "Nothing to save."
            if name == "recall":
                hits = self.memory.search_facts(str(args.get("topic", "")))
                return "\n".join("- " + h["text"] for h in hits) if hits else "Nothing remembered about that."
            if name == "forget":
                n = self.memory.forget_matching(str(args.get("topic", "")))
                return f"Forgot {n} item{'s' if n != 1 else ''}." if n else "Nothing matched."
            if name == "current_time":
                return self.now().strftime("%A %d %B %Y, %H:%M")
        except Exception as e:      # a tool must never take the turn down
            return f"Tool error: {type(e).__name__}"
        return f"Unknown tool: {name}"
