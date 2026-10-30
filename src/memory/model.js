// What the memory window shows, as pure functions: the groups, the search, the wording of where a fact came from and how old it is.
export const KINDS = [
  { id: 'identity', label: 'About you' },
  { id: 'preference', label: 'Likes and dislikes' },
  { id: 'boundary', label: 'Things to avoid' },
  { id: 'plan', label: 'Plans' },
  { id: 'fact', label: 'Other things I know' },
]
const KIND_IDS = new Set(KINDS.map((k) => k.id))

// An unknown kind (an older or hand-made row) lands in "Other things I know" instead of disappearing.
export const kindOf = (fact) => (KIND_IDS.has(fact && fact.kind) ? fact.kind : 'fact')

const SOURCES = {
  learned: 'I picked this up',
  user: 'You told me',
  onboarding: 'From setup',
  tool: 'I saved this',
  chat: 'From a chat',
}
export const sourceLabel = (source) => SOURCES[source] || 'From a chat'

// `ts` is the backend's time in seconds since the epoch.
export function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.floor(now / 1000 - Number(ts || 0)))
  if (!Number.isFinite(s) || !ts) return ''
  if (s < 90) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`
  const mo = Math.floor(d / 30)
  return mo < 12 ? `${mo} month${mo === 1 ? '' : 's'} ago` : `${Math.floor(mo / 12)} year${mo >= 24 ? 's' : ''} ago`
}

// Facts matching every word of `query` (case-insensitive), grouped in KINDS order; empty groups are left out. Newest first inside a group.
export function groupFacts(facts, query = '') {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean)
  const hit = (f) => { const t = String(f.text).toLowerCase(); return words.every((w) => t.includes(w)) }
  return KINDS
    .map((k) => ({ ...k, facts: (facts || []).filter((f) => kindOf(f) === k.id && hit(f)).sort((a, b) => (b.updated || 0) - (a.updated || 0)) }))
    .filter((g) => g.facts.length)
}

export function headline(count, shown, query) {
  if (!count) return 'I do not remember anything about you yet.'
  const base = `I remember ${count} thing${count === 1 ? '' : 's'} about you.`
  return query && shown !== count ? `${base} ${shown} match${shown === 1 ? 'es' : ''} your search.` : base
}

// The plain-text file the Export button writes: readable by a person, grouped like the window.
export function exportText(facts, now = new Date()) {
  const lines = [`What Nova remembers about you (exported ${now.toISOString().slice(0, 10)})`, '']
  for (const g of groupFacts(facts)) {
    lines.push(g.label, ...g.facts.map((f) => `- ${f.text}`), '')
  }
  if (lines.length === 2) lines.push('Nothing yet.', '')
  return lines.join('\n')
}
