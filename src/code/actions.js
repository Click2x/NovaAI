// Phase 13: outgoing agent messages and the small pure helpers around them (diff parsing, rule labels). Protocol v1: every message has v:1.
// No DOM here; tested with node --test.

export const PROTOCOL = 1
const msg = (type, fields = {}) => ({ v: PROTOCOL, type, ...fields })

export const start = ({ workspace, resume, mode, model } = {}) => msg('start', {
  ...(workspace ? { workspace } : {}), ...(resume ? { resume } : {}), ...(mode ? { mode } : {}), ...(model ? { model } : {}),
})
export const prompt = (text, prompt_id) => msg('prompt', { text, ...(prompt_id ? { prompt_id } : {}) })
export const interrupt = () => msg('interrupt')
export const setMode = (mode) => msg('set_mode', { mode })
export const sessions = () => msg('sessions')
export const tree = (path) => msg('tree', path && path !== '.' ? { path } : {})
export const ping = () => msg('ping')
export const hooksTrust = (hash, trust) => msg('hooks_trust', { hash, trust: !!trust })
export const checkpoints = () => msg('checkpoints')
export const rewindPreview = (prompt_index) => msg('rewind_preview', { prompt_index })
export const rewind = (prompt_index, scope = 'both', force = false) => msg('rewind', { prompt_index, scope, ...(force ? { force: true } : {}) })

// choice: 'once' | 'session' | 'always' | 'deny' | 'deny_always'. Remembering needs a suggested rule (the backend turns it into allow/deny).
export function permissionResponse(req, choice, feedback) {
  if (req.kind === 'question') return msg('permission_response', { id: req.id, answer: String(feedback ?? '') })
  const base = { id: req.id }
  switch (choice) {
    case 'once': return msg('permission_response', { ...base, decision: 'allow' })
    case 'session': return msg('permission_response', { ...base, decision: 'allow', remember: 'session' })
    case 'always': return msg('permission_response', { ...base, decision: 'allow', remember: 'local' })
    case 'deny_always': return msg('permission_response', { ...base, decision: 'deny', remember: 'local', ...(feedback ? { feedback } : {}) })
    default: return msg('permission_response', { ...base, decision: 'deny', ...(feedback ? { feedback } : {}) })
  }
}

// Which choices the card may offer: remembering is only possible when a rule could safely cover the call (not for compound shell commands
// or anything side-effecting while tainted).
export function approvalChoices(req) {
  if (req.kind === 'question') return []
  const out = [{ id: 'once', label: 'Allow once' }]
  if (req.suggested_rule) {
    out.push({ id: 'session', label: 'Allow for this session' }, { id: 'always', label: 'Always allow' })
  }
  out.push({ id: 'deny', label: 'Deny' })
  if (req.suggested_rule) out.push({ id: 'deny_always', label: 'Always deny' })
  return out
}

export function ruleNote(req) {
  if (!req.suggested_rule) return req.tainted ? 'No rule can be saved while untrusted web content is in this session.' : 'This command is too broad to save as a rule.'
  return `Rule: ${req.suggested_rule}`
}

export const planResponse = (plan, approved, { mode, feedback } = {}) => msg('plan_response', {
  id: plan.id, approved: !!approved, ...(approved && mode ? { mode } : {}), ...(!approved && feedback ? { feedback } : {}),
})

// Unified diff text -> [{ kind: 'add'|'del'|'hunk'|'meta'|'ctx', text }] for colouring; capped so a huge diff cannot freeze the window.
export function parseDiff(text, maxLines = 400) {
  const out = []
  const lines = String(text || '').split('\n')
  for (const raw of lines) {
    if (out.length >= maxLines) { out.push({ kind: 'meta', text: `... ${lines.length - maxLines} more lines` }); break }
    if (raw === '' && out.length === lines.length - 1) continue
    let kind = 'ctx'
    if (raw.startsWith('+++') || raw.startsWith('---')) kind = 'meta'
    else if (raw.startsWith('@@')) kind = 'hunk'
    else if (raw.startsWith('+')) kind = 'add'
    else if (raw.startsWith('-')) kind = 'del'
    out.push({ kind, text: raw })
  }
  return out
}

export function diffStat(text) {
  let add = 0, del = 0
  for (const l of String(text || '').split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue
    if (l.startsWith('+')) add++
    else if (l.startsWith('-')) del++
  }
  return { add, del }
}
