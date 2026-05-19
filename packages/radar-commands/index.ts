import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RadarItem } from "@radar/types";
import { getDb, markSeen, mute, query, remember, stats, unmute, velocity } from "../radar-memory/db.js";
import { fetchArxiv, fetchGitHubTrending, fetchHF, fetchHN, fetchReddit } from "../radar-sources/fetchers.js";

const PROFILE_PATH = join(homedir(), ".pi", "radar", "profile.md");
const db = getDb();

function readProfile(): string {
	if (!existsSync(PROFILE_PATH)) return "(no profile — run /radar profile to set one up)";
	return readFileSync(PROFILE_PATH, "utf8");
}

function since24h(): Date {
	return new Date(Date.now() - 24 * 3600 * 1000);
}

async function fetchAllSources(limit = 25): Promise<RadarItem[]> {
	const since = since24h();
	const results = await Promise.allSettled([
		fetchHN(limit, since, "AI OR LLM OR GPT OR agent"),
		fetchArxiv(limit, since),
		fetchGitHubTrending(Math.ceil(limit / 2), since),
		fetchHF(Math.ceil(limit / 2)),
		fetchReddit(limit, since),
	]);
	return results
		.filter((r): r is PromiseFulfilledResult<RadarItem[]> => r.status === "fulfilled")
		.flatMap((r) => r.value);
}

function fmtMetric(item: RadarItem): string {
	const m = item.metrics ?? {};
	if (m.points) return `${m.points} pts`;
	if (m.stars) return `★ ${m.stars}`;
	if (m.score) return `↑ ${m.score}`;
	if (m.likes) return `♥ ${m.likes}`;
	if (m.downloads) return `↓ ${m.downloads}`;
	return "—";
}

