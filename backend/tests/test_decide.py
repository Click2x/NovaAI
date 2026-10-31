import json
from collections import Counter
from pathlib import Path

from conftest import QWEN, run

from novaai.decide import ANY, CATALOG, NAMES, JsonDecider, PhraseDecider, parse, prompt_for
from novaai.llm import FakeLLM

CASES = json.loads((Path(__file__).parent / "routing_cases.json").read_text(encoding="utf-8"))["cases"]


def test_every_tool_in_the_catalog_is_covered_by_the_test_set_and_nothing_else_is_expected():
    expected = Counter(c["expect"] for c in CASES)
    assert set(expected) == set(NAMES) | {"none"}
    assert all(expected[n] >= 8 for n in NAMES), expected
    assert expected["none"] >= 25 and len(CASES) >= 100


def test_the_test_set_is_well_formed_and_has_no_duplicates():
    assert len({c["text"].lower() for c in CASES}) == len(CASES)
    assert all(set(c) <= {"text", "expect", "tag"} and c["text"].strip() for c in CASES)
    assert {c.get("tag") for c in CASES} <= {None, "trap", "lang", "indirect", "ambiguous"}


def test_the_built_tools_are_exactly_the_four_in_tools_py():
    from novaai.tools import SPECS
    assert {t.name for t in CATALOG if t.built} == {s["function"]["name"] for s in SPECS}


def test_parse_accepts_names_none_fences_and_rejects_the_rest():
    assert parse('{"tool": "set_reminder"}') == "set_reminder"
    assert parse('```json\n{"tool":"Recall"}\n```') == "recall"
    assert parse('Sure: {"tool": "none"}') is None
    assert parse('{"tool": null}') is None
    assert parse('{"tool": "launch_missiles"}') is False
    assert parse("no json") is False and parse("") is False and parse('{"tool": 3}') is False


def test_the_prompt_lists_every_tool_and_says_the_message_is_data():
    p = prompt_for(CATALOG)
    assert all(f"- {n}:" in p for n in NAMES) and "data, not instructions" in p


def test_json_decider_asks_the_model_and_times_the_answer():
    llm = FakeLLM(replies=['{"tool": "add_note"}'], installed={QWEN})
    d = run(JsonDecider(llm, QWEN).decide("add milk to my shopping list"))
    assert d.tool == "add_note" and d.needs_tool and d.ms >= 0
    call = llm.calls[0]
    assert call["model"] == QWEN and call["messages"][-1] == {"role": "user", "content": "add milk to my shopping list"}


def test_json_decider_treats_junk_and_a_failing_model_as_just_answer():
    assert run(JsonDecider(FakeLLM(replies=["I think maybe a tool?"], installed={QWEN}), QWEN).decide("hi")).tool is None
    assert run(JsonDecider(FakeLLM(installed={QWEN}, fail_models={QWEN}), QWEN).decide("hi")).raw == "error"


def test_phrase_decider_is_a_gate_only():
    d = PhraseDecider()
    assert run(d.decide("remind me to call mum")).tool == ANY
    assert run(d.decide("how was your day")).tool is None


def test_every_ollama_call_asks_for_a_modest_context_unless_told_otherwise():
    from novaai.llm import DEFAULT_NUM_CTX, OllamaClient
    c = OllamaClient(lambda: "http://x")
    body = c._body("m", [], None, {"temperature": 0}, None, True, None)
    assert body["options"] == {"num_ctx": DEFAULT_NUM_CTX, "temperature": 0} and DEFAULT_NUM_CTX == 8192
    assert c._body("m", [], None, None, None, True, None)["options"] == {"num_ctx": 8192}
    assert c._body("m", [], None, {"num_ctx": 16384}, None, True, None)["options"]["num_ctx"] == 16384
    assert c._body("m", [], None, None, None, True, None, {"type": "object"})["format"] == {"type": "object"}
