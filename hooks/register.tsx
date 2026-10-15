import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Limit, Multiplier, Turn, Warm } from '../types'

const limits = atom({ plugin: 'quota-band', key: 'limits' } as const, [] as Limit[])
const turn = atom({ plugin: 'quota-band', key: 'turn' } as const, null as Turn | null)
const multiplier = atom({ plugin: 'quota-band', key: 'multiplier' } as const, null as Multiplier | null)
const tick = atom({ plugin: 'quota-band', key: 'tick' } as const, 0)
const weekClaim = atom({ plugin: 'quota-band', key: 'weekClaim' } as const, null as number | null)
const gift = atom({ plugin: 'quota-band', key: 'gift' } as const, null as Gift | null)
const warm = atom({ plugin: 'quota-band', key: 'warm' } as const, null as Warm | null)

const HOUR = 3600e3
const FIVE_MINUTES = 5 * 60e3
const COLD_SOON = FIVE_MINUTES
/** Shares of the cache lifetime left at which a thread pings, warmest first. */
export const COLD_STEPS = [0.5, 0.25, 0.1, 0.05]
const COLD_CHECK_MS = 10e3
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

/** The thread's title as the app last set it, from a transcript's end. */
function threadTitle(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"custom-title"')) continue
    try {
      const title = JSON.parse(lines[i])?.customTitle
      if (typeof title === 'string' && title) return title
    } catch {}
  }
  return null
}

/** The coldest step `left` of `ttlMs` has passed, as an index into
 * `COLD_STEPS`; -1 above the first, null once cold. */
export function coldStep(left: number, ttlMs: number): number | null {
  if (left <= 0) return null
  let step = -1
  COLD_STEPS.forEach((share, i) => { if (left <= share * ttlMs) step = i })
  return step
}

/** A Notification Centre banner, so a ping reaches him outside the thread. The
 * text goes in as arguments, never into the script. macOS only. */
async function notify($: any, title: string, text: string) {
  await $.process.run(['/usr/bin/osascript',
    '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run',
    title, text]).catch(() => null)
}

/** An iMessage from this Mac's Messages account, which reaches the phone. */
async function sendIMessage($: any, to: string, text: string) {
  await $.process.run(['/usr/bin/osascript',
    '-e', 'on run argv', '-e', 'tell application "Messages" to send (item 2 of argv) to participant (item 1 of argv) of (1st account whose service type = iMessage)', '-e', 'end run',
    to, text]).catch(() => null)
}

/** How long before the cache goes cold a keep-warm ping is sent: a few cold
 * checks of margin plus the ping's own turn. A guess. */
export const WARM_LEAD_MS = 3 * 60e3
export const KEEP_WARM_PROMPT = 'keep-warm: reply with only "ok"'

/** `keepWarmMaxIdle`: `3` stops after three pings in a row with no prompt of
 * his between them, `2h` after two hours without one. */
export type WarmLimit = { pings: number } | { hours: number }

export function parseMaxIdle(value: unknown): WarmLimit {
  const text = String(value ?? '').trim().toLowerCase()
  const hours = /^(\d+(?:\.\d+)?)\s*h$/.exec(text)
  if (hours) return { hours: Number(hours[1]) }
  const pings = Number(text)
  return Number.isFinite(pings) && pings >= 0 && text !== '' ? { pings: Math.floor(pings) } : { pings: 3 }
}

export function warmSpent(w: Warm, limit: WarmLimit, now: number): boolean {
  return 'pings' in limit ? w.sent >= limit.pings : now - w.idleSince >= limit.hours * HOUR
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Keep-warm stands down in overage: a five-minute cache would need a ping
 * every four minutes, which costs more than one cold rewrite saves. */
export function warmArmed(ttlMs: number, w: Warm, limit: WarmLimit, now: number): boolean {
  return ttlMs > FIVE_MINUTES && !warmSpent(w, limit, now)
}

export const freshWarm = (now: number): Warm => ({ sent: 0, idleSince: now, pingedFor: null })

const clock = (at: number) => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }

/** The band's keep-warm segment: off, the local time of the next ping, or why none is coming. */
export function warmLabel(w: Warm | null, last: Turn | null, limit: WarmLimit, now: number): string {
  if (!w) return 'keep-warm off'
  const sent = w.sent ? ` · ${w.sent} sent` : ''
  if (!last) return 'keep-warm on'
  if (last.ttlMs <= FIVE_MINUTES) return 'keep-warm paused · overage'
  if (warmSpent(w, limit, now)) return `keep-warm stopped · ${'pings' in limit ? `${w.sent} pings` : `${limit.hours}h`} without a prompt`
  if (w.pingedFor === last.at) return `keep-warm pinging${sent}`
  if (last.at + last.ttlMs <= now) return `keep-warm on · cache cold${sent}`
  return `keep-warm ${clock(last.at + last.ttlMs - WARM_LEAD_MS)}${sent}`
}

/** `/keep-warm` with `on`, `off`, or nothing to flip it. */
export function warmWanted(args: string, isOn: boolean): boolean | null {
  const word = args.trim().toLowerCase()
  if (word === '') return !isOn
  if (word === 'on') return true
  if (word === 'off') return false
  return null
}

export type WarmCheck = { now: number; last: Turn | null; running: boolean; draft: string; warm: Warm; limit: WarmLimit }

/** Whether to send a keep-warm ping now, or why not. */
export function keepWarmDue(c: WarmCheck): 'ping' | 'no-turn' | 'overage' | 'spent' | 'sent' | 'early' | 'cold' | 'busy' | 'typed' {
  if (!c.last) return 'no-turn'
  if (c.last.ttlMs <= FIVE_MINUTES) return 'overage'
  if (warmSpent(c.warm, c.limit, c.now)) return 'spent'
  if (c.warm.pingedFor === c.last.at) return 'sent'
  const left = c.last.at + c.last.ttlMs - c.now
  if (left <= 0) return 'cold'
  if (left > WARM_LEAD_MS) return 'early'
  if (c.running) return 'busy'
  if (c.draft.trim() !== '') return 'typed'
  return 'ping'
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

/** Quota used per token kind, relative to a cache write: measured by
 * `fitWeights`; null means the API price ratios. */
type Weights = { write: number; read: number; output: number }

function cost(u: Usage, w: Weights | null): number {
  const written = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  if (w) return written * w.write + (u.cache_read_input_tokens ?? 0) * w.read + (u.output_tokens ?? 0) * w.output
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * writeRate(u)
    + (u.cache_read_input_tokens ?? 0) * READ_RATE + (u.output_tokens ?? 0) * OUTPUT_RATE
}

/** What resending `old` tokens of earlier context cost this request: read from
 * the cache first, then written to it, then sent uncached. */
function carried(u: Usage, old: number, w: Weights | null): number {
  const read = Math.min(old, u.cache_read_input_tokens ?? 0)
  const written = Math.min(old - read, u.cache_creation_input_tokens ?? 0)
  return read * (w?.read ?? READ_RATE) + written * (w?.write ?? writeRate(u)) + (old - read - written) * (w?.write ?? 1)
}

type Entry = { type?: string; timestamp?: string; isMeta?: boolean; isSidechain?: boolean; message?: { id?: string; content?: unknown; usage?: Usage } }

type Request = { at: number; usage: Usage }

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

/** The last turn's requests, newest first. A response spans several transcript
 * lines that repeat its usage, so each message id counts once. */
function lastTurn(tail: string[]): Request[] {
  const seen = new Set<string>()
  const requests: Request[] = []
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = parse(tail[i])
    if (!e || e.isSidechain) continue
    if (isPrompt(e)) break
    const id = e.message?.id
    if (e.type !== 'assistant' || !e.message?.usage || !id || seen.has(id)) continue
    seen.add(id)
    requests.push({ at: Date.parse(e.timestamp ?? '') || 0, usage: e.message.usage })
  }
  return requests
}

/** The turn's cost over what the same turn costs on a fresh thread: every
 * request in it resends the context the turn started with beyond `baseline`. */
function turnMultiplier(turn: Request[], baseline: number, w: Weights | null): number | null {
  if (turn.length === 0) return null
  const old = Math.max(0, sentTokens(turn[turn.length - 1].usage) - baseline)
  const actual = turn.reduce((sum, r) => sum + cost(r.usage, w), 0)
  const fresh = turn.reduce((sum, r) => sum + cost(r.usage, w) - carried(r.usage, old, w), 0)
  return fresh > 0 ? actual / fresh : null
}

/** One session's calibration record in `$.store`: requests as [unix s, tokens
 * written or sent uncached, cache read, output], quota readings as [unix s,
 * 5h %, 7d %]. */
