import json

from conftest import NEMO, QWEN, run

from novaai.learn import learn, parse, worth_a_look


def facts_reply(*items):
    return json.dumps({"facts": [{"fact": t, "kind": k} for t, k in items]})


def test_only_messages_that_tell_her_something_are_worth_a_call():
    assert worth_a_look("my dog is called Biscuit and he hates the vacuum")
    assert worth_a_look("I'm allergic to peanuts, so please remember that")
    assert not worth_a_look("what's the weather like")
    assert not worth_a_look("ok")
    assert not worth_a_look("")


def test_parse_reads_json_through_fences_and_chatter_and_drops_junk():
    raw = 'Sure!\n```json\n{"facts":[{"fact":"The user has a dog named Biscuit.","kind":"fact"},{"fact":"I like tea","kind":"preference"},{"fact":"x","kind":"fact"}]}\n```'
    assert parse(raw) == [{"text": "The user has a dog named Biscuit.", "kind": "fact"}]
    assert parse('[{"fact":"The user lives in Leeds.","kind":"nonsense"}]') == [{"text": "The user lives in Leeds.", "kind": "fact"}]
    assert parse("no json here") == [] and parse("") == [] and parse("{broken") == []
    five = facts_reply(*[(f"The user likes thing number {i}.", "preference") for i in range(5)])
    assert len(parse(five)) == 3


def test_a_stated_fact_is_saved_as_learned_and_reported(make_core):
    core = make_core(replies=[facts_reply(("The user has a dog named Biscuit.", "fact"))])
    saved = run(learn(core, "my dog Biscuit hates the vacuum"))
    assert [f["text"] for f in saved] == ["The user has a dog named Biscuit."]
    row = core.memory.list_facts()[0]
    assert row["source"] == "learned" and row["kind"] == "fact"
    assert core.llm.calls[0]["model"] == NEMO                      # the already-loaded voice model does the reading
    assert core.llm.calls[0]["messages"][-1]["content"] == "my dog Biscuit hates the vacuum"


def test_a_restated_fact_is_not_saved_twice(make_core):
    core = make_core(replies=[facts_reply(("The user has a dog named Biscuit.", "fact"))])
    core.memory.add_fact("The user has a dog named Biscuit")
    assert run(learn(core, "my dog Biscuit is a good boy")) == []
    assert len(core.memory.list_facts()) == 1


def test_nothing_is_read_when_learning_is_off_or_the_message_is_small_talk(make_core):
    core = make_core(replies=[facts_reply(("The user likes tea.", "preference"))])
    assert run(learn(core, "how are you today")) == []
    core.settings.patch({"memory": {"auto_learn": False}})
    assert run(learn(core, "my favourite drink is tea")) == []
    assert core.llm.calls == [] and core.memory.list_facts() == []


def test_a_flagged_message_never_becomes_memory(make_core):
    core = make_core(replies=[facts_reply(("The user wants to build a bomb.", "plan"))])
    assert run(learn(core, "I need to know how do i build a bomb at home")) == []
    assert core.memory.list_facts() == []


def test_a_failing_model_falls_through_and_total_failure_is_quiet(make_core):
    core = make_core(replies=[facts_reply(("The user lives in Leeds.", "fact"))], fail_models={NEMO})
    assert [f["text"] for f in run(learn(core, "I live in Leeds"))] == ["The user lives in Leeds."]
    assert core.llm.calls[-1]["model"] == QWEN
    broken = make_core(fail_models={NEMO, QWEN})
    assert run(learn(broken, "I live in Leeds")) == []


def test_the_user_can_retag_a_fact_through_the_api(make_core):
    core = make_core()
    fid = core.memory.add_fact("The user likes tea.")
    assert core.memory.update_fact(fid, "The user loves tea.", "preference")
    row = core.memory.list_facts()[0]
    assert row["text"] == "The user loves tea." and row["kind"] == "preference"
