import { expect, test } from 'claude-code/testing'

import { keepWarmDue, parseMaxIdle, warmArmed, warmLabel, warmWanted, WARM_LEAD_MS } from './register'

const HOUR = 3600e3
const at = 1_000_000
const hourTurn = { at, tokens: 400e3, window: 1e6, ttlMs: HOUR }
const fresh = { sent: 0, idleSince: at, pingedFor: null }
const due = at + HOUR - WARM_LEAD_MS + 1
const check = { now: due, last: hourTurn, running: false, draft: '', warm: fresh, limit: { pings: 3 } }

test('pings only when idle, inside the lead time, before the cache is cold', () => {
  expect(keepWarmDue(check)).toBe('ping')
  expect(keepWarmDue({ ...check, running: true })).toBe('busy')
  expect(keepWarmDue({ ...check, now: at + 10 * 60e3 })).toBe('early')
  expect(keepWarmDue({ ...check, now: at + HOUR })).toBe('cold')
  expect(keepWarmDue({ ...check, last: null })).toBe('no-turn')
})

test('never when he has typed something', () => {
  expect(keepWarmDue({ ...check, draft: 'half a sentence' })).toBe('typed')
  expect(keepWarmDue({ ...check, draft: '  \n' })).toBe('ping')
})

test('skips in overage, where the cache lives five minutes', () => {
  const overage = { ...hourTurn, ttlMs: 5 * 60e3 }
  expect(keepWarmDue({ ...check, last: overage, now: at + 3 * 60e3 })).toBe('overage')
  expect(warmArmed(overage.ttlMs, fresh, { pings: 3 }, at)).toBe(false)
})

test('stops after the max idle pings or hours', () => {
  expect(keepWarmDue({ ...check, warm: { ...fresh, sent: 2 } })).toBe('ping')
  expect(keepWarmDue({ ...check, warm: { ...fresh, sent: 3 } })).toBe('spent')
  expect(keepWarmDue({ ...check, limit: { hours: 2 } })).toBe('ping')
  expect(keepWarmDue({ ...check, now: at + 2 * HOUR, last: { ...hourTurn, at: at + HOUR }, limit: { hours: 2 } })).toBe('spent')
  expect(warmArmed(HOUR, { ...fresh, sent: 3 }, { pings: 3 }, at)).toBe(false)
})

test('one ping per response', () => {
  expect(keepWarmDue({ ...check, warm: { ...fresh, sent: 1, pingedFor: at } })).toBe('sent')
})

test('reads the max idle option', () => {
  expect(parseMaxIdle('3')).toEqual({ pings: 3 })
  expect(parseMaxIdle('2h')).toEqual({ hours: 2 })
  expect(parseMaxIdle('1.5 h')).toEqual({ hours: 1.5 })
  expect(parseMaxIdle('')).toEqual({ pings: 3 })
  expect(parseMaxIdle('junk')).toEqual({ pings: 3 })
})

test('is toggled per thread by /keep-warm', () => {
  expect(warmWanted('', false)).toBe(true)
  expect(warmWanted('', true)).toBe(false)
  expect(warmWanted(' ON ', false)).toBe(true)
  expect(warmWanted('off', true)).toBe(false)
  expect(warmWanted('maybe', true)).toBe(null)
})

test('the band names each keep-warm state', () => {
  const next = new Date(at + HOUR - WARM_LEAD_MS)
  const time = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`
  const pings = { pings: 3 }
  expect(warmLabel(null, hourTurn, pings, at)).toBe('keep-warm off')
  expect(warmLabel(fresh, null, pings, at)).toBe('keep-warm on')
  expect(warmLabel(fresh, hourTurn, pings, at + 60e3)).toBe(`keep-warm ${time}`)
  expect(warmLabel({ ...fresh, sent: 2 }, hourTurn, pings, at + 60e3)).toBe(`keep-warm ${time} · 2 sent`)
  expect(warmLabel({ ...fresh, sent: 1, pingedFor: at }, hourTurn, pings, due)).toBe('keep-warm pinging · 1 sent')
  expect(warmLabel({ ...fresh, sent: 3 }, hourTurn, pings, at + 60e3)).toBe('keep-warm stopped · 3 pings without a prompt')
  expect(warmLabel(fresh, hourTurn, { hours: 2 }, at + 2 * HOUR)).toBe('keep-warm stopped · 2h without a prompt')
  expect(warmLabel(fresh, { ...hourTurn, ttlMs: 5 * 60e3 }, pings, at)).toBe('keep-warm paused · overage')
  expect(warmLabel(fresh, hourTurn, pings, at + HOUR)).toBe('keep-warm on · cache cold')
})
