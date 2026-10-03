# quota-band

A Claude Code mod that keeps your plan's usage in view: one line above the prompt with the 5-hour and weekly windows.

```
5h ▬▬▬▬▬▬▬▬▬ 93% → 100% 23:10    7d ▬▬▬▬▬▬▬ 72% 11:00
```

- Each bar fills with the percent used. A grey tick marks how much of the window has passed, and the notches are hours (5h) or days (7d).
- Colours: red from 95%, orange from 80%, yellow while you are ahead of an even pace, white otherwise.
- `→ N%` is where the current pace lands by the reset, with a dashed outline on the bar.
- The time is when the window resets.

It reads the figures Claude Code already receives with each response (`session.measure`), so it sends no requests of its own and reads or writes no files. The figures appear after the first response of a session, on Pro, Max and Team plans.

## Install

Needs Claude Code 2.1.287 or later (Claude Mods). In Claude Code:

```
/plugin marketplace add andras-gyarmati/claude-quota-band
/plugin install quota-band@claude-quota-band
```

Bars draw in the desktop app's Code tab; the terminal shows the same line as text.
