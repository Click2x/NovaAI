// Phase 8: may a proactive message (one she starts herself: reminder, outreach, alert) be spoken aloud, and may it pop up at all?
// Pure functions, tested with node --test. The settings are the user's (proactive.speak, proactive.quiet*), never hardcoded here.
//
//   speak 'off'                          never speaks (default; roadmap D12)
//   speak 'when_visible_and_not_fullscreen'  speaks only while her window is showing, nothing is fullscreen in front, speech is on,
//                                        she is not already talking, and it is not quiet hours
//   quiet hours (start-end, may wrap midnight): nothing speaks and nothing pops up; cards wait in the notification centre

export const SPEAK_MODES = ['off', 'when_visible_and_not_fullscreen']

// "HH:MM" -> minutes since midnight, or null.
export function parseClock(text) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text == null ? '' : text).trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

// `now` is a Date (local time). An equal start and end is an empty window, not a whole day. An unparsable bound means "not quiet".
export function inQuietHours({ quietEnabled, quietStart, quietEnd }, now = new Date()) {
  if (!quietEnabled) return false
  const a = parseClock(quietStart)
  const b = parseClock(quietEnd)
  if (a === null || b === null || a === b) return false
  const t = now.getHours() * 60 + now.getMinutes()
  return a < b ? t >= a && t < b : t >= a || t < b
}

// ctx: { now: Date, visible: bool, fullscreen: true|false|null (null = unknown, e.g. window tracking is off), ttsOn: bool, talking: bool }
// Returns { speak, pop, reason } - `reason` is a short code for the log and the tests.
export function decideProactive(rule, ctx = {}) {
  const quiet = inQuietHours(rule || {}, ctx.now || new Date())
  if (quiet) return { speak: false, pop: false, reason: 'quiet_hours' }
  if (!rule || rule.speak !== 'when_visible_and_not_fullscreen') return { speak: false, pop: true, reason: 'speak_off' }
  if (!ctx.ttsOn) return { speak: false, pop: true, reason: 'tts_off' }
  if (!ctx.visible) return { speak: false, pop: true, reason: 'hidden' }
  if (ctx.fullscreen === null || ctx.fullscreen === undefined) return { speak: false, pop: true, reason: 'fullscreen_unknown' }
  if (ctx.fullscreen) return { speak: false, pop: true, reason: 'fullscreen' }
  if (ctx.talking) return { speak: false, pop: true, reason: 'already_talking' }
  return { speak: true, pop: true, reason: 'ok' }
}
