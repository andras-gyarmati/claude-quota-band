import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Limit, Turn } from '../types'

const limits = atom({ plugin: 'quota-band', key: 'limits' } as const, [] as Limit[])
const turn = atom({ plugin: 'quota-band', key: 'turn' } as const, null as Turn | null)
const multiplier = atom({ plugin: 'quota-band', key: 'multiplier' } as const, null as number | null)
const tick = atom({ plugin: 'quota-band', key: 'tick' } as const, 0)

const HOUR = 3600e3
const FIVE_MINUTES = 5 * 60e3
const COLD_SOON = FIVE_MINUTES
const TRANSCRIPT_TAIL_BYTES = '524288'

/** The fallback before a transcript has been read: subscribers' main thread
 * caches for an hour, everyone else for five minutes, unless `promptCacheTtl`
 * says otherwise. */
async function cacheTtl($: any, subscriber: boolean): Promise<number> {
  const setting = (await $.settings.read())?.promptCacheTtl
  if (setting === '1h') return HOUR
  if (setting === '5m') return FIVE_MINUTES
  return subscriber ? HOUR : FIVE_MINUTES
}

/** `$.fs.read` stops at 4 MiB, so transcript ends come from `head` and `tail`;
 * null where that cannot be read. */
async function transcriptEnd($: any, tool: 'head' | 'tail', transcriptPath: string): Promise<string[] | null> {
  const run = await $.process.run([`/usr/bin/${tool}`, '-c', TRANSCRIPT_TAIL_BYTES, transcriptPath]).catch(() => null)
  return run && run.exitCode === 0 ? run.stdout.split('\n') : null
}

/** The cache lifetime the last response actually wrote, which drops to five
 * minutes in overage. */
function writtenTtl(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"cache_creation"')) continue
    try {
      const creation = JSON.parse(lines[i])?.message?.usage?.cache_creation
      if (creation?.ephemeral_1h_input_tokens) return HOUR
      if (creation?.ephemeral_5m_input_tokens) return FIVE_MINUTES
    } catch {}
  }
  return null
}

type Usage = {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }
}

/** API prices relative to uncached input. How the plan's quotas weigh token
 * kinds is not published, so the multiplier assumes the same ratios. */
const READ_RATE = 0.1
const WRITE_5M_RATE = 1.25
const WRITE_1H_RATE = 2
const OUTPUT_RATE = 5

const sentTokens = (u: Usage) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)

function writeRate(u: Usage): number {
  const hour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const five = u.cache_creation?.ephemeral_5m_input_tokens ?? 0
  return hour + five > 0 ? (hour * WRITE_1H_RATE + five * WRITE_5M_RATE) / (hour + five) : WRITE_5M_RATE
}

function cost(u: Usage): number {
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * writeRate(u)
    + (u.cache_read_input_tokens ?? 0) * READ_RATE + (u.output_tokens ?? 0) * OUTPUT_RATE
}

/** What resending `old` tokens of earlier context cost this request: read from
 * the cache first, then written to it, then sent uncached. */
function carried(u: Usage, old: number): number {
  const read = Math.min(old, u.cache_read_input_tokens ?? 0)
  const written = Math.min(old - read, u.cache_creation_input_tokens ?? 0)
  return read * READ_RATE + written * writeRate(u) + (old - read - written)
}

type Entry = { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { id?: string; content?: unknown; usage?: Usage } }

const parse = (line: string): Entry | null => { try { return JSON.parse(line) } catch { return null } }

const isPrompt = (e: Entry) => e.type === 'user' && !e.isMeta && !e.isSidechain
  && !(Array.isArray(e.message?.content) && e.message!.content.some((b: any) => b?.type === 'tool_result'))

/** Context the session's first request sent: system prompt, tools, rules and
 * the first prompt, the floor a fresh thread starts from. */
function baselineTokens(head: string[]): number | null {
  for (const line of head) {
    if (!line.includes('"usage"')) continue
    const e = parse(line)
    if (e?.type === 'assistant' && !e.isSidechain && e.message?.usage) return sentTokens(e.message.usage)
  }
  return null
}

/** The last turn's cost over what the same turn costs on a fresh thread: every
 * request in it resends the context the turn started with beyond `baseline`. */
function turnMultiplier(tail: string[], baseline: number): number | null {
  const seen = new Set<string>()
  const usages: Usage[] = []
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = parse(tail[i])
    if (!e || e.isSidechain) continue
    if (isPrompt(e)) break
    const id = e.message?.id
    if (e.type !== 'assistant' || !e.message?.usage || !id || seen.has(id)) continue
    seen.add(id)
    usages.push(e.message.usage)
  }
  if (usages.length === 0) return null
  const old = Math.max(0, sentTokens(usages[usages.length - 1]) - baseline)
  const actual = usages.reduce((sum, u) => sum + cost(u), 0)
  const fresh = usages.reduce((sum, u) => sum + cost(u) - carried(u, old), 0)
  return fresh > 0 ? actual / fresh : null
}

