import { expect, test } from 'claude-code/testing'

import { coldStep, projectFolder } from './register'

const HOUR = 3600e3

test('pings at 50, 25, 10 and 5 percent of the cache lifetime left', () => {
  expect(coldStep(0.6 * HOUR, HOUR)).toBe(-1)
  expect(coldStep(0.5 * HOUR, HOUR)).toBe(0)
  expect(coldStep(0.2 * HOUR, HOUR)).toBe(1)
  expect(coldStep(0.1 * HOUR, HOUR)).toBe(2)
  expect(coldStep(0.03 * HOUR, HOUR)).toBe(3)
})

test('a check that wakes late lands on the coldest step passed', () => {
  expect(coldStep(10e3, 5 * 60e3)).toBe(3)
})

test('no ping once the cache is cold', () => {
  expect(coldStep(0, HOUR)).toBeNull()
  expect(coldStep(-1, HOUR)).toBeNull()
})

test('a transcript folder is the cwd with every non-alphanumeric as a dash', () => {
  expect(projectFolder('/Users/andrasgyarmati/repos/personal')).toBe('-Users-andrasgyarmati-repos-personal')
  expect(projectFolder('/Users/a/my.app_x')).toBe('-Users-a-my-app-x')
})
