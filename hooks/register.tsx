import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Limit } from '../types'

const limits = atom({ plugin: 'quota-band', key: 'limits' } as const, [] as Limit[])

const windowMs: Record<string, number> = { five_hour: 5 * 3600e3, seven_day: 7 * 86400e3 }
const labels: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad = (n: number) => String(n).padStart(2, '0')

function resetText(limit: Limit, now: number): string {
  if (!limit.resetsAt) return ''
  const at = new Date(limit.resetsAt)
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return at.getTime() - now < 20 * 3600e3 ? time : `${days[at.getDay()]} ${time}`
}

/** Share of the window gone, 0 to 1, or null without a running window. */
function elapsed(limit: Limit, now: number): number | null {
  const length = windowMs[limit.kind]
  if (!length || !limit.resetsAt) return null
  const left = new Date(limit.resetsAt).getTime() - now
  return left > 0 && left <= length ? 1 - left / length : null
}

/** Red from 95%, orange from 80%, yellow while ahead of an even pace, else white. */
function tint(percent: number, gone: number | null): string {
  if (percent >= 95) return '#ff453a'
  if (percent >= 80) return '#ff8c00'
  return gone !== null && percent / 100 > gone + 0.05 ? '#ffd60a' : '#f5f5f7'
}

/** Where the current rate lands by the reset; none in the first tenth of the window. */
function projected(limit: Limit, now: number): number | null {
  const gone = elapsed(limit, now)
  if (gone === null || gone < 0.1 || limit.percentUsed <= 0) return null
  return Math.min(Math.round(limit.percentUsed / gone), 100)
}

/** Hour notches for the 5h window, midnights for the week. */
function notches(limit: Limit): number[] {
  const length = windowMs[limit.kind]
  if (!length || !limit.resetsAt) return []
  const end = new Date(limit.resetsAt).getTime()
  const start = end - length
  const step = length > 86400e3 ? 'day' : 'hour'
  const line = new Date(start)
  if (step === 'day') line.setHours(0, 0, 0, 0)
  else line.setMinutes(0, 0, 0)
  const marks: number[] = []
  for (;;) {
    if (step === 'day') line.setDate(line.getDate() + 1)
    else line.setHours(line.getHours() + 1)
    if (line.getTime() >= end) return marks
    marks.push((line.getTime() - start) / length)
  }
}

function bar(limit: Limit, now: number, width: number, height: number): string {
  const x = (share: number) => (Math.min(Math.max(share, 0), 1) * width).toFixed(1)
  const used = limit.percentUsed / 100
  const gone = elapsed(limit, now)
  const color = tint(limit.percentUsed, gone)
  const ahead = projected(limit, now)
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" rx="2" fill="#000" fill-opacity="0.4"/>`
  if (ahead !== null && ahead > limit.percentUsed) {
    svg += `<rect x="${x(used)}" y="0.5" width="${(Number(x(ahead / 100)) - Number(x(used))).toFixed(1)}" height="${height - 1}" fill="none" stroke="${color}" stroke-opacity="0.5" stroke-dasharray="2 2"/>`
  }
  svg += `<rect width="${x(used)}" height="${height}" rx="2" fill="${color}"/>`
  for (const mark of notches(limit)) svg += `<rect x="${x(mark)}" y="0" width="1" height="${height}" fill="#000" fill-opacity="0.35"/>`
  if (gone !== null) svg += `<rect x="${(Number(x(gone)) - 1).toFixed(1)}" y="0" width="2" height="${height}" fill="#8b8d98"/>`
  return svg + `</svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    if (usage.rateLimits.length > 0) await update($, limits, () => usage.rateLimits)
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0) await update($, limits, () => e.rateLimits)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, limits)
    if (e.props.hasSurvey || shown.length === 0) return next(e)
    const now = await $.clock.now()
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const line = shown.map(l => `${labels[l.kind] ?? l.kind} ${Math.round(l.percentUsed)}%` + (l.resetsAt ? ` · ${resetText(l, now)}` : '')).join('   ')
    if (e.surface !== 'desktop' || !('Svg' in ui)) return <Text dimColor>{line}</Text>
    const { Svg } = ui as any

    return (
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        {shown.map(l => (
          <Box key={l.kind} flexDirection="row" alignItems="center" columnGap={1}>
            <Text dimColor>{labels[l.kind] ?? l.kind}</Text>
            <Svg source={bar(l, now, 120, 8)} alt={`${l.kind} ${l.percentUsed}%`} width={120} height={8} />
            <Text>{Math.round(l.percentUsed)}%</Text>
            {projected(l, now) !== null && projected(l, now)! > Math.round(l.percentUsed) ? <Text dimColor>→ {projected(l, now)}%</Text> : null}
            {l.resetsAt ? <Text dimColor>{resetText(l, now)}</Text> : null}
          </Box>
        ))}
      </Box>
    )
  })
}
