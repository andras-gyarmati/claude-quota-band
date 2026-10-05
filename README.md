# quota-band

A Claude Code mod that keeps your plan's usage in view: one line above the prompt with the 5-hour and weekly windows, the context window, the prompt cache's time left and what the context adds to each turn's cost.

```
5h ▬▬▬▬▬▬▬▬▬ 93% → 100% 23:10    7d ▬▬▬▬▬▬▬ 72% 11:00    ctx ▬▬▬ 37% 370k    cache ▬▬▬ 42m    cost ×4.5
```

- Each bar fills with the percent used. A grey tick marks how much of the window has passed, and the notches are hours (5h) or days (7d).
- Colours: red from 95%, orange from 80%, yellow while you are ahead of an even pace, white otherwise.
- `→ N%` is where the current pace lands by the reset, with a dashed outline on the bar.
- The time is when the window resets.
- `ctx` is how full the context window is; `370k` is what the next request re-sends, which a cold cache has to write again.
- `cache` drains over the time the prompt cache stays warm after the last response: the length the last response actually wrote, read from the transcript at the end of each turn, so it drops to five minutes in overage. Until the first turn ends (and on Windows, which has no `tail`) it assumes an hour on a subscription's main thread, five minutes otherwise, or what `promptCacheTtl` sets. It turns orange in the last five minutes, with a toast, and red once cold.
- `cost ×4.5` is what the last turn cost over the same turn in a fresh thread. Every request in a turn (one per tool call) resends the context, so a long thread costs more per message even with a warm cache. The fresh thread starts from what the session's first request sent (system prompt, tools, rules). Token kinds are weighed at API price ratios: cache read 0.1, cache write 1.25 (5 minutes) or 2 (1 hour), output 5, against uncached input 1. How the plan's quotas weigh them is not published, so treat it as an estimate.

## Buttons

Two optional buttons send a prompt of your choice, for example a wrap-up skill. Set them in `/config` under the plugin's options, or in `settings.json`:

```json
"pluginConfigs": {
  "quota-band@claude-quota-band": {
    "options": { "closeCommand": "/close-thread", "renamePrompt": "Rename this thread to cover every topic in it" }
  }
}
```

Empty hides a button. A press during a turn waits until the turn ends.

It reads the figures Claude Code already receives with each response (`session.measure`), and the ends of the session's transcript at the end of each turn, so it sends no requests of its own and writes no files. The figures appear after the first response of a session, on Pro, Max and Team plans.

## Install

Needs Claude Code 2.1.287 or later (Claude Mods). In Claude Code:

```
/plugin marketplace add andras-gyarmati/claude-quota-band
/plugin install quota-band@claude-quota-band
```

To pick up new versions on each start, set `"autoUpdate": true` for this marketplace under `extraKnownMarketplaces` in `settings.json`.

Bars draw in the desktop app's Code tab; the terminal shows the same line as text.
