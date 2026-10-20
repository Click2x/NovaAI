// Event bus for backend messages: each module subscribes to the types it cares about with on(type, fn) instead of one switch in main.js.
// A handler that throws is logged and does not stop the others or the socket.
export function createEvents({ onError = (err, msg) => console.error('event handler failed', msg && msg.type, err) } = {}) {
  const handlers = new Map()   // type -> Set<fn>

  function on(type, fn) {
    if (typeof type !== 'string' || typeof fn !== 'function') throw new TypeError('on(type, fn)')
    if (!handlers.has(type)) handlers.set(type, new Set())
    handlers.get(type).add(fn)
    return () => handlers.get(type) && handlers.get(type).delete(fn)   // unsubscribe
  }

  // Handlers run in the order they subscribed. Returns how many ran (0 = nobody cares about this type).
  function emit(msg) {
    if (!msg || typeof msg.type !== 'string') return 0
    const set = handlers.get(msg.type)
    if (!set) return 0
    let n = 0
    for (const fn of [...set]) {
      n++
      try { fn(msg) } catch (err) { onError(err, msg) }
    }
    return n
  }

  return { on, emit }
}
