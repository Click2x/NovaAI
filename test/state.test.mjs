import test from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceState, IDLE, LISTENING, THINKING, SPEAKING } from '../src/voice/state.js'

function make(opts) {
  const clock = { t: 1000 }
  const changes = []
  const v = createVoiceState(opts, { now: () => clock.t, onChange: (s, from) => changes.push(`${from}>${s}`) })
  return { v, clock, changes }
}

test('starts asleep and asks for the wake word', () => {
  const { v } = make()
  assert.equal(v.state(), IDLE)
  assert.equal(v.purpose(), 'wake')
})

test('wake word -> listening for a command -> turn -> thinking -> speaking -> listening again', () => {
  const { v, changes } = make()
  v.wake()
  assert.equal(v.state(), LISTENING)
  assert.equal(v.purpose(), 'command')
  v.turnStarted()
  assert.equal(v.state(), THINKING)
  assert.equal(v.purpose(), 'keyword')
  v.audioStarted()
  assert.equal(v.state(), SPEAKING)
  v.turnEnded() // turn_end arrives while the last sentence is still playing
  assert.equal(v.state(), SPEAKING)
  v.audioEnded()
  assert.equal(v.state(), LISTENING)
  assert.deepEqual(changes, ['IDLE>LISTENING', 'LISTENING>THINKING', 'THINKING>SPEAKING', 'SPEAKING>LISTENING'])
})

test('audio can end before turn_end without leaving SPEAKING early or THINKING late', () => {
  const { v } = make()
  v.wake(); v.turnStarted(); v.audioStarted(); v.audioEnded()
  assert.equal(v.state(), THINKING) // the turn is still running (more sentences may come)
  v.turnEnded()
  assert.equal(v.state(), LISTENING)
})

test('the wake window closes after wakeWindowMs of silence', () => {
  const { v, clock } = make({ wakeWindowMs: 5000 })
  v.wake()
  clock.t += 4900
  assert.equal(v.tick(), LISTENING)
  clock.t += 200
  assert.equal(v.tick(), IDLE)
  assert.equal(v.purpose(), 'wake')
})

test('after a reply she keeps listening for the follow-up window, then sleeps', () => {
  const { v, clock } = make({ followUpMs: 10000 })
  v.wake(true); v.turnStarted(); v.audioStarted(); v.audioEnded(); v.turnEnded()
  clock.t += 9000
  assert.equal(v.tick(), LISTENING)
  clock.t += 2000
  assert.equal(v.tick(), IDLE)
})

test('a running turn or playing audio never times out', () => {
  const { v, clock } = make({ wakeWindowMs: 1000, followUpMs: 1000 })
  v.wake(); v.turnStarted()
  clock.t += 60000
  assert.equal(v.tick(), THINKING)
  v.audioStarted()
  clock.t += 60000
  assert.equal(v.tick(), SPEAKING)
})

test('sleep word returns to IDLE immediately, also mid-reply', () => {
  const { v } = make()
  v.wake()
  assert.equal(v.sleep(), IDLE)
  v.wake(); v.turnStarted(); v.audioStarted()
  v.interrupted()
  assert.equal(v.sleep(), IDLE)
})

test('stop word / hotkey / click: stops turn and audio, stays awake for a command', () => {
  const { v } = make()
  v.wake(); v.turnStarted(); v.audioStarted()
  assert.equal(v.interrupted(), LISTENING)
  assert.equal(v.purpose(), 'command')
})

test('speakers: only the stop word is wanted while she talks; headphones: speech is a command', () => {
  const { v } = make()
  v.wake(); v.turnStarted(); v.audioStarted()
  assert.equal(v.purpose(), 'keyword')
  v.setEchoMode('headphones')
  assert.equal(v.purpose(), 'command')
  v.setEchoMode('speakers')
  assert.equal(v.purpose(), 'keyword')
  v.setEchoMode('bogus')
  assert.equal(v.config().echoMode, 'speakers')
})

test('typing to her wakes her (a typed turn is a turn)', () => {
  const { v } = make()
  v.turnStarted()
  assert.equal(v.state(), THINKING)
  v.turnEnded()
  assert.equal(v.state(), LISTENING)
})

test('voice input off keeps the state IDLE and asks for no audio', () => {
  const { v } = make()
  v.wake()
  v.setEnabled(false)
  assert.equal(v.state(), IDLE)
  assert.equal(v.wantsAudio(), false)
  v.setEnabled(true)
  assert.equal(v.state(), LISTENING)
})
