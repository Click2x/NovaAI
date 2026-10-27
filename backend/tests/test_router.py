from novaai import registry, router, settings
from novaai.hardware import Hardware, detect
from novaai.router import Router, preferred_variant, route_turn

ENTRIES = registry.load()
BIG = Hardware("RTX 3090", 24.0, 64.0)
MID = Hardware("RTX 3060", 12.0, 32.0)
LOW = Hardware("GTX 1650", 4.0, 16.0)
CPU = Hardware("", 0.0, 16.0)


def S(**patch):
    return settings.merge(settings.sanitize(None), patch)


def test_registry_loads_every_entry_and_has_both_origins_and_variants():
    assert len(ENTRIES) >= 15
    tools = [e for e in ENTRIES if "tools" in e.roles]
    assert {e.origin for e in tools} >= {"US", "CN"}
    assert {e.variant for e in tools} == {"regular", "abliterated"}
    for origin in ("US", "CN"):
        for variant in ("regular", "abliterated"):
            assert any(e.origin == origin and e.variant == variant for e in tools), (origin, variant)
    assert len({e.id for e in ENTRIES}) == len(ENTRIES)


def test_user_registry_file_adds_and_replaces_and_bad_entries_are_skipped(tmp_path):
    f = tmp_path / "models.json"
    f.write_text('{"models":[{"id":"mine","tag":"my/model:1","roles":["tools"],"variant":"regular","vram_gb":3,"origin":"US"},'
                 '{"id":"nemo-regular","tag":"mistral-nemo:custom","roles":["voice"],"variant":"regular","vram_gb":8},'
                 '{"id":"bad"},{"id":"bad2","tag":"x","roles":["nope"]},"junk"]}')
    got = {e.id: e for e in registry.load(f)}
    assert got["mine"].tag == "my/model:1"
    assert got["nemo-regular"].tag == "mistral-nemo:custom"
    assert "bad" not in got and "bad2" not in got
    assert registry.load(tmp_path / "missing.json")      # the shipped file still loads


def test_voice_is_mistral_nemo_on_a_normal_machine():
    p = Router(ENTRIES, BIG, set()).pick("voice", S())
    assert p.best.family == "Mistral NeMo" and p.best.variant == "regular"


def test_variant_follows_the_harm_filter_and_adult_confirmation():
    assert preferred_variant(S()) == "regular"
    assert preferred_variant(S(safety={"enabled": False})) == "regular"                       # filter off but nobody confirmed 18+
    assert preferred_variant(S(safety={"enabled": False, "adult_confirmed": True})) == "abliterated"
    assert preferred_variant(S(models={"variant": "abliterated"})) == "abliterated"
    assert preferred_variant(S(models={"variant": "regular"}, safety={"enabled": False, "adult_confirmed": True})) == "regular"
    r = Router(ENTRIES, BIG, set())
    off = S(safety={"enabled": False, "adult_confirmed": True})
    assert r.pick("voice", off).best.variant == "abliterated"
    assert r.pick("tools", off).best.variant == "abliterated"


def test_tools_origin_preference_us_and_cn():
    r = Router(ENTRIES, BIG, set())
    assert r.pick("tools", S(models={"tools_origin": "US"})).best.origin == "US"
    assert r.pick("tools", S(models={"tools_origin": "CN"})).best.origin == "CN"
    us_abl = r.pick("tools", S(models={"tools_origin": "US", "variant": "abliterated"})).best
    assert (us_abl.origin, us_abl.variant) == ("US", "abliterated")
    cn_abl = r.pick("tools", S(models={"tools_origin": "CN", "variant": "abliterated"})).best
    assert (cn_abl.origin, cn_abl.variant) == ("CN", "abliterated")


def test_installed_models_rank_before_downloads():
    cn = next(e for e in ENTRIES if e.id == "qwen2.5-7b")
    p = Router(ENTRIES, BIG, {cn.tag}).pick("tools", S())
    assert p.best.id == "qwen2.5-7b"
    assert Router(ENTRIES, BIG, set()).pick("tools", S()).best.id != "qwen2.5-7b"      # nothing installed: best quality wins


