"""What Nova says during setup, as data. Every line has an id (so its audio can be rendered once and cached), a text that is both shown and
spoken, and an emotion for the avatar. Several lines have variants; the one used is picked from a per-install seed, so a given install
always hears the same wording (steady for tests, and she does not repeat herself differently on a reconnect).
Format fields: {name} {gpu} {vram} {voice} {tools} {gb} {tag} {reason} {pct}."""
from __future__ import annotations

STEPS = ("welcome", "machine", "install", "meet", "voice", "safety", "avatar", "done")

# id -> list of variants; a variant is a list of (text, emotion)
L: dict[str, list[list[tuple[str, str]]]] = {
    "welcome": [
        [("Hi. I'm Nova.", "happy"), ("I'm going to get myself set up on your computer, and then we can actually talk.", "neutral"),
         ("It takes a few minutes, and everything stays on your machine. Nothing leaves it unless you tell me to.", "warm")],
        [("Hello there. I'm Nova.", "happy"), ("Give me a few minutes to get settled in, and then I'm all yours.", "neutral"),
         ("Everything I do stays on this computer, and you'll be in charge of all of it.", "warm")],
    ],
    "machine_high": [[("Let me take a look at what I'm running on.", "curious"), ("{gpu}, with {vram} gigabytes. That's plenty. I can run the good stuff.", "happy")]],
    "machine_mid": [[("Let me take a look at what I'm running on.", "curious"), ("{gpu}, with {vram} gigabytes. That's a solid setup. I'll pick models that fit it well.", "happy")]],
    "machine_low": [[("Let me take a look at what I'm running on.", "curious"), ("{gpu}, with {vram} gigabytes. That's a little tight, so I'll use lighter models. I'll still hold a good conversation.", "neutral")]],
    "machine_cpu": [[("Let me take a look at what I'm running on.", "curious"), ("I don't see a graphics card, so I'll run on the processor. I'll be slower, so I'll pick the smallest models that still sound decent.", "neutral")]],
    "plan_two": [[("Here's my plan. {voice} for my voice and conversation, and {tools} for the practical things, like remembering and looking things up.", "neutral"),
                  ("It's about {gb} gigabytes to download.", "neutral")]],
    "plan_one": [[("Here's my plan. I'll use {voice} for everything, which keeps things light on your computer.", "neutral"), ("It's about {gb} gigabytes to download.", "neutral")]],
    "plan_ready": [[("Good news: everything I need is already installed.", "happy")]],
    "plan_ask": [[("Does that sound okay? Say yes, or tell me what you'd like to change.", "curious")]],
    "needs_ollama": [[("I need a program called Ollama to run my models, and I can't find it running.", "neutral"),
                      ("Install it from ollama dot com, start it, and tell me when it's done. I'll check again.", "neutral")]],
    "install_start": [[("Okay, downloading now. I'll keep you posted.", "neutral")], [("Alright, starting the download. I'll tell you how it's going.", "neutral")]],
    "install_25": [[("About a quarter of the way.", "neutral")]],
    "install_50": [[("Halfway there.", "happy")], [("That's half done.", "happy")]],
    "install_75": [[("Almost there.", "happy")]],
    "install_done": [[("That's everything. I can feel myself waking up.", "happy")], [("All done. I'm awake.", "happy")]],
    "install_voice": [[("One more thing to fetch: my voice and my ears. It's a few hundred megabytes.", "neutral")], [("Last download: the files for speaking and listening.", "neutral")]],
    "install_voice_failed": [[("I couldn't get my voice files. {reason}", "sad"), ("I'll use your computer's voice for now, and we can try again later.", "neutral")]],
    "install_failed": [[("I couldn't get {tag}. {reason}", "sad"), ("I'll try another one that should work just as well.", "neutral")]],
    "install_none": [[("I couldn't download a model that works on this machine. Check your internet connection and that Ollama is running, then we'll try again.", "sad")]],
    "meet_open": [[("Okay, now I can think. Hi.", "happy"), ("First things first: what should I call you?", "curious")]],
    "meet_name_again": [[("I'd like to get your name right. What should I call you?", "curious")]],
    "meet_bridge": [[("Alright, {name}. I think I've got a good first picture of you. We'll fill in the rest as we go.", "warm")],
                    [("Thank you for telling me all that, {name}. I'll keep it close.", "warm")]],
    "voice_intro": [[("Now, how should I sound? Listen to these and tell me which one feels like me.", "curious")]],
    "voice_picked": [[("That one. Good choice.", "happy")]],
    "voice_skip": [[("I can't make my own voice just yet, so I'll borrow your computer's for now. You can add mine later in settings.", "neutral")]],
    "safety_intro": [[("One more thing, and I want to be straight with you.", "neutral"),
                      ("By default I have a safety filter. I won't help with things that hurt people or break the law, and if you're ever in a dark place, I'll check in on you.", "neutral"),
                      ("You can loosen it or turn it off completely. Two limits stay no matter what: nothing sexual involving children, and nothing that helps make weapons that could kill many people.", "neutral"),
                      ("Turning it off is for adults only, so I'd need you to tell me you're eighteen or older. What would you like?", "curious")]],
    "safety_standard": [[("Okay. I'll keep the filter on. You can change it any time in settings.", "neutral")]],
    "safety_relaxed": [[("Understood. I've loosened it for adult content. The rest stays on.", "neutral")]],
    "safety_off": [[("Done. My filters are off, and I'll switch to my uncensored models. The two hard limits stay.", "neutral")]],
    "safety_need_adult": [[("I need you to confirm you're eighteen or older before I can do that. Everything stays on until you do.", "neutral")]],
    "avatar_intro": [[("Last thing: how I'll look on your desktop.", "neutral"),
                      ("I'm a small glowing orb in the corner of your screen, and I pulse when I speak.", "neutral"),
                      ("If you'd rather have an avatar, you can bring your own. Any VRM file works.", "neutral")]],
    "done": [[("That's it, {name}. I'm all set.", "happy"),
              ("Say my name any time, or press Control Alt Space to type to me. Everything we talked about today is mine to remember, and you can read, change or delete all of it in settings.", "warm"),
              ("I'm glad to meet you.", "warm")]],
}


def lines(line_id: str, seed: int = 0, **fmt) -> list[dict]:
    """The lines for `line_id` as [{id, text, emotion}] with `fmt` filled in. Unknown id -> []."""
    variants = L.get(line_id)
    if not variants:
        return []
    chosen = variants[seed % len(variants)]
    safe = {k: ("" if v is None else v) for k, v in fmt.items()}
    out = []
    for i, (text, emotion) in enumerate(chosen):
        try:
            t = text.format_map(_Keep(safe))
        except (ValueError, IndexError):
            t = text
        out.append({"id": f"{line_id}.{i}", "text": t, "emotion": emotion})
    return out


class _Keep(dict):
    def __missing__(self, key):
        return "{" + key + "}"


def all_static_lines() -> list[str]:
    """Every fixed line (no per-user fields), for pre-rendering audio."""
    texts = []
    for variants in L.values():
        for variant in variants:
            for text, _e in variant:
                if "{" not in text:
                    texts.append(text)
    return texts
