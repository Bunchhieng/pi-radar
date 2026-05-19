# pi-radar

A [pi](https://github.com/earendil-works/pi-mono) extension that turns your terminal into a personal AI trends radar.

## Why

AI moves fast. Keeping up means context-switching between HN, arXiv, Reddit, GitHub, and HuggingFace — then manually filtering the noise. pi-radar pulls all of that into one place, deduplicates it, and ranks it against your interests so you only read what actually matters.

## How it works

Type `/radar digest` inside pi. It fetches from all sources in parallel, stores everything in a local SQLite DB, and hands the ranked results to the LLM — which outputs a clean table of the top 8 items with a one-line "why this matters to you" for each.

The LLM only ranks and formats. All fetching, dedup, and caching happens in TypeScript.

## Install

```bash
pi install git:github.com/Bunchhieng/pi-radar
```

Then start (or restart) `pi`.

### Dev install

```bash
git clone git@github.com:Bunchhieng/pi-radar.git
cd pi-radar
pnpm install

ln -s $(pwd)/packages/radar-memory   ~/.pi/agent/extensions/radar-memory
ln -s $(pwd)/packages/radar-sources  ~/.pi/agent/extensions/radar-sources
ln -s $(pwd)/packages/radar-profile  ~/.pi/agent/extensions/radar-profile
ln -s $(pwd)/packages/radar-commands ~/.pi/agent/extensions/radar-commands
```

## Commands

| Command | What it does |
|---------|-------------|
| `/radar digest` | Top 8 items from the last 24h, ranked for your profile |
| `/radar trending` | Fastest-rising items by metric velocity, no filtering |
| `/radar explain <id>` | Deep dive on an item — what it is, why it matters, 3 takeaways |
| `/radar try <repo>` | Generates install/run steps for a GitHub repo |
| `/radar mute <pattern>` | Silence a domain, author, source, or topic |
| `/radar unmute <pattern>` | Remove a mute |
| `/radar profile` | Shows path to your profile file |
| `/radar stats` | DB stats — item counts, sources, newest entry |

Mute patterns: `domain:medium.com`, `author:someone`, `source:reddit`, or bare topic strings like `"image generation"`.

## Personalisation

On first run, pi-radar creates `~/.pi/radar/profile.md`. Edit it to describe your stack, interests, and what to skip. The LLM reads this when ranking — the more specific, the better the digest.

## Sources

HN · arXiv (cs.AI, cs.CL, cs.LG) · GitHub trending · HuggingFace models & datasets · Reddit (r/LocalLLaMA, r/MachineLearning, r/singularity, r/OpenAI) · any RSS feed via `radar_fetch_rss`

Set `GITHUB_TOKEN` in your environment for higher GitHub API rate limits.

## Dev

```bash
pnpm test   # 14 unit tests
```
