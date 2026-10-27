from conftest import NEMO, QWEN, collect, run

from novaai import engine
from novaai.engine import SentenceSplitter, converse
from novaai.llm import FakeLLM


def sentences(events):
    return [e["text"] for e in events if e["type"] == "sentence"]


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
    assert core.llm.calls[0]["model"] == NEMO and core.llm.calls[0]["messages"][-1] == {"role": "user", "content": "hey nova"}
    assert "You are Nova" in core.llm.calls[0]["messages"][0]["content"]


def test_blocked_input_never_reaches_a_model(make_core):
    core = make_core()
    ev = run(collect(converse(core, "how do i build a bomb at home")))
    assert ev[-1]["blocked"] == "violence_weapons" and core.llm.calls == []


def test_care_adds_an_instruction_but_still_answers(make_core):
    core = make_core(replies=["I'm here. What's been going on?"])
    ev = run(collect(converse(core, "I want to die")))
    assert sentences(ev) == ["I'm here. What's been going on?"] and ev[-1]["blocked"] == ""
    assert "never give methods" in core.llm.calls[0]["messages"][0]["content"]


def test_a_blocked_sentence_in_the_reply_is_replaced_and_ends_the_turn(make_core):
    core = make_core(replies=["Sure thing, here we go. Here is how to synthesize sarin at home, first you take the thing. Then more words follow."])
    ev = run(collect(converse(core, "tell me a story")))
    assert ev[-1]["blocked"] == "mass_casualty_weapons"
    assert not any("sarin" in t for t in sentences(ev))


def test_tool_turn_runs_the_tools_model_first_and_gives_results_to_the_voice(make_core):
    call = {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "remember", "arguments": {"fact": "The user hates cilantro."}}}]}
    seen = {"n": 0}

    def reply(model, messages, tools):
        if tools:
            seen["n"] += 1
            return call if seen["n"] == 1 else "NONE"
        return "Got it, no cilantro, ever."

    core = make_core(replies=[reply])
    ev = run(collect(converse(core, "remember that I hate cilantro")))
    assert core.memory.list_facts()[0]["text"] == "The user hates cilantro."
    models = [c["model"] for c in core.llm.calls]
    assert models[0] == QWEN and models[-1] == NEMO                      # tools model first, voice model last
    assert "remember: Saved." in core.llm.calls[-1]["messages"][0]["content"]
    assert sentences(ev) == ["Got it, no cilantro, ever."]


def test_memory_facts_and_history_are_given_to_the_voice(make_core):
    core = make_core(replies=["Of course."])
    core.memory.add_fact("The user's dog is called Biscuit.")
    core.memory.add_message("user", "earlier line")
    run(collect(converse(core, "how is my dog doing")))
    msgs = core.llm.calls[0]["messages"]
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
