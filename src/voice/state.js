// Voice state machine: IDLE (asleep, waiting for the wake word), LISTENING (awake, the next utterance is a command),
// THINKING (a turn is running, nothing audible yet), SPEAKING (Nova's voice is playing).
// Pure logic with an injectable clock so it can be tested with `node --test` (no DOM, no audio).
//
// The state is derived from three facts (awake / turn running / audio playing) instead of being stored, so the events can arrive in any
// order (turn_end reaches the app before the last sentence finishes playing) and the state still comes out right.
export const IDLE = 'IDLE'
export const LISTENING = 'LISTENING'
export const THINKING = 'THINKING'
export const SPEAKING = 'SPEAKING'

export const DEFAULTS = {
  wakeWindowMs: 15000,     // after the wake word alone: how long she waits for the command before going back to sleep
  followUpMs: 30000,       // after a reply: how long she keeps listening without the wake word (a conversation, not a command)
  echoMode: 'speakers',    // 'speakers': only the stop word is accepted while she talks; 'headphones': any speech interrupts her
}

export function createVoiceState(opts = {}, hooks = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const now = hooks.now || (() => Date.now())
  let awake = false
  let awakeUntil = 0
  let turnActive = false
  let playing = false
  let enabled = true
  let last = IDLE

  const compute = () => {
    if (!enabled) return IDLE
    if (playing) return SPEAKING
    if (turnActive) return THINKING
    if (awake && now() <= awakeUntil) return LISTENING
    return IDLE
  }
  // Re-derive and tell the listener when the state changed. Every method below ends here.
  const settle = () => {
    if (awake && !turnActive && !playing && now() > awakeUntil) awake = false
    const s = compute()
    if (s !== last) { const from = last; last = s; hooks.onChange && hooks.onChange(s, from) }
    return s
  }
  const stayAwake = (ms) => { awake = true; awakeUntil = Math.max(awakeUntil, now() + ms) }

  return {
    state: () => settle(),
    config: () => ({ ...cfg }),
    setEchoMode(mode) { if (mode === 'speakers' || mode === 'headphones') cfg.echoMode = mode },
    setEnabled(on) { enabled = !!on; return settle() },
    // The wake word was heard. With a command in the same breath the turn starts next (turnStarted), so the window is the follow-up one.
    wake(withCommand = false) { stayAwake(withCommand ? cfg.followUpMs : cfg.wakeWindowMs); return settle() },
    sleep() { awake = false; awakeUntil = 0; return settle() },
    // Typed text or a heard command: a turn begins.
    turnStarted() { stayAwake(cfg.followUpMs); turnActive = true; return settle() },
    turnEnded() { turnActive = false; stayAwake(cfg.followUpMs); return settle() },
    audioStarted() { playing = true; return settle() },
    audioEnded() { playing = false; stayAwake(cfg.followUpMs); return settle() },
    // Stop word, hotkey or click: everything stops, she stays awake for what comes next.
    interrupted() { turnActive = false; playing = false; awakeUntil = 0; stayAwake(cfg.wakeWindowMs); return settle() },
    // Call about once a second so an expired window sends her back to sleep.
    tick() { return settle() },
    // What a freshly cut-out utterance is for, given what she is doing right now. The backend uses it to decide what to look for.
    purpose() {
      switch (settle()) {
        case IDLE: return 'wake'
        case LISTENING: return 'command'
        case THINKING: return 'keyword'
        default: return cfg.echoMode === 'headphones' ? 'command' : 'keyword'   // SPEAKING
      }
    },
    // Whether speech should be cut out and sent at all.
    wantsAudio() { return enabled },
  }
}
