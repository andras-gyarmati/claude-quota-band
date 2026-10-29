import { expect, test } from 'claude-code/testing'

import { cacheChart, historyRows, historySummary, rebuilt } from './register'

const warmTurn = [1000, 3e3, 400e3]
const coldTurn = [1060, 410e3, 0]

test('a request that wrote more than it read, and enough, rebuilt the cache', () => {
  expect(rebuilt(coldTurn[1], coldTurn[2])).toBe(true)
  expect(rebuilt(warmTurn[1], warmTurn[2])).toBe(false)
  expect(rebuilt(15e3, 0)).toBe(false)
})

test('the chart draws one red bar per rebuild and an orange one per warm request', () => {
  const svg = cacheChart([warmTurn, coldTurn, warmTurn], 300, 32)
  expect(svg.split('fill="#ff453a"').length - 1).toBe(1)
  expect(svg.split('fill="#ff8c00"').length - 1).toBe(2)
  expect(svg.includes('NaN')).toBe(false)
  expect(cacheChart([], 300, 32).includes('NaN')).toBe(false)
})

test('the summary adds up the rows and spans their times', () => {
  const s = historySummary([warmTurn, coldTurn])
  expect(s.read).toBe(400e3)
  expect(s.written).toBe(413e3)
  expect(s.rebuilds).toBe(1)
  expect(s.from).toBe(1000e3)
  expect(s.to).toBe(1060e3)
})

test('keeps the newest 200 requests without their output column', () => {
  const requests = Array.from({ length: 250 }, (_, i) => [i, 1, 2, 3])
  const rows = historyRows({ updated: 0, requests, readings: [] })
  expect(rows.length).toBe(200)
  expect(rows[0]).toEqual([50, 1, 2])
})