function tokensText(tokens: number | null): string {
  if (tokens === null) return ''
  return tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : `${Math.round(tokens / 1e3)}k`
}

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

type Options = { closeCommand?: string; renamePrompt?: string }

/** A plain filled bar for a share of 0 to 1. */
function meter(share: number, color: string, width: number, height: number): string {
  const fill = (Math.min(Math.max(share, 0), 1) * width).toFixed(1)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" rx="2" fill="#000" fill-opacity="0.4"/>`
    + `<rect width="${fill}" height="${height}" rx="2" fill="${color}"/></svg>`
}

export const register: Register = (on, options: Options = {}) => {
  let warned = 0
  let observedTtl: number | null = null
  let baseline: { path: string; tokens: number } | null = null

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    if (usage.rateLimits.length > 0) await update($, limits, () => usage.rateLimits)
    $.clock.every(60e3, () => {
      update($, tick, n => n + 1)
      read($, turn).then(last => {
        if (!last) return
        const left = last.at + last.ttlMs - Date.now()
        if (left > 0 && left <= COLD_SOON && warned !== last.at) {
          warned = last.at
          $.ui.toast(`Prompt cache goes cold in ${Math.ceil(left / 60e3)} min · ${tokensText(last.tokens)} to rebuild`)
        }
      })
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0) await update($, limits, () => e.rateLimits)
    const ttlMs = observedTtl ?? await cacheTtl($, e.rateLimits.length > 0)
    const at = await $.clock.now()
    await update($, turn, () => ({ at, tokens: e.context.tokens ?? null, window: e.context.window ?? null, ttlMs }))
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    const path: string | undefined = (e as any).transcript_path
    if (!path) return result
    const tail = await transcriptEnd($, 'tail', path)
    if (!tail) return result
    const ttlMs = writtenTtl(tail)
    if (ttlMs !== null) {
      observedTtl = ttlMs
      await update($, turn, last => (last ? { ...last, ttlMs } : last))
    }
    if (baseline?.path !== path) {
      const head = await transcriptEnd($, 'head', path)
      const tokens = head ? baselineTokens(head) : null
      baseline = tokens === null ? null : { path, tokens }
    }
    if (baseline) {
      const value = turnMultiplier(tail, baseline.tokens)
      await update($, multiplier, () => value)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, limits)
    const last = await read($, turn)
    const times = await read($, multiplier)
    await read($, tick)
    if (e.props.hasSurvey || (shown.length === 0 && !last)) return next(e)
    const now = await $.clock.now()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const left = last ? last.at + last.ttlMs - now : null
    const cache = left === null || !last ? null
      : left > 0 ? { text: `${Math.ceil(left / 60e3)}m`, share: left / last.ttlMs, color: left <= COLD_SOON ? '#ff8c00' : '#f5f5f7' }
      : { text: 'cold', share: 0, color: '#ff453a' }
    const context = last?.tokens && last.window ? { share: last.tokens / last.window, percent: Math.round((last.tokens / last.window) * 100) } : null
    const buttons = [
      options.closeCommand ? { key: 'close', label: 'close', text: String(options.closeCommand) } : null,
      options.renamePrompt ? { key: 'rename', label: 'rename', text: String(options.renamePrompt) } : null,
    ].filter(Boolean) as { key: string; label: string; text: string }[]
    const line = shown.map(l => `${labels[l.kind] ?? l.kind} ${Math.round(l.percentUsed)}%` + (l.resetsAt ? ` · ${resetText(l, now)}` : '')).join('   ')
      + (context ? `   ctx ${context.percent}% · ${tokensText(last!.tokens)}` : '')
      + (cache ? `   cache ${cache.text}` : '')
      + (times !== null ? `   cost ×${times.toFixed(1)}` : '')
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
        {context ? (
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            <Text dimColor>ctx</Text>
            <Svg source={meter(context.share, tint(context.percent, null), 60, 8)} alt={`context ${context.percent}%`} width={60} height={8} />
            <Text>{context.percent}%</Text>
            <Text dimColor>{tokensText(last!.tokens)}</Text>
          </Box>
        ) : null}
        {cache ? (
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            <Text dimColor>cache</Text>
            <Svg source={meter(cache.share, cache.color, 60, 8)} alt={`cache ${cache.text}`} width={60} height={8} />
            <Text color={cache.color === '#f5f5f7' ? undefined : cache.color}>{cache.text}</Text>
          </Box>
        ) : null}
        {times !== null ? (
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            <Text dimColor>cost</Text>
            <Text>×{times.toFixed(1)}</Text>
          </Box>
        ) : null}
        {buttons.map(b => (
          <Button key={b.key} label={b.label} onPress={() => { $.prompt.submit({ text: b.text, asUser: true }) }} />
        ))}
      </Box>
    )
  })
}
