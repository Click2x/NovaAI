// Text box that appears over the avatar. Opened by Ctrl+Alt+Space or by clicking the avatar; Enter sends, Esc closes.
export function createInput({ box, field, onSubmit, onOpen, onClose }) {
  let open = false

  function show() {
    if (open) return
    open = true
    box.classList.add('show')
    onOpen()
    field.value = ''
    field.focus()
  }

  function hide() {
    if (!open) return
    open = false
    box.classList.remove('show')
    field.blur()
    onClose()
  }

  field.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hide(); return }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const text = field.value.trim()
      if (text) onSubmit(text)
      hide()
    }
  })

  return { show, hide, isOpen: () => open }
}
