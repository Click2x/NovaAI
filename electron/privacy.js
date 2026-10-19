// Which windows Nova may not look at. Same list as backend/services/screen_privacy.py (privacy-denylist.json).
// A private window: its title is never sent to the backend, and no screenshot is taken while it is in front.
const fs = require('fs')
const path = require('path')

const LIST_PATH = path.join(__dirname, 'privacy-denylist.json')
const STRICT_FALLBACK = {
  process_patterns: ['^(1password|bitwarden|keepass\\w*|lastpass|dashlane|nordpass|discord|signal|whatsapp|telegram)\\b'],
  title_patterns: ['\\b(in ?private|incognito|private (browsing|window))\\b', '\\bpass(word|words|key)\\b', '\\b(bank|banking|paypal)\\b'],
}

function compile(raw) {
  return {
    process: (raw.process_patterns || []).map((p) => new RegExp(p, 'i')),
    title: (raw.title_patterns || []).map((p) => new RegExp(p, 'i')),
  }
}

function load(file = LIST_PATH) {
  try { return compile(JSON.parse(fs.readFileSync(file, 'utf8'))) } catch { return compile(STRICT_FALLBACK) }
}

function processKey(name) {
  const n = String(name || '').trim().toLowerCase()
  return n.endsWith('.exe') ? n.slice(0, -4) : n
}

// An unknown window counts as private: if we cannot tell what is in front, we do not look.
function createPrivacy(lists = load()) {
  return {
    isPrivate(app, title) {
      const key = processKey(app)
      if (!key) return true
      if (lists.process.some((r) => r.test(key))) return true
      return !!title && lists.title.some((r) => r.test(title))
    },
  }
}

module.exports = { createPrivacy, processKey, load, compile }
