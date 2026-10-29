import pytest

from novaai.voicein import interpret


@pytest.mark.parametrize("text,keyword,command", [
    ("Nova", "wake", ""),
    ("Hey Nova.", "wake", ""),
    ("Nova, what time is it?", "wake", "what time is it?"),
    ("okay nova turn the volume down", "wake", "turn the volume down"),
    ("Hello, Nova! Tell me a joke", "wake", "Tell me a joke"),
])
def test_wake_purpose_needs_her_name_first(text, keyword, command):
    h = interpret("wake", text)
    assert (h.keyword, h.command, h.ignored) == (keyword, command, "")
    assert h.starts_turn is bool(command) and (not command or h.prompt == command)


@pytest.mark.parametrize("text", ["what time is it", "the novae are exploding", "I said nothing", "Thank you."])
def test_wake_purpose_ignores_everything_else(text):
    h = interpret("wake", text)
    assert h.ignored in ("no_wake_word", "empty") and not h.starts_turn


def test_command_purpose_takes_the_whole_utterance_and_drops_her_name():
    h = interpret("command", "what's the weather like")
    assert (h.keyword, h.ignored, h.starts_turn, h.prompt) == ("", "", True, "what's the weather like")
    assert interpret("command", "Nova, what's the weather like").prompt == "what's the weather like"
    assert interpret("command", "Nova").prompt == "Nova"                 # her name alone is a message, not a wake-up


def test_stop_and_sleep_words_work_in_every_purpose():
    for purpose in ("command", "keyword"):
        assert interpret(purpose, "Stop.").keyword == "stop"
        assert interpret(purpose, "nova, be quiet").keyword == "stop"
        assert interpret(purpose, "Go to sleep").keyword == "sleep"
        assert interpret(purpose, "Stop").starts_turn is False
    assert interpret("wake", "stop").ignored == "no_wake_word"             # asleep: nothing to stop


def test_keyword_purpose_ignores_her_own_voice_leaking_into_the_microphone():
    h = interpret("keyword", "It is a lovely day, isn't it? Let me stop and think about it.")
    assert h.ignored == "not_a_keyword" and not h.starts_turn


def test_silence_hallucinations_and_bad_purposes():
    for t in ("", "   ", "you", "Thank you.", "...", "Thanks for watching!"):
        assert interpret("command", t).ignored == "empty"
    assert interpret("shout", "hello").ignored == "bad_purpose"
