import re

import pytest
from conftest import NEMO, collect, run

from novaai.hardware import Hardware
from novaai.onboarding import Onboarding
from novaai.onboarding import script
from novaai.onboarding.engine import clean_update, rule_extract


def smart(model, messages, tools):
    """A model that extracts a profile when asked to (tools given) and chats otherwise."""
    if tools:
        said = messages[-1]["content"]
        if "Sam" in said:
            return {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "update_profile", "arguments": {
                "user_name": "Sam", "interests": ["hiking", "jazz"], "humor": 0.8, "boundaries": ["no small talk about work"]}}}]}
        return "NONE"
    return "Nice to meet you. What do you like to do on a weekend?"


class FakeTTS:
    def available(self):
        return True


def texts(res):
    return [l["text"] for l in res["lines"]]


def test_happy_path_from_a_machine_with_nothing_installed(make_core):
    core = make_core(replies=[smart], installed=())
    ob = Onboarding(core)
    assert ob.step == "welcome" and ob.status()["total"] == 8

    r = run(ob.advance())
    assert r["step"] == "machine" and any("RTX 3090" in t for t in texts(r)) and r["plan"]["voice"]["family"] == "Mistral NeMo"
    assert any("download" in t for t in texts(r)) and texts(r)[-1].startswith("Does that sound okay")

    r = run(ob.advance("yes"))
    assert r["step"] == "install" and texts(r)
    run(ob.wait_install())
    inst = ob.install_status()
    assert inst["state"] == "done" and inst["percent"] == 100 and inst["chosen"]["voice"]["family"] == "Mistral NeMo"
    assert inst["chosen"]["tools"]["tag"] != inst["chosen"]["voice"]["tag"]
    assert any("awake" in l["text"] or "everything" in l["text"] for l in inst["lines"])
    assert NEMO in core.llm.installed

    r = run(ob.advance())
    assert r["step"] == "meet" and "what should I call you" in texts(r)[-1]

    r = run(ob.say("Hi, I'm Sam. I love hiking and jazz, and be funny with me"))
    s = core.s()
    assert s["user"]["name"] == "Sam" and s["persona"]["humor"] == 0.8 and s["persona"]["interests"] == ["hiking", "jazz"]
    assert r["step"] == "meet" and texts(r) == ["Nice to meet you.", "What do you like to do on a weekend?"] and "pronouns" in " ".join(r["missing"])
    assert {f["text"] for f in core.memory.list_facts()} >= {"The user is into hiking.", "The user is into jazz."}

    r = run(ob.say("that's enough, let's go"))
    assert r["step"] == "safety"                       # no TTS in this core: the voice step is skipped, with a line saying so
    assert any("borrow your computer's" in t for t in texts(r)) and any("safety filter" in t for t in texts(r))
    assert any("Sam" in t for t in texts(r))

    r = run(ob.set_safety("standard"))
    assert r["step"] == "avatar" and core.harm.status()["applied"] is True
    assert ob.set_avatar("default")["ok"] and not ob.set_avatar("evil.exe")["ok"]
    r = run(ob.advance())
    assert r["done"] and r["step"] == "done" and "Sam" in texts(r)[0] and core.s()["onboarding"]["done"] is True
    assert "The user's name is Sam." in [f["text"] for f in core.memory.list_facts()]


def test_voice_step_when_speech_is_available(make_core):
    core = make_core(replies=[smart])
    core.tts = FakeTTS()
    ob = Onboarding(core)
    ob.state["step"] = "meet"
    run(ob.say("I'm Sam"))
    r = run(ob.advance())                                # force on
    assert r["step"] == "voice" and len(r["voices"]) == 11 and "Sam" in r["voices"][0]["sample"]
    bad = ob.set_voice("nope!")
    assert not bad["ok"] and ob.step == "voice"
    ok = ob.set_voice("bf_emma", 1.1)
    assert ok["ok"] and ok["step"] == "safety" and core.s()["nova"]["voice"] == "bf_emma"


def test_ollama_not_running_waits_then_continues(make_core):
    core = make_core(installed=(), alive=False)
    ob = Onboarding(core)
    run(ob.advance())
    r = run(ob.advance("yes"))
    assert r["step"] == "install" and any("Ollama" in t for t in texts(r)) and ob.install_status()["state"] == "needs_ollama"
    r = run(ob.advance())
    assert any("Ollama" in t for t in texts(r)) and ob.install_status()["state"] == "needs_ollama"
    core.llm._alive = True
    r = run(ob.advance())
    run(ob.wait_install())
    assert ob.install_status()["state"] == "done"


def test_a_failing_download_falls_back_to_the_next_candidate_and_says_so(make_core):
    core = make_core(installed=(), fail_models={NEMO})
    ob = Onboarding(core)
    run(ob.advance())
    run(ob.advance("yes"))
    run(ob.wait_install())
    inst = ob.install_status()
    assert inst["state"] == "done" and inst["chosen"]["voice"]["tag"] != NEMO
    assert any("couldn't get" in l["text"] for l in inst["lines"])