type Log = { updated: number; requests: number[][]; readings: (number | null)[][] }

const LOG_PREFIX = 'calibration/'
const KEEP_MS = 8 * 86400e3
const READING_EVERY_S = 300
const REFIT_MS = 10 * 60e3
/** Guesses: a quota step large enough that the one-decimal reading and request
 * timing are noise, a gap after which usage elsewhere (claude.ai, another
 * machine) is likely, and enough intervals to fit two weights. */
const MIN_STEP = 1
const MAX_GAP_S = 30 * 60
const MIN_INTERVALS = 20

const requestRow = (r: Request): number[] => [
  Math.round(r.at / 1e3),
  (r.usage.input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0),
  r.usage.cache_read_input_tokens ?? 0,
  r.usage.output_tokens ?? 0,
]

/** Output per cache-write token at API prices with hour-long writes. Output is
 * about a tenth of a turn's quota use, below what the readings can resolve, so
 * it stays at this ratio and only writes and reads are measured. */
const OUTPUT_PER_WRITE = OUTPUT_RATE / WRITE_1H_RATE
/** Guesses: an interval using this much more than the fit predicts had usage
 * this log cannot see; the read weight is trusted once its resampled 10th to
 * 90th percentile range stays within this share of it. */
const OUTLIER = 1.3
const MAX_SPREAD = 0.25
const RESAMPLES = 100

type Fit = { kind: string; intervals: number; dropped: number; writePerPoint: number | null; weights: Weights | null; readRange: [number, number] | null }

const usable = (fit: Fit | null): fit is Fit & { weights: Weights; readRange: [number, number] } =>
  !!fit?.weights && !!fit.readRange && fit.intervals >= MIN_INTERVALS
  && fit.readRange[1] - fit.readRange[0] <= 2 * MAX_SPREAD * fit.weights.read

/** Intervals in which a window rose at least `MIN_STEP`, as rows of [written +
 * weighted output, cache read] in millions of tokens and the points used. */
function quotaIntervals(logs: Log[], column: 1 | 2): { rows: number[][]; ys: number[] } {
  const readings = logs.flatMap(l => l.readings)
    .filter(r => typeof r[column] === 'number')
    .map(r => [r[0] as number, r[column] as number])
    .sort((a, b) => a[0] - b[0])
  const requests = logs.flatMap(l => l.requests)
  const rows: number[][] = []
  const ys: number[] = []
  let start = readings[0]
  for (let i = 1; i < readings.length; i++) {
    const [t, p] = readings[i]
    const [prevT, prevP] = readings[i - 1]
    if (p < prevP || t - prevT > MAX_GAP_S) { start = readings[i]; continue }
    if (p - start[1] < MIN_STEP) continue
    const row = [0, 0]
    for (const q of requests) {
      if (q[0] <= start[0] || q[0] > t) continue
      row[0] += (q[1] + q[3] * OUTPUT_PER_WRITE) / 1e6
      row[1] += q[2] / 1e6
    }
    rows.push(row)
    ys.push(p - start[1])
    start = readings[i]
  }
  return { rows, ys }
}

/** Least squares for points = rows·[W, R] with W > 0 and R ≥ 0. */
function leastSquares(rows: number[][], ys: number[]): [number, number] | null {
  let aa = 0, ab = 0, bb = 0, ay = 0, by = 0
  rows.forEach(([a, b], i) => { aa += a * a; ab += a * b; bb += b * b; ay += a * ys[i]; by += b * ys[i] })
  const det = aa * bb - ab * ab
  if (det > 1e-12) {
    const w = (ay * bb - by * ab) / det
    const r = (by * aa - ay * ab) / det
    if (w > 0 && r >= 0) return [w, r]
  }
  return aa > 0 && ay > 0 ? [ay / aa, 0] : null
}

/** Fits the points each interval used, drops intervals well above the fit as
 * usage elsewhere (claude.ai, another machine) and fits again; the read weight's
 * range comes from refitting resampled intervals. */
