// The memory window page: loads what she remembers, and lets the user search, add, edit, delete (with undo), switch learning on or off,
// export, and forget everything (asked twice).
import { createApi } from './api.js'
import { kindSelect, render } from './view.js'

const $ = (id) => document.getElementById(id)

async function main() {
  const shell = window.novaMemory
  const config = await shell.config()
  const api = createApi(config.httpBase)
  const refs = { headline: $('headline'), list: $('list'), notice: $('notice'), learn: $('learn'), clear: $('clear') }
  kindSelect($('add-kind'))

  const state = { facts: [], query: '', editing: null, error: '', notice: null, offline: false, autoLearn: true, confirmClear: false, now: Date.now() }
  let lastDeleted = null, noticeTimer = null

  const draw = () => { state.now = Date.now(); render(document.body, refs, state, handlers) }
  const say = (text, undo = false) => {
    clearTimeout(noticeTimer)
    state.notice = text ? { text, undo } : null
    if (text) noticeTimer = setTimeout(() => { state.notice = null; lastDeleted = null; draw() }, undo ? 10000 : 4000)
  }
  const fail = (r) => { state.error = r.offline ? '' : r.error; state.offline = !!r.offline }

  async function load() {
    const [m, s] = await Promise.all([api.list(), api.settings()])
    if (!m.ok) { state.offline = !!m.offline; state.error = m.offline ? '' : m.error; draw(); return }
    state.offline = false; state.error = ''
    state.facts = Array.isArray(m.facts) ? m.facts : []
    if (s.ok && s.memory) state.autoLearn = s.memory.auto_learn !== false
    draw()
  }

  const handlers = {
    edit(id) { state.editing = id; state.error = ''; draw() },
    cancel() { state.editing = null; draw() },
    async save(id, text, kind) {
      const r = await api.update(id, text, kind)
      if (!r.ok) { state.error = r.status === 404 ? 'That is too short, or I no longer have it.' : r.error; draw(); return }
      state.editing = null; state.error = ''
      await load()
    },
    async remove(id) {
      const f = state.facts.find((x) => x.id === id)
      const r = await api.remove(id)
      if (!r.ok) { fail(r); draw(); return }
      lastDeleted = f ? { text: f.text, kind: f.kind } : null
      say('Deleted.', !!lastDeleted)
      await load()
    },
    async undo() {
      if (!lastDeleted) return
      const back = lastDeleted
      lastDeleted = null
      await api.add(back.text, back.kind)
      say('Back again.')
      await load()
    },
    dismiss() { say(''); draw() },
  }

  $('search').addEventListener('input', (e) => { state.query = e.target.value; draw() })
  $('add').addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = $('add-text').value.trim()
    if (text.length < 3) { state.error = 'Tell me a little more than that.'; draw(); return }
    const r = await api.add(text, $('add-kind').value)
    if (!r.ok) { state.error = r.offline ? 'I cannot reach my backend.' : r.error; draw(); return }
    $('add-text').value = ''
    state.error = ''
    say('Remembered.')
    await load()
  })
  refs.learn.addEventListener('change', async () => {
    const r = await api.setAutoLearn(refs.learn.checked)
    if (!r.ok) { refs.learn.checked = !refs.learn.checked; state.error = r.offline ? 'I cannot reach my backend.' : r.error }
    else { state.autoLearn = refs.learn.checked; say(state.autoLearn ? 'I will keep learning from our chats.' : 'I will only remember what you ask me to.') }
    draw()
  })
  $('export').addEventListener('click', async () => {
    const r = await shell.exportFacts()
    if (r && r.ok) say(`Saved to ${r.name}.`)
    else if (r && !r.canceled) { state.error = (r && r.error) || 'I could not save that.' }
    draw()
  })
  refs.clear.addEventListener('click', async () => {
    if (!state.confirmClear) {
      state.confirmClear = true
      draw()
      setTimeout(() => { if (state.confirmClear) { state.confirmClear = false; draw() } }, 5000)
      return
    }
    state.confirmClear = false
    const r = await api.clear()
    if (!r.ok) { fail(r); draw(); return }
    say(`Forgot ${r.deleted} thing${r.deleted === 1 ? '' : 's'}.`)
    await load()
  })
  window.addEventListener('focus', load)         // she may have learned something while the window was behind another

  await load()
}

main().catch((e) => { document.getElementById('headline').textContent = 'Something went wrong opening this window.'; console.error(e) })
