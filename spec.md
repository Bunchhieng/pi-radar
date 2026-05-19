# Build `radar` — a pi-mono extension bundle for tracking AI trends

You are helping me build a TypeScript extension bundle for the **pi coding agent** (`pi-mono` by Mario Zechner / `@mariozechner/pi-coding-agent`). The bundle is called `radar` and it turns pi into a personal AI-trends radar: fetch from multiple sources, dedup, score against my interests, surface what's actually worth my attention, and let me sandbox-try tools without leaving the terminal.

This is a vibe-coding session. Move fast, ship an MVP, then iterate. Prefer working code over perfect code. When in doubt about the pi API, **read the actual source** rather than guessing.

---

## Step 0 — Ground yourself in the real pi-mono API first

**Do not write any code before doing this.** The pi-mono API evolves; my description below may be stale.

1. Clone or browse `https://github.com/badlogic/pi-mono` and read:
   - The root `README.md`
   - `packages/coding-agent/README.md`
   - **All files** in `packages/coding-agent/examples/extensions/` (especially `todo.ts` and `tools.ts` — they show how to register tools, slash commands, persist state, and render UI)
   - `packages/coding-agent/examples/sdk/06-extensions.ts` for the extension loading model
   - The exported types from `@mariozechner/pi-coding-agent` (`ExtensionAPI`, `ExtensionContext`, `ToolInfo`, etc.)
2. Also skim `https://github.com/qualisero/awesome-pi-agent` for existing extensions we can compose with or learn from (e.g. `pi-amplike` for web search, `pi-stuffed` for Reddit, `sysid/pi-extensions` for sandboxing).
3. Summarize back to me in 5 bullets:
   - How tools are registered and what their handler signature is
   - How slash commands are registered
   - How to persist state (session-scoped vs. user-scoped on disk)
   - How to add custom TUI components
   - Where extensions are loaded from on disk

Only after that summary do we start building.

---

## Mission

Build five extensions that together let me run `/radar digest` inside pi and get a ranked, deduped briefing of what's new in AI in the last 24h that's relevant to me.

The agent (pi) does the LLM thinking. We just give it tools, slash commands, memory, and a profile.

---

## Architecture

Five extension files, one repo, npm workspaces. Mirror the structure of `sysid/pi-extensions`:

```
radar/
├── packages/
│   ├── radar-sources/      # fetch tools (HN, arXiv, GitHub, HF, Reddit, RSS)
│   ├── radar-memory/       # SQLite store: dedup, history, velocity, seen/mute
│   ├── radar-profile/      # ~/.pi/radar/profile.md reader
│   ├── radar-commands/     # /radar digest, /radar trending, /radar try, etc.
│   └── radar-ui/           # TUI components for digest cards (optional in MVP)
├── package.json            # workspaces root
├── tsconfig.json
├── biome.json
└── vitest.config.ts
```

Each package is a pi extension: a TS file exporting `default function(pi: ExtensionAPI) { ... }`. Install target is `~/.pi/agent/extensions/` (symlink during dev).

---

## Extension specs

### 1. `radar-sources`

Register one LLM-callable tool per source. All tools return a **normalized item array** so the agent can chain them:

```ts
type RadarItem = {
  id: string;              // sha256(source + canonical_url), first 16 chars
  source: 'hn' | 'arxiv' | 'github' | 'hf' | 'reddit' | 'rss';
  source_id: string;       // original id at the source
  title: string;
  url: string;
  canonical_url: string;   // strip utm_*, lowercase host, no trailing slash
  summary?: string;        // first paragraph / abstract / description
  author?: string;
  published_at: number;    // unix ms
  metrics?: {              // whatever the source gives us
    points?: number;       // hn
    stars?: number;        // github
    forks?: number;        // github
    likes?: number;        // hf
    downloads?: number;    // hf
    score?: number;        // reddit
    comments?: number;
  };
  tags?: string[];
};
```

Tools to register:

| Tool name | Source | Endpoint |
|---|---|---|
| `radar_fetch_hn` | Hacker News | Algolia: `https://hn.algolia.com/api/v1/search_by_date?tags=story&query=<q>&hitsPerPage=50` (default `q="AI OR LLM OR GPT"`) |
| `radar_fetch_arxiv` | arXiv | `http://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG&sortBy=submittedDate&sortOrder=descending&max_results=50` (parse Atom XML) |
| `radar_fetch_github_trending` | GitHub | Search API: `https://api.github.com/search/repositories?q=topic:llm+OR+topic:ai-agent+created:>{date}&sort=stars&order=desc` (use `GITHUB_TOKEN` from env if set, falls back to unauth with lower rate limit) |
| `radar_fetch_hf` | Hugging Face | `https://huggingface.co/api/models?sort=trendingScore&limit=30&full=true` and same for `/datasets` |
| `radar_fetch_reddit` | Reddit | `https://www.reddit.com/r/{sub}/top.json?t=day&limit=50` for subs: `LocalLLaMA`, `MachineLearning`, `singularity`, `OpenAI`. **Must send a custom `User-Agent`** like `radar-pi/0.1 (by /u/...)` or you'll get 429d. |
| `radar_fetch_rss` | Generic RSS | Take a `url` param. Use `rss-parser`. |

Each tool's input schema (typebox): `{ limit?: number, since?: string (ISO), query?: string }`. Default `since` is "24h ago", default `limit` is 30.

Each tool's output: `{ items: RadarItem[], fetched_at: number, source: string }`.

Implementation notes:
- Use `undici` or native `fetch` (Node 20+).
- Be polite: 1-2 req/s per source max, exponential backoff on 429.
- Don't crash the agent on a single source failure — return `{ items: [], error: "..." }`.

### 2. `radar-memory`