function fitWeights(logs: Log[], column: 1 | 2, kind: string): Fit {
  const { rows, ys } = quotaIntervals(logs, column)
  const none: Fit = { kind, intervals: rows.length, dropped: 0, writePerPoint: null, weights: null, readRange: null }
  const first = leastSquares(rows, ys)
  if (!first) return none
  const kept = rows.map((r, i) => i).filter(i => ys[i] <= OUTLIER * (rows[i][0] * first[0] + rows[i][1] * first[1]))
  const keptRows = kept.map(i => rows[i])
  const keptYs = kept.map(i => ys[i])
  const fit = leastSquares(keptRows, keptYs)
  if (!fit) return none
  let seed = 1
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const reads: number[] = []
  for (let n = 0; n < RESAMPLES; n++) {
    const pick = keptRows.map(() => Math.floor(random() * keptRows.length))
    const again = leastSquares(pick.map(i => keptRows[i]), pick.map(i => keptYs[i]))
    if (again) reads.push(again[1] / again[0])
  }
  reads.sort((a, b) => a - b)
  return {
    kind,
    intervals: kept.length,
    dropped: rows.length - kept.length,
    writePerPoint: 1e6 / fit[0],
    weights: { write: 1, read: fit[1] / fit[0], output: OUTPUT_PER_WRITE },
    readRange: reads.length >= RESAMPLES / 2 ? [reads[Math.floor(reads.length * 0.1)], reads[Math.floor(reads.length * 0.9)]] : null,
  }
}

function fitText(fit: Fit): string {
  const head = `${fit.kind}: ${fit.intervals} intervals` + (fit.dropped ? `, ${fit.dropped} dropped as usage elsewhere` : '')
  if (!fit.weights) return `${head}, no fit yet`
  const range = fit.readRange ? ` (${fit.readRange[0].toFixed(3)} to ${fit.readRange[1].toFixed(3)})` : ''
  return `${head}; 1% = ${tokensText(fit.writePerPoint)} cache-write tokens; cache read = ${fit.weights.read.toFixed(3)}${range} of a cache write, API 0.05 to 0.08`
}

function tokensText(tokens: number | null): string {
  if (tokens === null) return ''
  return tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : `${Math.round(tokens / 1e3)}k`
}

const windowMs: Record<string, number> = { five_hour: 5 * 3600e3, seven_day: 7 * 86400e3 }
const labels: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']


function resetText(limit: Limit, now: number): string {
  if (!limit.resetsAt) return ''
  const at = new Date(limit.resetsAt)
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return at.getTime() - now < 20 * 3600e3 ? time : `${days[at.getDay()]} ${time}`
}

type Gift = { at: number; by?: string; device?: string | null }

/** `🎁 Sat 23:51 · Andras · Mac`: the week's last gift reset as Agent Profiles writes it per account, where installed. */
export function giftText(g: Gift): string {
  const at = new Date(g.at)
  const who = g.by === 'Andras' ? `${g.by} · ${g.device ?? 'device?'}` : g.by ?? 'gift'
  return `🎁 ${days[at.getDay()]} ${pad(at.getHours())}:${pad(at.getMinutes())} · ${who}`
}

async function readGift($: any): Promise<Gift | null> {
  const home = await $.env.get('HOME')
  const email = (await $.env.get('CLAUDE_CODE_USER_EMAIL'))?.toLowerCase()
  if (!home || !email) return null
  const path = `${home}/Library/Application Support/Agent Profiles/resets/${email}.json`
  if (!(await $.fs.exists(path))) return null
  try {
    const gifts = (JSON.parse(await $.fs.read(path))?.gifts ?? []) as Gift[]
    return gifts.sort((a, b) => b.at - a.at)[0] ?? null
  } catch { return null }
}

/** Weekly use never falls by itself within a week, so a drop this large under the same reset time is a claimed reset. */
const CLAIM_DROP = 10
/** The reset time read back moves by a second between reads. */
const RESET_JITTER_MS = HOUR

export type WeekReading = { resetsAt: string; percent: number; claimedAt: number | null }

/** The account's weekly reading after `limit` arrives at `at`. A Claude saved reset zeroes the weekly use and keeps
 * the weekly reset time (Personal, 2026-10-10 21:51Z: 91% to 0%, reset still Oct 14 16:00Z), so the week then runs
 * from the claim to the reset, not from seven days before it. */
export function nextWeek(last: WeekReading | null, limit: Limit, at: number): WeekReading | null {
  if (limit.kind !== 'seven_day' || !limit.resetsAt) return last
  const sameWeek = last !== null && Math.abs(new Date(last.resetsAt).getTime() - new Date(limit.resetsAt).getTime()) <= RESET_JITTER_MS
  const claimedAt = !sameWeek ? null : last!.percent - limit.percentUsed >= CLAIM_DROP ? at : last!.claimedAt
  return { resetsAt: limit.resetsAt, percent: limit.percentUsed, claimedAt }
}

