import { expect, test } from 'claude-code/testing'

import { elapsed, nextWeek } from './register'

const reset = '2026-10-14T16:00:00Z'
const at = (iso: string) => new Date(iso).getTime()
const near = (share: number | null) => Math.round((share ?? NaN) * 1e6)

test("a claim that drops the week under the same reset time starts the week there", () => {
  const before = nextWeek(null, { kind: 'seven_day', percentUsed: 91, resetsAt: reset }, at('2026-10-10T18:57:00Z'))
  const after = nextWeek(before, { kind: 'seven_day', percentUsed: 0, resetsAt: '2026-10-14T15:59:59Z' }, at('2026-10-10T21:51:00Z'))
  expect(after!.claimedAt).toBe(at('2026-10-10T21:51:00Z'))
  const later = nextWeek(after, { kind: 'seven_day', percentUsed: 3, resetsAt: reset }, at('2026-10-11T05:00:00Z'))
  expect(later!.claimedAt).toBe(at('2026-10-10T21:51:00Z'))
  const limit = { kind: 'seven_day', percentUsed: 3, resetsAt: reset }
  const now = at('2026-10-12T16:00:00Z')
  expect(near(elapsed(limit, now))).toBe(near(5 / 7))
  expect(near(elapsed(limit, now, later!.claimedAt))).toBe(near((now - later!.claimedAt!) / (at(reset) - later!.claimedAt!)))
})

test('the natural weekly reset clears the claim', () => {
  const claimed = { resetsAt: reset, percent: 40, claimedAt: at('2026-10-10T21:51:00Z') }
  const next = nextWeek(claimed, { kind: 'seven_day', percentUsed: 0, resetsAt: '2026-10-21T16:00:00Z' }, at('2026-10-14T16:05:00Z'))
  expect(next!.claimedAt).toBeNull()
})

test('the 5h window ignores a week claim', () => {
  const limit = { kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-11T10:00:00Z' }
  expect(near(elapsed(limit, at('2026-10-11T07:30:00Z'), at('2026-10-11T07:00:00Z')))).toBe(near(0.5))
})
