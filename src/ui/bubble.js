// Speech bubble: shows Nova's reply as it streams, fades out some seconds after the turn ends.
const LINGER_MS = 7000

export function createBubble(el) {
  let timer = null
  let sentences = []

  function render() {
    el.textContent = sentences.join(' ')
    el.classList.toggle('show', sentences.length > 0)
    el.scrollTop = el.scrollHeight
  }

  return {
    startTurn() {
      clearTimeout(timer)
      sentences = []
      render()
    },
    addSentence(text) {
      clearTimeout(timer)
      sentences.push(text)
      render()
    },
    // Shows a complete message (proactive or error) and schedules its fade.
    say(text) {
      clearTimeout(timer)
      sentences = [text]
      render()
      this.fadeSoon()
    },
    fadeSoon(ms = LINGER_MS) {
      clearTimeout(timer)
      timer = setTimeout(() => { sentences = []; render() }, ms)
    },
  }
}