/** Where the window started: a claim that refilled it, else its length before the reset. */
function windowStart(limit: Limit, claimedAt: number | null): number | null {
  const length = windowMs[limit.kind]
  if (!length || !limit.resetsAt) return null
  const end = new Date(limit.resetsAt).getTime()
  return limit.kind === 'seven_day' && claimedAt !== null && claimedAt < end && end - claimedAt < length ? claimedAt : end - length
}

/** Share of the window gone, 0 to 1, or null without a running window. */
export function elapsed(limit: Limit, now: number, claimedAt: number | null = null): number | null {
  const start = windowStart(limit, claimedAt)
  if (start === null) return null
  const end = new Date(limit.resetsAt!).getTime()
  const left = end - now
  return left > 0 && now >= start ? 1 - left / (end - start) : null
}

/** Red from 95%, orange from 80%, yellow while ahead of an even pace, else white. */
function tint(percent: number, gone: number | null): string {
  if (percent >= 95) return '#ff453a'
  if (percent >= 80) return '#ff8c00'
  return gone !== null && percent / 100 > gone + 0.05 ? '#ffd60a' : '#f5f5f7'
}

/** Where the current rate lands by the reset; none in the first tenth of the window. */
function projected(limit: Limit, now: number, claimedAt: number | null): number | null {
  const gone = elapsed(limit, now, claimedAt)
  if (gone === null || gone < 0.1 || limit.percentUsed <= 0) return null
  return Math.min(Math.round(limit.percentUsed / gone), 100)
}

/** Hour notches for the 5h window, midnights for the week. */
function notches(limit: Limit, claimedAt: number | null): number[] {
  const start = windowStart(limit, claimedAt)
  if (start === null) return []
  const end = new Date(limit.resetsAt!).getTime()
  const length = end - start
  const step = windowMs[limit.kind] > 86400e3 ? 'day' : 'hour'
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

function bar(limit: Limit, now: number, width: number, height: number, claimedAt: number | null): string {
  const x = (share: number) => (Math.min(Math.max(share, 0), 1) * width).toFixed(1)
  const used = limit.percentUsed / 100
  const gone = elapsed(limit, now, claimedAt)
  const color = tint(limit.percentUsed, gone)
  const ahead = projected(limit, now, claimedAt)
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" rx="2" fill="#000" fill-opacity="0.4"/>`
  if (ahead !== null && ahead > limit.percentUsed) {
    svg += `<rect x="${x(used)}" y="0.5" width="${(Number(x(ahead / 100)) - Number(x(used))).toFixed(1)}" height="${height - 1}" fill="none" stroke="${color}" stroke-opacity="0.5" stroke-dasharray="2 2"/>`
  }
  svg += `<rect width="${x(used)}" height="${height}" rx="2" fill="${color}"/>`
  for (const mark of notches(limit, claimedAt)) svg += `<rect x="${x(mark)}" y="0" width="1" height="${height}" fill="#000" fill-opacity="0.35"/>`
  if (gone !== null) svg += `<rect x="${(Number(x(gone)) - 1).toFixed(1)}" y="0" width="2" height="${height}" fill="#8b8d98"/>`
  return svg + `</svg>`
}

type Options = { iMessageTo?: string; keepWarmMaxIdle?: string }

/** A plain filled bar for a share of 0 to 1. */
function meter(share: number, color: string, width: number, height: number): string {
  const fill = (Math.min(Math.max(share, 0), 1) * width).toFixed(1)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" rx="2" fill="#000" fill-opacity="0.4"/>`
    + `<rect width="${fill}" height="${height}" rx="2" fill="${color}"/></svg>`
}

/** The Agent Profiles Mac app shows each account's quota; the figures every response carries
 * spare it a request to Anthropic's rate-limited usage endpoint. Written only where that app is
 * installed, one file per account (Desktop sessions name it) or per CLI config folder. */
async function handOff($: any, rateLimits: unknown[]): Promise<void> {
  const home = await $.env.get('HOME')
  if (!home) return
  const root = home + '/Library/Application Support/Agent Profiles'
  if (!(await $.fs.exists(root))) return
  const account = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const name = await accountName($)
  const email = await $.env.get('CLAUDE_CODE_USER_EMAIL')
  await $.fs.write(`${root}/mod-readings/${name}.json`, JSON.stringify({ at: new Date().toISOString(), account, email, configDir, rateLimits }))
}

/** One name per account (Desktop sessions name it) or per CLI config folder; every profile shares this store. */
async function accountName($: any): Promise<string> {
  const account = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  return account ? 'account-' + account : 'config-' + (configDir ?? 'default').replace(/[^A-Za-z0-9]+/g, '-')
}

/** Keeps the account's weekly reading in the store, so a claim seen in one session reaches the others. */
async function trackWeek($: any, rateLimits: Limit[], at: number) {
  const seven = rateLimits.find(l => l.kind === 'seven_day')
  if (!seven) return
  const key = 'week:' + await accountName($)
  const last = ((await $.store.get(key)) as WeekReading | undefined) ?? null
  const next = nextWeek(last, seven, at)
  if (next && (next.percent !== last?.percent || next.claimedAt !== last?.claimedAt || next.resetsAt !== last?.resetsAt)) await $.store.set(key, next)
  await update($, weekClaim, () => next?.claimedAt ?? null)
}

type Calibration = { own: { key: string; log: Log } | null; fits: Fit[]; fittedAt: number }

async function ownLog($: any, c: Calibration): Promise<{ key: string; log: Log }> {
  const key = LOG_PREFIX + await $.session.id()
  if (c.own?.key !== key) c.own = { key, log: ((await $.store.get(key)) as Log | undefined) ?? { updated: 0, requests: [], readings: [] } }
  return c.own
}

/** Expired session logs are dropped; when the store refuses a write as
 * over its 4 MiB, the oldest other log goes and the write is tried again. */
async function calibrationLogs($: any): Promise<{ key: string; log: Log }[]> {
  const now = await $.clock.now()
  const found: { key: string; log: Log }[] = []
  for (const key of (await $.store.keys()) as string[]) {
    if (!key.startsWith(LOG_PREFIX)) continue
    const log = (await $.store.get(key)) as Log | undefined
    if (!log || now - log.updated > KEEP_MS) await $.store.delete(key)
    else found.push({ key, log })
  }
  return found.sort((a, b) => a.log.updated - b.log.updated)
}

async function saveLog($: any, mine: { key: string; log: Log }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await $.store.set(mine.key, mine.log)
      return
    } catch {
      const oldest = (await calibrationLogs($)).find(l => l.key !== mine.key)
      if (!oldest) break
      await $.store.delete(oldest.key)
    }
  }
  $.ui.toast('quota-band: calibration log not saved')
}

