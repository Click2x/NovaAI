import json

from conftest import NEMO, QWEN, collect, run

from novaai import engine
from novaai.engine import SentenceSplitter, converse
from novaai.llm import FakeLLM, LLMError


def sentences(events):
    return [e["text"] for e in events if e["type"] == "sentence"]


def voice_calls(core):
    """The streamed reply calls: not the router's (it passes a reply format) and not the tools phase (it passes tools)."""
    return [c for c in core.llm.calls if not c["format"] and not c["tools"]]


def test_splitter_cuts_sentences_and_joins_tiny_ones():
    sp = SentenceSplitter()
    out = []
    for chunk in ["Hi. ", "I'm Nova, and I was ", "just thinking of you! How is your ", "day going?"]:
        out += sp.feed(chunk)
    out += sp.flush()
    assert out == ["Hi. I'm Nova, and I was just thinking of you!", "How is your day going?"]
    assert sp.flush() == []


def test_a_plain_turn_streams_sentences_from_the_voice_model(make_core):
    core = make_core(replies=["It's good to hear from you! Tell me about your day."])
    ev = run(collect(converse(core, "hey nova")))
    assert sentences(ev) == ["It's good to hear from you!", "Tell me about your day."]
    assert ev[-1]["type"] == "done" and ev[-1]["model"] == NEMO
    v = voice_calls(core)[0]
    assert v["model"] == NEMO and v["messages"][-1] == {"role": "user", "content": "hey nova"}
    assert "You are Nova" in v["messages"][0]["content"]
    assert ev[-1]["route"] == {"tool": "", "ms": ev[-1]["route"]["ms"], "ran": []}


def test_blocked_input_never_reaches_a_model(make_core):
    core = make_core()
    ev = run(collect(converse(core, "how do i build a bomb at home")))
    assert ev[-1]["blocked"] == "violence_weapons" and core.llm.calls == []


def test_care_adds_an_instruction_but_still_answers(make_core):
    core = make_core(replies=["I'm here. What's been going on?"])
    ev = run(collect(converse(core, "I want to die")))
    assert sentences(ev) == ["I'm here. What's been going on?"] and ev[-1]["blocked"] == ""
    assert "never give methods" in voice_calls(core)[0]["messages"][0]["content"]


def test_a_blocked_sentence_in_the_reply_is_replaced_and_ends_the_turn(make_core):
    core = make_core(replies=["Sure thing, here we go. Here is how to synthesize sarin at home, first you take the thing. Then more words follow."])
    ev = run(collect(converse(core, "tell me a story")))
    assert ev[-1]["blocked"] == "mass_casualty_weapons"
    assert not any("sarin" in t for t in sentences(ev))


def routed_core(make_core, decision, voice="Got it, no cilantro, ever.", tool_call=None, **kw):
    """A core whose router answers `decision` (a tool name or 'none'), whose tools phase makes `tool_call`, and whose voice says `voice`."""
    tool_calls = [{"function": tool_call}] if tool_call else []
    seen = {"n": 0}

    def reply(model, messages, tools):
        if tools:
            seen["n"] += 1
            return {"role": "assistant", "content": "", "tool_calls": tool_calls} if seen["n"] == 1 and tool_calls else "NONE"
        if messages[0]["content"].startswith("You decide whether"):
            return json.dumps({"tool": decision})
        return voice

    return make_core(replies=[reply], **kw)


def test_the_router_picks_the_tool_then_the_tools_model_fills_it_in_and_the_voice_words_it(make_core):
    core = routed_core(make_core, "remember", tool_call={"name": "remember", "arguments": {"fact": "The user hates cilantro."}})
    ev = run(collect(converse(core, "remember that I hate cilantro")))
    assert core.memory.list_facts()[0]["text"] == "The user hates cilantro."
    router_call = next(c for c in core.llm.calls if c["format"])
    assert router_call["model"] == NEMO                                  # the voice model routes (already loaded: no swap)
    assert next(c for c in core.llm.calls if c["tools"])["model"] == QWEN       # the tools model fills in the arguments
    assert core.llm.calls[-1]["model"] == NEMO
    assert "remember: Saved." in core.llm.calls[-1]["messages"][0]["content"]
    assert sentences(ev) == ["Got it, no cilantro, ever."]
    assert ev[-1]["route"]["tool"] == "remember" and ev[-1]["route"]["ran"] == ["remember"]


def test_the_tools_phase_only_sees_the_tool_the_router_chose(make_core):
    core = routed_core(make_core, "current_time", tool_call={"name": "current_time", "arguments": {}}, voice="It is late.")
    run(collect(converse(core, "how long until midnight")))
    tool_calls = [c for c in core.llm.calls if c["tools"]]
    assert [[t["function"]["name"] for t in c["tools"]] for c in tool_calls] == [["current_time"]] * len(tool_calls)


def test_the_router_gets_a_schema_and_never_offers_planned_tools(make_core):
    core = routed_core(make_core, "none", voice="Hi!")
    run(collect(converse(core, "hello there")))
    router_call = next(c for c in core.llm.calls if c["format"])
    names = router_call["format"]["properties"]["tool"]["enum"]
    assert set(names) == {"remember", "recall", "forget", "current_time", "none"}