Local SQLite at `~/.pi/radar/radar.db` using `better-sqlite3` (sync API, fits pi's runtime fine).

**Schema** (run on first load with `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  summary TEXT,
  author TEXT,
  published_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  raw_json TEXT,
  tags TEXT  -- json array
);

CREATE TABLE metrics_snapshots (
  item_id TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (item_id, taken_at, metric)
);

CREATE TABLE seen (
  item_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL,
  action TEXT  -- 'shown' | 'opened' | 'tried' | 'dismissed'
);

CREATE TABLE mutes (
  pattern TEXT PRIMARY KEY,
  kind TEXT NOT NULL,  -- 'topic' | 'domain' | 'author' | 'source'
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_items_published ON items(published_at DESC);
CREATE INDEX idx_items_canonical ON items(canonical_url);
CREATE INDEX idx_metrics_item ON metrics_snapshots(item_id, taken_at DESC);
```

Tools to register:

- `radar_remember(items: RadarItem[])` — upsert into `items`, record metrics snapshot, return `{ inserted, updated, deduped }`. Dedup logic: same `canonical_url` across sources = merge into one item, keep all source links in a sub-table or as a json column (your call).
- `radar_query({ since?, sources?, unseen?, limit?, exclude_muted? })` — return matching items with their *latest* metrics.
- `radar_velocity({ window_hours: 24 })` — for each item with >=2 snapshots in window, compute delta/hour for each metric; return sorted by max delta.
- `radar_mark_seen(item_ids, action)` — upsert into `seen`.
- `radar_mute({ pattern, kind, reason })` and `radar_unmute(pattern)`.
- `radar_stats()` — counts by source, oldest/newest item, db size. Useful for debugging.

### 3. `radar-profile`

A markdown file at `~/.pi/radar/profile.md`. Create it from a template on first run if missing. The extension registers one tool:

- `radar_profile()` → returns the raw markdown string.

The agent reads this when ranking. No parsing needed — let the LLM interpret it.

**Template to write on first run:**

```markdown
# Radar Profile

## My stack
- (e.g. TypeScript, Python, Postgres, AWS)

## High interest
- (e.g. RAG, retrieval, embeddings)
- (e.g. agent frameworks, evals)

## Medium interest
- (e.g. multimodal, coding agents)

## Skip
- (e.g. image generation, robotics, crypto x AI)

## Hard mutes
- (e.g. "ChatGPT wrapper startup", "AGI predictions")

## Tone preferences
- Prefer technical depth over hype
- Skip vendor announcements unless there's a real artifact (code, paper, weights)
```

Also register a slash command `/radar profile` that opens the file in `$EDITOR`.

### 4. `radar-commands`

The user-facing surface. Each slash command is essentially "compose a prompt that orchestrates the tools above."

- **`/radar digest`** — fetch fresh items (only if last fetch >1h ago), dedup via memory, rank against profile, show top 8 with one-line "why you care" + source + key metric. Mark shown items as `seen:shown`.
- **`/radar trending`** — call `radar_velocity`, show items with the fastest-rising metrics regardless of relevance. This is the "what is everyone suddenly talking about" view.
- **`/radar explain <id>`** — fetch the underlying URL (use `web_fetch` if available, or compose with `pi-amplike`'s Jina tool), summarize it for someone with my profile, surface 3 concrete takeaways.
- **`/radar try <repo_or_id>`** — for GitHub items, run the repo in a sandbox. Use `sysid/pi-extensions`'s sandbox if installed; otherwise shell out to `docker run --rm -it -v $(pwd):/work node:20-bookworm bash` with the repo cloned in. Show the user the install/run commands from the repo's README.
- **`/radar mute <pattern>`** — adds a mute. Accept formats like `domain:medium.com`, `author:somebody`, `source:reddit`, or bare topic strings.
- **`/radar profile`** — opens profile in `$EDITOR`.
- **`/radar stats`** — debug info.

For commands that involve the LLM (digest, trending, explain), the implementation is roughly:

```ts
pi.registerCommand("/radar digest", async (ctx) => {
  await ctx.sendPrompt(`
You are the radar. Build today's AI digest.

1. Call radar_query({ since: "24h", unseen: true, exclude_muted: true }).
2. If you got fewer than 25 items, top up by calling radar_fetch_hn, radar_fetch_arxiv,
   radar_fetch_github_trending, radar_fetch_hf, and radar_fetch_reddit in parallel.
   Then radar_remember the results.
3. Call radar_profile() once. Read it carefully.
4. Rank the items by (relevance to profile × signal strength). Drop anything matching mutes.
5. Pick the top 8.
6. For each, render a card with:
   - Title and source (with link)
   - One-line WHY THIS MATTERS, written for me specifically (referencing my profile)
   - Key metric (points, stars, etc.)
7. Call radar_mark_seen with all 8 ids, action="shown".
8. End with a one-sentence vibe-of-the-day summary.

Be terse. No filler. No "I'll help you with...". Just the digest.
  `.trim());
});
```

The structure is the same for `/radar trending` and `/radar explain` — different prompts, same tools.

### 5. `radar-ui` (optional for MVP)

Custom pi-tui components for rendering digest cards (border, title with link, metric chip, "why" line). Use `Container`, `Text`, and the theme helpers from `@mariozechner/pi-tui`. Skip this in v0 — let the agent render markdown.

---

## Build order

Do these in sequence, commit between each. Don't try to build everything before running anything.

1. **Scaffold** the monorepo (`pnpm` workspaces, biome, vitest, tsconfig). One trivial extension that just `console.log`s on `agent_start` to confirm pi loads it.
2. **`radar-memory` first**, since everything depends on it. Build it, write unit tests for `remember`, `query`, `velocity` with seeded data. No pi integration yet — just a pure TS module + a thin extension wrapper.
3. **`radar-profile`** — trivial, but get the file-creation-on-first-run path right.
4. **`radar-sources`** — start with `radar_fetch_hn` and `radar_fetch_arxiv` only. Verify the normalized shape end-to-end. Then add the rest.
5. **`radar-commands`** — implement `/radar digest` first. Iterate on the prompt until the output is actually good. Then add `trending`, `mute`, `stats`. Save `try` and `explain` for last.
6. **`radar-ui`** — only after the above is working and I tell you I want prettier output.

---

## Testing checklist

- [ ] `pnpm install && pnpm build` from clean clone works
- [ ] `pnpm test` passes (vitest for memory + sources, mocked HTTP)
- [ ] Symlink extensions into `~/.pi/agent/extensions/`, run `pi`, confirm tools show up via `/tools`
- [ ] `/radar stats` reports a fresh empty DB
- [ ] `/radar digest` from cold: fetches, dedups, persists, renders cards, marks seen
- [ ] `/radar digest` again immediately: uses cache, doesn't re-fetch, shows nothing new
- [ ] `/radar mute domain:example.com` actually hides those items from the next digest
- [ ] DB survives killing and restarting pi
- [ ] Network failure on one source doesn't crash the digest

---

## Tools you should use as you work

- **Bash** — running `pnpm`, `pi`, tests
- **File editing** — Read / Write / Edit
- **WebFetch + WebSearch** — for looking up current pi-mono types, source API docs, and rate limits. Don't trust my endpoint URLs above without verifying them.
- **GitHub MCP** if available — browse `pi-mono` examples directly
- Run **`pnpm test`** after every package you finish, not at the end

---

## What to flag back to me

- Any place where the pi API in step 0 differs from what I described — adjust freely
- API rate limits that bite earlier than expected (especially Reddit and GitHub unauth)
- Schema decisions where you went a different direction
- Things I should add to my `profile.md` for the ranker to work well

Start with **step 0**. Read pi-mono, summarize the API back to me in 5 bullets, and wait for me to say go before scaffolding.