/** Keep-warm is per thread: the session ids it is on for, in the store so a restart keeps them. */
const WARM_PREFIX = 'keep-warm/'

async function setKeepWarm($: any, on: boolean) {
  const key = WARM_PREFIX + await $.session.id()
  const now = await $.clock.now()
  if (on) await $.store.set(key, { since: now })
  else await $.store.delete(key)
  await update($, warm, () => (on ? freshWarm(now) : null))
}

async function refit($: any, c: Calibration) {
  const all = (await calibrationLogs($)).map(l => (l.key === c.own?.key ? c.own.log : l.log))
  if (c.own && !all.includes(c.own.log)) all.push(c.own.log)
  c.fits = [fitWeights(all, 1, '5h'), fitWeights(all, 2, '7d')]
  c.fittedAt = await $.clock.now()
}

export const register: Register = (on, options: Options = {}) => {
  let pinged = { at: 0, step: -1 }
  let title: string | null = null
  let observedTtl: number | null = null
  let baseline: { path: string; tokens: number } | null = null
  const calibration: Calibration = { own: null, fits: [], fittedAt: 0 }
  const warmLimit = parseMaxIdle(options.keepWarmMaxIdle)
  // Main-loop turns in flight, from turn.start to turn.complete. A reload mid-turn
  // starts it empty; $.prompt.submit still waits for the session to be idle.
  const running = new Set<string>()
  let warmTurn = false

  on('command.run', { command: 'quota-weights' }, async $ => {
    await refit($, calibration)
    const used = usable(calibration.fits[0]) ? 'measured 5h weights' : `API price ratios until 5h has ${MIN_INTERVALS} intervals and a cache read range within ±${MAX_SPREAD * 100}%`
    return { text: [...calibration.fits.map(fitText), `output stays at ${OUTPUT_PER_WRITE} cache writes per token`, `cost × uses ${used}`].join('\n') }
  })

  on('command.run', { command: 'keep-warm' }, async ($, e) => {
    const wanted = warmWanted(e.args, (await read($, warm)) !== null)
    if (wanted === null) return { text: 'Usage: /keep-warm [on|off]' }
    await setKeepWarm($, wanted)
    return { text: wanted ? 'keep-warm on for this thread' : 'keep-warm off for this thread' }
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'quota-weights', description: 'How much of the 5h and 7d quota cache reads and output use, measured against cache writes' })
    await $.command.register({ name: 'keep-warm', description: 'Ping this thread before its prompt cache goes cold', argumentHint: '[on|off]', immediate: true })
    await ownLog($, calibration)
    await refit($, calibration)
    const usage = await $.session.usage()
    if (usage.rateLimits.length > 0) await update($, limits, () => usage.rateLimits)
    const stored = (await $.store.get('week:' + await accountName($))) as WeekReading | undefined
    await update($, weekClaim, () => stored?.claimedAt ?? null)
    if (await $.store.get(WARM_PREFIX + await $.session.id())) {
      const now = await $.clock.now()
      await update($, warm, w => w ?? freshWarm(now))
    } else await update($, warm, () => null)
    $.clock.every(60e3, () => { update($, tick, n => n + 1) })
    $.clock.every(COLD_CHECK_MS, () => {
      read($, turn).then(async last => {
        if (!last) return
        const now = Date.now()
        const w = await read($, warm)
        if (w) {
          const draft = (await $.prompt.read()).text
          if (keepWarmDue({ now, last, running: running.size > 0, draft, warm: w, limit: warmLimit }) === 'ping') {
            await update($, warm, v => ({ ...(v ?? w), sent: (v ?? w).sent + 1, pingedFor: last.at }))
            void $.prompt.submit({ text: KEEP_WARM_PROMPT })
            return
          }
          // An armed keep-warm pings before the cache goes cold, so the cold pings would only be noise.
          if (warmArmed(last.ttlMs, w, warmLimit, now)) return
        }
        const left = last.at + last.ttlMs - now
        const step = coldStep(left, last.ttlMs)
        if (step === null || step < 0) return
        if (pinged.at === last.at && pinged.step >= step) return
        pinged = { at: last.at, step }
        const minutes = left >= 60e3 ? `${Math.round(left / 60e3)} min` : `${Math.round(left / 1e3)} s`
        const text = `Prompt cache ${COLD_STEPS[step] * 100}% warm · cold in ${minutes} · ${tokensText(last.tokens)} to rebuild`
        $.ui.toast(text, { timeoutMs: 10e3 })
        const folder = (await $.session.cwd().catch(() => '')).split('/').pop()
        await notify($, title ?? folder ?? 'Claude', text)
        if (options.iMessageTo) await sendIMessage($, String(options.iMessageTo), `${title ?? folder ?? 'Claude'}: ${text}`)
      })
    })
    return result
  })

  on('turn.start', async ($, e, next) => {
    running.add(e.turnId)
    warmTurn = e.text.includes(KEEP_WARM_PROMPT)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    try { return await next(e) } finally { running.delete(e.turnId) }
  })

  // Every prompt but this plugin's own pings (a hook never sees its plugin's own submit) restarts the idle count.
  on('prompt.submit', async ($, e, next) => {
    if (!e.agentId && (await read($, warm))) {
      const now = await $.clock.now()
      await update($, warm, w => (w ? freshWarm(now) : w))
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0) {
      await update($, limits, () => e.rateLimits)
      handOff($, e.rateLimits).catch(() => {})
    }
    const ttlMs = observedTtl ?? await cacheTtl($, e.rateLimits.length > 0)
    const at = await $.clock.now()
    if (e.rateLimits.length > 0) await trackWeek($, e.rateLimits, at).catch(() => {})
    const found = await readGift($).catch(() => null)
    await update($, gift, () => found)
    await update($, turn, () => ({ at, tokens: e.context.tokens ?? null, window: e.context.window ?? null, ttlMs }))
    const five = e.rateLimits.find(l => l.kind === 'five_hour')?.percentUsed ?? null
    const seven = e.rateLimits.find(l => l.kind === 'seven_day')?.percentUsed ?? null
    if (five !== null || seven !== null) {
      const { log } = await ownLog($, calibration)
      const last = log.readings[log.readings.length - 1]
      const t = Math.round(at / 1e3)
      if (!last || last[1] !== five || last[2] !== seven || t - (last[0] as number) >= READING_EVERY_S) log.readings.push([t, five, seven])
    }
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    const path: string | undefined = (e as any).transcript_path
    if (!path) return result
    const tail = await transcriptEnd($, 'tail', path)
    if (!tail) return result
    title = threadTitle(tail) ?? title
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
    const requests = lastTurn(tail)
    const mine = await ownLog($, calibration)
    const loggedUntil = mine.log.requests[mine.log.requests.length - 1]?.[0] ?? 0
    mine.log.requests.push(...requests.map(requestRow).filter(r => r[0] > loggedUntil).reverse())
    mine.log.updated = await $.clock.now()
    await saveLog($, mine)
    if (mine.log.updated - calibration.fittedAt >= REFIT_MS) await refit($, calibration)
    if (baseline && !warmTurn) {
      const fit = calibration.fits[0] ?? null
      const weights = usable(fit) ? fit.weights : null
      const value = turnMultiplier(requests, baseline.tokens, weights)
      await update($, multiplier, () => (value === null ? null : { value, measured: weights !== null }))
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, limits)
    const last = await read($, turn)
    const times = await read($, multiplier)
    const claimedAt = await read($, weekClaim)
    const lastGift = await read($, gift)
    const w = await read($, warm)
    await read($, tick)
    const below = await next(e)
    if (e.props.hasSurvey || (shown.length === 0 && !last)) return below
    const now = await $.clock.now()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const left = last ? last.at + last.ttlMs - now : null
    const cache = left === null || !last ? null
      : left > 0 ? { text: `${Math.ceil(left / 60e3)}m`, share: left / last.ttlMs, color: left <= COLD_SOON ? '#ff8c00' : '#f5f5f7' }
      : { text: 'cold', share: 0, color: '#ff453a' }
    const warmText = warmLabel(w, last, warmLimit, now)
    const context = last?.tokens && last.window ? { share: last.tokens / last.window, percent: Math.round((last.tokens / last.window) * 100) } : null
    const line = shown.map(l => `${labels[l.kind] ?? l.kind} ${Math.round(l.percentUsed)}%` + (l.resetsAt ? ` · ${resetText(l, now)}` : '')
      + (l.kind === 'seven_day' && lastGift ? ` · ${giftText(lastGift)}` : '')).join('   ')
      + (context ? `   ctx ${context.percent}% · ${tokensText(last!.tokens)}` : '')
      + (cache ? `   cache ${cache.text}` : '')
      + `   ${warmText}`
      + (times ? `   cost ×${times.value.toFixed(1)}${times.measured ? ' measured' : ''}` : '')
    // Wider than any terminal; the divider row clips it to the band's width.
    const divider = below ? <Box height={1} overflow="hidden"><Text dimColor>{'─'.repeat(400)}</Text></Box> : null
    if (e.surface !== 'desktop' || !('Svg' in ui)) return <Box flexDirection="column"><Text dimColor>{line}</Text>{divider}{below}</Box>
    const { Svg } = ui as any

    return (
      <Box flexDirection="column">
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        {shown.map(l => (
          <Box key={l.kind} flexDirection="row" alignItems="center" columnGap={1}>
            <Text dimColor>{labels[l.kind] ?? l.kind}</Text>
            <Svg source={bar(l, now, 120, 8, claimedAt)} alt={`${l.kind} ${l.percentUsed}%`} width={120} height={8} />
            <Text>{Math.round(l.percentUsed)}%</Text>
            {projected(l, now, claimedAt) !== null && projected(l, now, claimedAt)! > Math.round(l.percentUsed) ? <Text dimColor>→ {projected(l, now, claimedAt)}%</Text> : null}
            {l.resetsAt ? <Text dimColor>{resetText(l, now)}</Text> : null}
            {l.kind === 'seven_day' && lastGift ? <Text dimColor>{giftText(lastGift)}</Text> : null}
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
        <Button key="keep-warm" label={warmText} dimColor={w === null} onPress={() => setKeepWarm($, w === null)} />
        {times ? (
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            <Text dimColor>cost</Text>
            <Text>×{times.value.toFixed(1)}</Text>
            {times.measured ? <Text dimColor>measured</Text> : null}
          </Box>
        ) : null}
      </Box>
      {divider}
      {below}
      </Box>
    )
  })
}