def test_everything_chosen_fits_the_budget_for_every_tier():
    for hw in (BIG, MID, LOW, CPU):
        r = Router(ENTRIES, hw, set())
        for role in ("voice", "tools"):
            for variant in ("regular", "abliterated"):
                for e in r.pick(role, S(models={"variant": variant})).candidates:
                    assert e.vram_gb <= hw.budget_gb, (hw.tier, role, e.id)


def test_small_machines_get_small_models_and_one_download():
    plan = Router(ENTRIES, LOW, set()).plan(S())
    assert plan["voice"]["vram_gb"] <= LOW.budget_gb
    assert len(plan["download"]) == 1
    assert Router(ENTRIES, CPU, set()).plan(S())["voice"]["vram_gb"] <= CPU.budget_gb


def test_plan_on_a_big_card_names_two_models_and_marks_installed():
    inst = {next(e for e in ENTRIES if e.id == "nemo-abliterated").tag}
    plan = Router(ENTRIES, BIG, inst).plan(S(safety={"enabled": False, "adult_confirmed": True}))
    assert any(d["installed"] for d in plan["download"])
    assert plan["download_gb"] >= 0


def test_user_override_goes_first_and_unfit_machine_is_reported():
    p = Router(ENTRIES, BIG, set()).pick("tools", S(models={"tools_override": "somebody/custom:7b"}))
    assert p.best.tag == "somebody/custom:7b"
    assert any("set by the user" in r for r in p.reasons)
    tiny = Router(ENTRIES, Hardware("", 0.0, 2.0), set()).pick("voice", S())
    assert tiny.candidates == [] and any("fits" in r for r in tiny.reasons)


def test_falls_back_to_the_other_variant_and_says_so():
    only_regular = [e for e in ENTRIES if e.variant == "regular"]
    p = Router(only_regular, BIG, set()).pick("tools", S(models={"variant": "abliterated"}))
    assert p.best.variant == "regular" and any("using regular" in r for r in p.reasons)


def test_route_turn_table():
    for t in ("remind me to call mum at 6", "Remember that I hate cilantro", "what time is it", "what do you remember about my job?", "set a timer for 10 minutes"):
        assert route_turn(t) == "tool", t
    for t in ("how was your day", "", "   ", "tell me a story", "I remember when we met"):
        assert route_turn(t) == "chat", t


def test_detect_survives_missing_nvidia_smi_and_parses_the_biggest_gpu():
    def boom(*a, **k):
        raise FileNotFoundError

    assert detect(boom).vram_gb == 0.0 and detect(boom).tier == "cpu"

    class R:
        returncode = 0
        stdout = "NVIDIA GeForce GTX 1050, 2048\nNVIDIA GeForce RTX 3090, 24576\n"

    hw = detect(lambda *a, **k: R())
    assert (hw.gpu_name, hw.vram_gb, hw.tier) == ("NVIDIA GeForce RTX 3090", 24.0, "high")


def test_settings_sanitize_patch_and_persistence(tmp_path):
    base = settings.sanitize(None)
    assert settings.sanitize({"safety": {"categories": {"self_harm": "nope", "violence_weapons": "allow"}}})["safety"]["categories"]["self_harm"] == "care"
    assert settings.sanitize({"models": {"ollama_url": "ftp://x"}})["models"]["ollama_url"] == base["models"]["ollama_url"]
    assert settings.sanitize({"persona": {"warmth": 9, "interests": ["a", "A", " ", 5]}})["persona"] == {**base["persona"], "warmth": 1.0, "interests": ["a"]}
    assert "minors_sexual" not in base["safety"]["categories"]
    st = settings.SettingsStore(tmp_path / "s.json")
    st.patch({"user": {"name": "Sam"}, "safety": {"categories": {"hate_harassment": "allow"}}})
    again = settings.SettingsStore(tmp_path / "s.json").get()
    assert again["user"]["name"] == "Sam" and again["safety"]["categories"]["hate_harassment"] == "allow"
    assert again["safety"]["categories"]["self_harm"] == "care"
    (tmp_path / "s.json").write_text("{not json")
    assert settings.SettingsStore(tmp_path / "s.json").get() == base
    assert (tmp_path / "s.bad").exists()