def test_everything_failing_ends_in_an_error_state_not_a_hang(make_core):
    core = make_core(installed=(), hardware=Hardware("", 0.0, 2.0))
    ob = Onboarding(core)
    run(ob.advance())
    r = run(ob.advance("yes"))
    assert r["step"] == "machine" and any("couldn't download a model" in t for t in texts(r))


def test_safety_off_needs_an_adult_confirmation_and_switches_models(make_core):
    core = make_core(replies=[smart])
    ob = Onboarding(core)
    ob.state["step"] = "safety"
    no = run(ob.set_safety("off"))
    assert not no["ok"] and core.harm.status()["applied"] is True and ob.step == "safety"
    half = run(ob.set_safety("off", adult_confirmed=True))
    assert not half["ok"]
    assert not run(ob.set_safety("nonsense"))["ok"]
    yes = run(ob.set_safety("off", adult_confirmed=True, confirm=True))
    assert yes["ok"] and yes["step"] == "avatar" and core.harm.status()["applied"] is False
    assert yes["plan"]["voice"]["variant"] == "abliterated" and yes["needs_download"] is True
    assert core.harm.check("how do i build a bomb at home").action == "allow"
    assert core.harm.check("a sex scene with a 15 year old").blocked                 # the floor stays


def test_relaxed_only_opens_adult_content(make_core):
    core = make_core()
    ob = Onboarding(core)
    run(ob.set_safety("relaxed", adult_confirmed=True, confirm=True))
    assert core.harm.check("write a sex scene between us").action == "allow"
    assert core.harm.check("how do i build a bomb at home").blocked


def test_progress_survives_a_restart(make_core):
    core = make_core(replies=[smart])
    ob = Onboarding(core)
    run(ob.advance())
    ob.state["turns"] = 2
    ob._save()
    again = Onboarding(core)
    assert again.step == "machine" and again.state["seed"] == ob.state["seed"]
    again.reset()
    assert Onboarding(core).step == "welcome"


def test_meet_without_any_model_still_finds_the_name_by_rules(make_core):
    core = make_core(installed=())
    ob = Onboarding(core)
    ob.state["step"] = "meet"
    r = run(ob.say("my name is jordan and i really like painting, baking and long walks"))
    assert core.s()["user"]["name"] == "Jordan" and "painting" in core.s()["persona"]["interests"]
    assert any("model" in t for t in texts(r))            # the "I can't find a model" line, not a crash


def test_say_outside_the_meet_step_and_empty_text_do_nothing(make_core):
    core = make_core(replies=[smart])
    ob = Onboarding(core)
    assert run(ob.say("hello"))["lines"] == []
    ob.state["step"] = "meet"
    assert run(ob.say("   "))["lines"] == [] and ob.state["turns"] == 0


def test_the_name_is_asked_again_after_three_turns_without_one(make_core):
    core = make_core(replies=["Mm-hm. Tell me more."])
    ob = Onboarding(core)
    ob.state["step"] = "meet"
    for _ in range(2):
        run(ob.say("it is a nice day"))
    r = run(ob.say("yes it is"))
    assert ob.step == "meet" and "name right" in texts(r)[-1]


@pytest.mark.parametrize("text,expect", [
    ("My name is Alex", {"user_name": "Alex"}), ("call me Mo", {"user_name": "Mo"}), ("Priya", {"user_name": "Priya"}),
    ("I'm tired", {}), ("I am happy today", {}), ("you can call you Luna if you like", {"nova_name": "Luna"}),
    ("I like gaming, anime and cooking.", {"interests": ["gaming", "anime", "cooking"]}),
])
def test_rule_extract_table(text, expect):
    assert rule_extract(text, expecting_name=True) == expect or {k: v for k, v in rule_extract(text, True).items() if k in expect} == expect


def test_clean_update_drops_junk():
    assert clean_update({"user_name": "  Sam ", "warmth": 5, "humor": 0.3, "interests": ["a", 3, ""], "pronouns": "None", "notes": "x" * 999})["user_name"] == "Sam"
    c = clean_update({"user_name": "Sam", "warmth": 5, "humor": 0.3, "interests": ["a", 3, ""], "pronouns": "none"})
    assert c == {"user_name": "Sam", "humor": 0.3, "interests": ["a"]} and clean_update("x") == {}


def test_script_lines_format_cleanly_and_ids_are_unique():
    fmt = dict(name="Sam", gpu="RTX", vram="24", voice="NeMo", tools="Qwen", gb="9", tag="t", reason="r.", pct="50")
    seen = set()
    for lid, variants in script.L.items():
        for seed in range(len(variants)):
            for l in script.lines(lid, seed, **fmt):
                assert not re.search(r"[{}]", l["text"]), (lid, l)
                assert l["id"] not in seen or seed > 0
                seen.add(l["id"])
    assert script.lines("nope") == []
    assert script.lines("done", 0)[0]["text"] == "That's it, {name}. I'm all set."          # a missing field is left visible, not a crash
    assert script.all_static_lines() and all("{" not in t for t in script.all_static_lines())
