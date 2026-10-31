"""Score a routing decider on backend/tests/routing_cases.json.

  backend\\.build-venv\\Scripts\\python.exe tools\\eval-routing.py --decider phrase
  backend\\.build-venv\\Scripts\\python.exe tools\\eval-routing.py --decider json --model qwen2.5:7b
  backend\\.build-venv\\Scripts\\python.exe tools\\eval-routing.py --decider kev --kev-url http://127.0.0.1:8009
      (needs a running `python -m kev.serve --run jaredpalmer/kev-0.8b --port 8009`)

Prints: how often it was right about NEEDING a tool (the gate), how often it named the right tool, accuracy for each tag (trap, lang, indirect,
ambiguous), speed (p50 / p95 milliseconds), and every miss. --out writes the same as JSON so runs can be compared.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from novaai.decide import ANY, CATALOG, JsonDecider, KevDecider, PhraseDecider  # noqa: E402
from novaai.llm import OllamaClient  # noqa: E402


def load_cases() -> list[dict]:
    return json.loads((ROOT / "backend" / "tests" / "routing_cases.json").read_text(encoding="utf-8"))["cases"]


def pct(n: int, d: int) -> str:
    return f"{100 * n / d:5.1f}%" if d else "  n/a"


def score(cases: list[dict], decisions: list) -> dict:
    gate_ok = pick_ok = 0
    tp = fp = fn = 0
    tags: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    misses = []
    for c, d in zip(cases, decisions):
        want = None if c["expect"] == "none" else c["expect"]
        got = d.tool
        g = (got is not None) == (want is not None)
        p = got == want or (got == ANY and want is not None)        # a gate-only decider cannot be wrong about WHICH tool; it is excluded below
        gate_ok += g
        pick_ok += (got == want)
        tp += got is not None and want is not None
        fp += got is not None and want is None
        fn += got is None and want is not None
        for t in [c.get("tag", "plain")]:
            tags[t][0] += g
            tags[t][1] += 1
        if got != want and not (got == ANY and want is not None):
            misses.append({"text": c["text"], "want": want or "none", "got": got or "none", "raw": d.raw})
    ms = sorted(d.ms for d in decisions)
    return {
        "cases": len(cases), "gate_ok": gate_ok, "pick_ok": pick_ok, "tp": tp, "fp": fp, "fn": fn,
        "tags": {k: v for k, v in tags.items()},
        "p50_ms": int(statistics.median(ms)) if ms else 0, "p95_ms": ms[int(len(ms) * 0.95) - 1] if ms else 0,
        "misses": misses,
    }


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--decider", choices=["phrase", "json", "kev"], default="phrase")
    ap.add_argument("--kev-url", default="http://127.0.0.1:8009", help="a running `python -m kev.serve` for --decider kev")
    ap.add_argument("--model", default="qwen2.5:7b", help="Ollama tag for --decider json")
    ap.add_argument("--ollama", default="http://127.0.0.1:11434")
    ap.add_argument("--only-built", action="store_true", help="judge against the tools that exist today (drop cases that expect a planned tool)")
    ap.add_argument("--out", help="write the result as JSON to this file")
    a = ap.parse_args()

    cases = load_cases()
    if a.only_built:
        built = {t.name for t in CATALOG if t.built}
        cases = [c for c in cases if c["expect"] == "none" or c["expect"] in built]
    catalog = [t for t in CATALOG if t.built] if a.only_built else CATALOG

    if a.decider == "phrase":
        decider = PhraseDecider()
    elif a.decider == "kev":
        decider = KevDecider(a.kev_url)
        await decider.decide("hi", catalog)            # first request warms the server
    else:
        llm = OllamaClient(lambda: a.ollama)
        decider = JsonDecider(llm, a.model)
        await llm.complete(a.model, [{"role": "user", "content": "hi"}], options={"num_predict": 1}, think=False)   # load the model before timing
    decisions = []
    for c in cases:
        decisions.append(await decider.decide(c["text"], catalog))

    r = score(cases, decisions)
    n = r["cases"]
    print(f"\ndecider: {decider.name}   cases: {n}{'  (built tools only)' if a.only_built else ''}")
    print(f"needs a tool? (gate)   {pct(r['gate_ok'], n)}   precision {pct(r['tp'], r['tp'] + r['fp'])}   recall {pct(r['tp'], r['tp'] + r['fn'])}")
    if a.decider != "phrase":
        print(f"right tool, exactly    {pct(r['pick_ok'], n)}")
    print(f"speed                  p50 {r['p50_ms']} ms   p95 {r['p95_ms']} ms")
    print("by tag (gate):         " + "   ".join(f"{k} {pct(v[0], v[1])} ({v[1]})" for k, v in sorted(r["tags"].items())))
    if r["misses"]:
        print(f"\nmisses ({len(r['misses'])}):")
        for m in r["misses"]:
            print(f"  want {m['want']:<14} got {m['got']:<14} {m['text']}")
    if a.out:
        Path(a.out).write_text(json.dumps({"decider": decider.name, **r}, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
