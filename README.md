# quota-band

A Claude Code mod that keeps your plan's usage in view: one line above the prompt with the 5-hour and weekly windows and the prompt cache's time left.

```
5h ▬▬▬▬▬▬▬▬▬ 93% → 100% 23:10    7d ▬▬▬▬▬▬▬ 72% 11:00    cache 42m 370k
```

- Each bar fills with the percent used. A grey tick marks how much of the window has passed, and the notches are hours (5h) or days (7d).
- Colours: red from 95%, orange from 80%, yellow while you are ahead of an even pace, white otherwise.
- `→ N%` is where the current pace lands by the reset, with a dashed outline on the bar.
- The time is when the window resets.
- `cache 42m` is how long the prompt cache stays warm after the last response: an hour on a subscription's main thread, five minutes otherwise, or what `promptCacheTtl` sets. `370k` is the context the next request re-sends, which a cold cache has to write again. It turns orange in the last five minutes, with a toast, and red once cold.

## Buttons

Two optional buttons send a prompt of your choice, for example a wrap-up skill. Set them in `/config` under the plugin's options, or in `settings.json`:

```json
"pluginConfigs": {
  "quota-band@claude-quota-band": {
    "options": { "closeCommand": "/close-thread", "renamePrompt": "Rename this thread to cover every topic in it" }
  }
}
```

Empty hides a button. They hide while a turn runs.

It reads the figures Claude Code already receives with each response (`session.measure`), so it sends no requests of its own and reads or writes no files. The figures appear after the first response of a session, on Pro, Max and Team plans.

## Install

Needs Claude Code 2.1.287 or later (Claude Mods). In Claude Code:

```
/plugin marketplace add andras-gyarmati/claude-quota-band
/plugin install quota-band@claude-quota-band
```

To pick up new versions on each start, set `"autoUpdate": true` for this marketplace under `extraKnownMarketplaces` in `settings.json`.

Bars draw in the desktop app's Code tab; the terminal shows the same line as text.
