# quota-band

A Claude Code mod that keeps your plan's usage in view: one line above the prompt with the 5-hour and weekly windows, the context window, the prompt cache's time left and what the context adds to each turn's cost.

```
5h ▬▬▬▬▬▬▬▬▬ 93% → 100% 23:10    7d ▬▬▬▬▬▬▬ 72% 11:00    ctx ▬▬▬ 37% 370k    cache ▬▬▬ 42m    keep-warm off    cost ×4.5
```

- Each bar fills with the percent used. A grey tick marks how much of the window has passed, and the notches are hours (5h) or days (7d).
- A saved reset claimed in the Claude app zeroes the week but keeps its reset time, so from the first reading after the claim the 7d bar runs from the claim to the reset. A claim made while no session was running shows at the next session's first response.
- Where the Agent Profiles Mac app is installed, the 7d row also shows the week's last gift reset, who spent it and where (`🎁 Sat 23:51 · Andras · Mac`), from the file that app writes per account.
- Colours: red from 95%, orange from 80%, yellow while you are ahead of an even pace, white otherwise.
- `→ N%` is where the current pace lands by the reset, with a dashed outline on the bar.
- The time is when the window resets.
- `ctx` is how full the context window is; `370k` is what the next request re-sends, which a cold cache has to write again.
- `cache` drains over the time the prompt cache stays warm after the last response: the length the last response actually wrote, read from the transcript at the end of each turn, so it drops to five minutes in overage. Until the first turn ends (and on Windows, which has no `tail`) it assumes an hour on a subscription's main thread, five minutes otherwise, or what `promptCacheTtl` sets. It turns orange in the last five minutes and red once cold. When 50%, 25%, 10% and 5% of the lifetime is left, every thread pings with a toast and, on macOS, a Notification Centre banner titled with the thread's name (`osascript`, so the banner comes from Script Editor, which macOS may ask to allow once). Set `iMessageTo` (below) to a phone number or Apple ID to get the same pings on the phone, sent through this Mac's Messages app; macOS asks once to let Claude control Messages.
- `keep-warm` says whether this thread is kept warm and when the next ping goes out (below). On the desktop app it is a button that turns it on or off.
- `cost ×4.5` is what the last turn cost over the same turn in a fresh thread. Every request in a turn (one per tool call) resends the context, so a long thread costs more per message even with a warm cache. The fresh thread starts from what the session's first request sent (system prompt, tools, rules). Token kinds are weighed at API price ratios: cache read 0.1, cache write 1.25 (5 minutes) or 2 (1 hour), output 5, against uncached input 1. How the plan's quotas weigh them is not published, so treat it as an estimate.
- Once the plan's own readings have measured the weights (below), `cost` uses those and says `measured`.

## Measured quota weights

Each session logs its requests' token counts and the 5h and 7d readings to the plugin's store, kept for eight days. Readings from all sessions are cut into intervals in which a window rose at least one point, and a least-squares fit gives how many cache-write tokens make 1% and what a cache read weighs against a cache write. Output stays at the API ratio of 2.5 cache writes per token: it is about a tenth of the quota use, too little to separate from the noise. `/quota-weights` prints the fit:

```
5h: 52 intervals, 3 dropped as usage elsewhere; 1% = 2.0M cache-write tokens; cache read = 0.052 (0.048 to 0.058) of a cache write, API 0.05 to 0.08
7d: 6 intervals; 1% = 14.1M cache-write tokens; cache read = 0.061 (0.030 to 0.090) of a cache write, API 0.05 to 0.08
output stays at 2.5 cache writes per token
cost × uses measured 5h weights
```

The readings cover the whole account, so usage the log cannot see (claude.ai, another machine, subagents) lands in them too. Intervals that used 30% more than the fit predicts are dropped as such, intervals across a 30-minute silence are skipped, and `cost` switches to measured weights only after 20 intervals with the cache read's 10th to 90th percentile range within ±25%.

## Keep warm

Off for every thread until you turn it on for one with `/keep-warm` (or `/keep-warm on`, `/keep-warm off`; bare flips it), or by clicking `keep-warm off` in the band on the desktop app. The setting is kept per thread in the plugin's store, so it survives a restart of the app. While it is on and the thread is idle (no turn running, prompt box empty) with about 3 minutes of cache left, the band sends `keep-warm: reply with only "ok"` as a plugin message, so the next prompt reads the context from the cache instead of writing it again. While it is on the cold pings stay quiet, since the cache does not go cold.

The band's segment, one state at a time:

- `keep-warm off`: not on for this thread, or turned off because the thread's title was tagged `[x]`, `[r]` or `[p]` (closed or parked, as close-thread does).
- `keep-warm 13:47 · 2 sent`: the local time of the next ping, and the pings since your last prompt. A time already past means the ping waits for the turn to end or the prompt box to empty.
- `keep-warm pinging`: a ping was sent and its turn has not ended yet.
- `keep-warm stopped · 3 pings without a prompt` (or `· 2h without a prompt`): `keepWarmMaxIdle` was reached; your next prompt starts it again.
- `keep-warm paused · overage`: the cache lives five minutes, so no pings (below).
- `keep-warm on · cache cold`: the cache went cold before a ping could go out (you were typing, or a turn ran); the next response arms it again.
- `keep-warm on`: no response yet in this session to time from.

- One ping costs a cache read of the whole context, about 0.05 of a cache write by the band's own fit (0.1 of uncached input at API prices), plus a few tokens of output. Letting it go cold costs re-writing the whole context at the next prompt: 1.25x (5-minute write) to 2x (1-hour write) of uncached input. On a 400k thread that is about 20k cache-write tokens per ping against 400k to rebuild, so up to about 20 pings cost what one cold rebuild does.
- `keepWarmMaxIdle` stops it so an abandoned thread does not burn quota: `3` (the default) stops after three pings in a row with no prompt of yours, `2h` two hours after your last prompt. Any prompt you send starts the count again.
- It stands down in overage, where the cache lives five minutes: a ping every four minutes costs more than the rebuild it saves.
- A ping's turn is logged for the quota fit but does not replace the last turn's `cost`.

```json
"pluginConfigs": {
  "quota-band@claude-quota-band": { "options": { "keepWarmMaxIdle": "3" } }
}
```

## Phone pings

The cache pings can also go to your phone as an iMessage from this Mac. Set `iMessageTo` in `/config` under the plugin's options, or in `settings.json`:

```json
"pluginConfigs": {
  "quota-band@claude-quota-band": { "options": { "iMessageTo": "" } }
}
```

The close and rename buttons moved to [prompt-buttons](https://github.com/andras-gyarmati/claude-prompt-buttons).

It reads the figures Claude Code already receives with each response (`session.measure`), and the ends of the session's transcript at the end of each turn, so it sends no requests of its own. It writes to its own plugin store and, where the Agent Profiles Mac app is installed, the latest figures per account to `~/Library/Application Support/Agent Profiles/mod-readings/`, which that app shows instead of asking Anthropic. The figures appear after the first response of a session, on Pro, Max and Team plans.

## Install

Needs Claude Code 2.1.287 or later (Claude Mods). In Claude Code:

```
/plugin marketplace add andras-gyarmati/claude-quota-band
/plugin install quota-band@claude-quota-band
```

To pick up new versions on each start, set `"autoUpdate": true` for this marketplace under `extraKnownMarketplaces` in `settings.json`.

Bars draw in the desktop app's Code tab; the terminal shows the same line as text.