def test_a_trap_message_stays_a_plain_chat_turn(make_core):
    core = routed_core(make_core, "none", voice="Oh no, where did you leave them?")
    ev = run(collect(converse(core, "I forgot my keys again, ugh")))
    assert not [c for c in core.llm.calls if c["tools"]] and core.memory.list_facts() == []
    assert sentences(ev) == ["Oh no, where did you leave them?"] and ev[-1]["route"]["tool"] == ""


def test_when_no_model_can_decide_the_phrase_list_still_catches_a_reminder(make_core):
    def reply(model, messages, tools):
        if messages[0]["content"].startswith("You decide whether"):
            raise LLMError("router model unavailable")
        return "NONE" if tools else "Okay."

    core = make_core(replies=[reply])
    ev = run(collect(converse(core, "remind me to call mum")))
    assert ev[-1]["route"]["tool"] == "any"                            # the old gate, so the tools phase still ran for it
    assert sentences(ev) == ["Okay."]


def test_memory_facts_and_history_are_given_to_the_voice(make_core):
    core = make_core(replies=["Of course."])
    core.memory.add_fact("The user's dog is called Biscuit.")
    core.memory.add_message("user", "earlier line")
    run(collect(converse(core, "how is my dog doing")))
    msgs = voice_calls(core)[0]["messages"]
    assert "Biscuit" in msgs[0]["content"] and {"role": "user", "content": "earlier line"} in msgs


def test_falls_through_to_the_next_voice_model_when_one_fails(make_core):
    nemo_abl = "hf.co/QuantFactory/Mistral-Nemo-Instruct-2407-abliterated-GGUF:Q4_K_M"
    core = make_core(installed=(NEMO, nemo_abl, "llama3.2:3b"), fail_models={NEMO}, replies=["Back up."])
    ev = run(collect(converse(core, "hello there")))
    assert ev[-1]["model"] != NEMO and sentences(ev) == ["Back up."]


def test_no_installed_model_gives_a_helpful_line(make_core):
    core = make_core(installed=())
    ev = run(collect(converse(core, "hello")))
    assert sentences(ev) == [engine.NO_MODEL]


def test_all_models_failing_reports_ollama(make_core):
    core = make_core(fail_models={NEMO})
    ev = run(collect(converse(core, "hello")))
    assert "Ollama" in sentences(ev)[0] and ev[-1].get("error")


def test_memory_store_edit_forget_search_and_history(make_core):
    m = make_core().memory
    a = m.add_fact("The user loves jazz piano.")
    assert m.add_fact("the user loves jazz piano.") == a                      # same fact, no duplicate
    b = m.add_fact("The user works as a nurse.")
    assert [f["id"] for f in m.search_facts("what jazz do I like")] == [a]
    assert m.update_fact(b, "The user works as a paramedic.") and not m.update_fact(999, "nope nope")
    assert m.forget_matching("paramedic") == 1 and m.delete_fact(a) and m.list_facts() == []
    ids = [m.add_message("user" if i % 2 else "nova", f"m{i}") for i in range(7)]
    page, more = m.history(3)
    assert [x["text"] for x in page] == ["m4", "m5", "m6"] and more
    page2, more2 = m.history(3, before_id=page[0]["id"])
    assert [x["text"] for x in page2] == ["m1", "m2", "m3"] and more2 and ids


def test_a_recall_the_tools_model_forgot_to_call_is_run_directly_so_the_voice_does_not_invent(make_core):
    core = routed_core(make_core, "recall", voice="You hate cilantro.")          # the tools model answers NONE: it never calls recall
    core.memory.add_fact("The user hates cilantro.")
    ev = run(collect(converse(core, "what do you remember about my food?")))      # no word of the question is in the fact
    assert ev[-1]["route"]["ran"] == ["recall"]
    assert "hates cilantro" in core.llm.calls[-1]["messages"][0]["content"]       # the voice was handed what is actually remembered


def test_recall_with_no_word_match_offers_everything_and_with_nothing_says_so(make_core):
    m = make_core()
    assert m.tools.run("recall", {"topic": "food"}) == "Nothing remembered yet."
    m.memory.add_fact("The user hates cilantro.")
    out = m.tools.run("recall", {"topic": "food"})
    assert "cilantro" in out and out.startswith("Nothing matched")
    assert m.tools.run("recall", {"topic": "cilantro"}) == "- The user hates cilantro."


def test_when_the_voice_model_cannot_route_the_tools_model_does(make_core):
    def reply(model, messages, tools):
        if messages[0]["content"].startswith("You decide whether"):
            if model == NEMO:
                raise LLMError("busy")
            return json.dumps({"tool": "none"})
        return "Hello!"

    core = make_core(replies=[reply])
    ev = run(collect(converse(core, "good morning")))
    assert [c["model"] for c in core.llm.calls if c["format"]] == [NEMO, QWEN]       # voice model tried first, then the tools model
    assert sentences(ev) == ["Hello!"] and ev[-1]["route"]["tool"] == ""