function today(): string {
	return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function parseMuteArg(arg: string): { pattern: string; kind: string } {
	for (const { prefix, kind } of [
		{ prefix: "domain:", kind: "domain" },
		{ prefix: "author:", kind: "author" },
		{ prefix: "source:", kind: "source" },
		{ prefix: "topic:", kind: "topic" },
	]) {
		if (arg.startsWith(prefix)) return { pattern: arg.slice(prefix.length).trim(), kind };
	}
	return { pattern: arg.trim(), kind: "topic" };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("radar", {
		description: "AI trends radar — digest, trending, explain, try, mute, unmute, profile, stats",
		getArgumentCompletions: (prefix) =>
			["digest", "trending", "explain", "try", "mute", "unmute", "profile", "stats"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),

		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] ?? "";
			const rest = parts.slice(1).join(" ").trim();

			switch (sub) {
				case "digest": {
					ctx.ui.notify("Checking cache…", "info");
					let items = query(db, {
						since: since24h().toISOString(),
						unseen: true,
						exclude_muted: true,
						limit: 60,
					});

					if (items.length < 25) {
						ctx.ui.notify(`${items.length} cached — fetching all sources in parallel…`, "info");
						const fresh = await fetchAllSources(30);
						ctx.ui.notify(`Fetched ${fresh.length} items, storing…`, "info");
						if (fresh.length > 0) {
							remember(db, fresh);
							items = query(db, {
								since: since24h().toISOString(),
								unseen: true,
								exclude_muted: true,
								limit: 60,
							});
						}
					}

					if (items.length === 0) {
						ctx.ui.notify("No items found — check your network.", "warning");
						return;
					}

					const profile = readProfile();
					const slim = items.map((i) => ({
						id: i.id,
						title: i.title,
						url: i.url,
						source: i.source,
						signal: fmtMetric(i),
						summary: i.summary?.slice(0, 150),
						tags: i.tags?.slice(0, 5),
					}));

					pi.sendUserMessage(
						`You are a terse AI trends editor. Today is ${today()}.

My profile:
${profile}

${items.length} candidate items:
${JSON.stringify(slim)}

Task:
1. Pick the 8 most relevant items for this profile. Skip anything matching Skip/Hard mutes.
2. Output ONLY the following markdown — no preamble, no commentary, no tool call narration:

## Radar · ${today()}

| # | Title | Source | Signal | Why it matters to you |
|---|-------|--------|--------|-----------------------|
| 1 | [title](url) | src | signal | one sentence referencing my profile |
| 2 | … | … | … | … |

> **Vibe:** one sentence.

3. After the table, call radar_mark_seen with the 8 item IDs and action="shown". Output nothing after the tool call.`,
					);
					break;
				}

				case "trending": {
					let vel = velocity(db, 24);

					if (vel.length < 3) {
						ctx.ui.notify("Seeding velocity data…", "info");
						const fresh = await fetchAllSources(30);
						if (fresh.length > 0) remember(db, fresh);
						vel = velocity(db, 24);
					}

					if (vel.length === 0) {
						ctx.ui.notify("No velocity data yet — need ≥2 snapshots per item. Run /radar digest twice.", "info");
						return;
					}

					const top = vel.slice(0, 12).map((v) => ({
						title: v.item.title,
						url: v.item.url,
						source: v.item.source,
						top_metric: Object.entries(v.deltas).sort((a, b) => b[1] - a[1])[0],
						delta_per_hour: Math.round(v.max_delta_per_hour * 10) / 10,
					}));

					pi.sendUserMessage(
						`Output ONLY this markdown — no commentary:

## Trending · ${today()}

| # | Title | Source | Metric | Δ/hr |
|---|-------|--------|--------|------|
${top.map((v, i) => `| ${i + 1} | [${v.title.slice(0, 60)}](${v.url}) | ${v.source} | ${v.top_metric?.[0] ?? "—"} | +${v.delta_per_hour} |`).join("\n")}

Data: ${JSON.stringify(top)}`,
					);
					break;
				}

				case "explain": {
					if (!rest) {
						ctx.ui.notify("Usage: /radar explain <item-id-or-title>", "warning");
						return;
					}
					const profile = readProfile();
					pi.sendUserMessage(
						`Find the radar item matching "${rest}" via radar_query, read its URL, then write for someone with this profile:

${profile}

Format (no preamble):
**What:** 2 sentences.
**Why it matters:** technical significance.
**3 takeaways:** concrete things I can use or do.
**Caveats:** any red flags.

Under 250 words total.`,
					);
					break;
				}

				case "try": {
					if (!rest) {
						ctx.ui.notify("Usage: /radar try <github-repo>", "warning");
						return;
					}
					pi.sendUserMessage(
						`For "${rest}": find its GitHub URL (check radar_query if not a repo slug), read the README, then output a ready-to-paste shell block that clones + installs + runs it. Prefer Docker if available. Ask before executing.`,
					);
					break;
				}

				case "mute": {
					if (!rest) {
						ctx.ui.notify("Usage: /radar mute <domain:x | author:x | source:x | topic>", "warning");
						return;
					}
					const { pattern, kind } = parseMuteArg(rest);
					mute(db, pattern, kind, "user muted");
					ctx.ui.notify(`Muted ${kind}:${pattern}`, "info");
					break;
				}

				case "unmute": {
					if (!rest) {
						ctx.ui.notify("Usage: /radar unmute <pattern>", "warning");
						return;
					}
					unmute(db, rest);
					ctx.ui.notify(`Unmuted: ${rest}`, "info");
					break;
				}

				case "profile": {
					ctx.ui.notify(`Profile: ${PROFILE_PATH}`, "info");
					break;
				}

				case "stats": {
					const s = stats(db);
					const bySource = Object.entries(s.counts_by_source)
						.map(([k, v]) => `${k}:${v}`)
						.join("  ");
					ctx.ui.notify(
						[
							`DB: ${s.db_path}`,
							`Items: ${s.total_items}  Seen: ${s.total_seen}  Mutes: ${s.total_mutes}`,
							bySource ? `Sources: ${bySource}` : "Sources: (empty)",
							s.newest_item ? `Newest: ${new Date(s.newest_item).toLocaleString()}` : "",
						]
							.filter(Boolean)
							.join("\n"),
						"info",
					);
					break;
				}

				default: {
					ctx.ui.notify(
						[
							"/radar digest      — top 8 items today, ranked for you",
							"/radar trending    — fastest-rising metrics",
							"/radar explain <x> — deep dive on an item",
							"/radar try <repo>  — sandbox a GitHub repo",
							"/radar mute <x>    — domain:/author:/source:/topic",
							"/radar unmute <x>",
							"/radar profile     — show profile path",
							"/radar stats       — DB stats",
						].join("\n"),
						"info",
					);
				}
			}
		},
	});
}
