import type { FetchResult, RadarItem, RadarSource } from "@radar/types";
import RssParser from "rss-parser";
import { canonicalize, fetchWithRetry, makeId, sinceDefault } from "./utils.js";

export async function safeFetch(
	source: RadarSource,
	fetcher: () => Promise<RadarItem[]>,
): Promise<FetchResult> {
	try {
		const items = await fetcher();
		return { items, fetched_at: Date.now(), source };
	} catch (e) {
		return { items: [], fetched_at: Date.now(), source, error: String(e) };
	}
}

export async function fetchHN(limit: number, since: Date, query: string): Promise<RadarItem[]> {
	const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&query=${encodeURIComponent(query)}&hitsPerPage=${limit}&numericFilters=created_at_i>${Math.floor(since.getTime() / 1000)}`;
	const resp = await fetchWithRetry(url);
	if (!resp.ok) throw new Error(`HN API ${resp.status}`);
	const data = (await resp.json()) as { hits: any[] };
	const sinceMs = since.getTime();
	return data.hits
		.filter((h: any) => h.created_at_i * 1000 >= sinceMs)
		.slice(0, limit)
		.map((h: any) => {
			const rawUrl = h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`;
			const canon = canonicalize(rawUrl);
			return {
				id: makeId("hn", canon),
				source: "hn" as const,
				source_id: h.objectID,
				title: h.title,
				url: rawUrl,
				canonical_url: canon,
				author: h.author,
				published_at: h.created_at_i * 1000,
				metrics: { points: h.points ?? 0, comments: h.num_comments ?? 0 },
				tags: [],
			};
		});
}

export async function fetchArxiv(limit: number, since: Date): Promise<RadarItem[]> {
	const url = `https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG&sortBy=submittedDate&sortOrder=descending&max_results=${limit}`;
	const resp = await fetchWithRetry(url);
	if (!resp.ok) throw new Error(`arXiv API ${resp.status}`);
	const xml = await resp.text();
	const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
	const sinceMs = since.getTime();
	const items: RadarItem[] = [];
	for (const entry of entries) {
		const title =
			(entry.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1]?.replace(/\s+/g, " ").trim() ?? "";
		const id =
			(entry.match(/<id>(https?:\/\/arxiv\.org\/abs\/[^<]+)<\/id>/) ?? [])[1] ?? "";
		const summary =
			(entry.match(/<summary>([\s\S]*?)<\/summary>/) ?? [])[1]?.replace(/\s+/g, " ").trim() ?? "";
		const published =
			(entry.match(/<published>([\s\S]*?)<\/published>/) ?? [])[1]?.trim() ?? "";
		const author = (entry.match(/<name>([\s\S]*?)<\/name>/) ?? [])[1]?.trim() ?? "";
		const publishedMs = published ? new Date(published).getTime() : 0;
		if (!id || publishedMs < sinceMs) continue;
		const canon = canonicalize(id);
		const arxivId = id.replace(/https?:\/\/arxiv\.org\/abs\//, "");
		items.push({
			id: makeId("arxiv", canon),
			source: "arxiv",
			source_id: arxivId,
			title,
			url: id,
			canonical_url: canon,
			summary: summary.slice(0, 400),
			author,
			published_at: publishedMs,
			tags: [],
		});
		if (items.length >= limit) break;
	}
	return items;
}

export async function fetchGitHubTrending(limit: number, since: Date): Promise<RadarItem[]> {
	const dateStr = since.toISOString().split("T")[0];
	const q = `topic:llm OR topic:ai-agent OR topic:llm-agent created:>${dateStr}`;
	const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${limit}`;
	const headers: HeadersInit = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
	const token = process.env.GITHUB_TOKEN;
	if (token) (headers as any).Authorization = `Bearer ${token}`;
	const resp = await fetchWithRetry(url, { headers });
	if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
	const data = (await resp.json()) as { items: any[] };
	return data.items.slice(0, limit).map((r: any) => {
		const canon = canonicalize(r.html_url);
		return {
			id: makeId("github", canon),
			source: "github" as const,
			source_id: String(r.id),
			title: `${r.full_name}: ${r.description ?? ""}`.trim(),
			url: r.html_url,
			canonical_url: canon,
			summary: r.description ?? undefined,
			author: r.owner?.login,
			published_at: new Date(r.created_at).getTime(),
			metrics: { stars: r.stargazers_count, forks: r.forks_count },
			tags: r.topics ?? [],
		};
	});
}

export async function fetchHF(limit: number): Promise<RadarItem[]> {
	const half = Math.ceil(limit / 2);
	const [modelsResp, datasetsResp] = await Promise.all([
		fetchWithRetry(`https://huggingface.co/api/models?sort=trendingScore&limit=${half}&full=true`),
		fetchWithRetry(`https://huggingface.co/api/datasets?sort=trendingScore&limit=${half}&full=true`),
	]);
	const models = modelsResp.ok ? ((await modelsResp.json()) as any[]) : [];
	const datasets = datasetsResp.ok ? ((await datasetsResp.json()) as any[]) : [];
	const mapItem = (r: any, type: "model" | "dataset"): RadarItem => {
		const baseUrl =
			type === "model"
				? `https://huggingface.co/${r.id ?? r.modelId}`
				: `https://huggingface.co/datasets/${r.id}`;
		const canon = canonicalize(baseUrl);
		return {
			id: makeId("hf", canon),
			source: "hf",
			source_id: r.id ?? r.modelId,
			title: `[${type}] ${r.id ?? r.modelId}`,
			url: baseUrl,
			canonical_url: canon,
			summary: r.cardData?.description?.slice(0, 300) ?? undefined,
			author: r.author,
			published_at: r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
			metrics: { likes: r.likes ?? 0, downloads: r.downloads ?? 0 },
			tags: (r.tags ?? []).slice(0, 10),
		};
	};
	return [...models.map((r: any) => mapItem(r, "model")), ...datasets.map((r: any) => mapItem(r, "dataset"))];
}

const REDDIT_SUBS = ["LocalLLaMA", "MachineLearning", "singularity", "OpenAI"];

export async function fetchReddit(limit: number, since: Date): Promise<RadarItem[]> {
	const sinceMs = since.getTime();
	const items: RadarItem[] = [];
	for (const sub of REDDIT_SUBS) {
		if (items.length >= limit) break;
		try {
			const url = `https://www.reddit.com/r/${sub}/top.json?t=day&limit=50`;
			const resp = await fetchWithRetry(url, {
				headers: { "User-Agent": "radar-pi/0.1 (automated AI trends tracker)" },
			});
			if (!resp.ok) continue;
			const data = (await resp.json()) as { data: { children: any[] } };
			for (const child of data.data.children) {
				const p = child.data;
				if (p.created_utc * 1000 < sinceMs) continue;
				const rawUrl = p.url ?? `https://reddit.com${p.permalink}`;
				const canon = canonicalize(rawUrl);
				items.push({
					id: makeId("reddit", canon),
					source: "reddit",
					source_id: p.id,
					title: p.title,
					url: rawUrl,
					canonical_url: canon,
					summary: p.selftext?.slice(0, 300) ?? undefined,
					author: p.author,
					published_at: p.created_utc * 1000,
					metrics: { score: p.score, comments: p.num_comments },
					tags: [sub],
				});
			}
		} catch {
			// skip failed subreddit
		}
	}
	return items.slice(0, limit);
}

export async function fetchRSS(url: string, limit: number, since: Date): Promise<RadarItem[]> {
	const parser = new RssParser();
	const feed = await parser.parseURL(url);
	const sinceMs = since.getTime();
	return (feed.items ?? [])
		.filter((item) => (item.pubDate ? new Date(item.pubDate).getTime() >= sinceMs : false))
		.slice(0, limit)
		.map((item) => {
			const rawUrl = item.link ?? url;
			const canon = canonicalize(rawUrl);
			return {
				id: makeId("rss", canon),
				source: "rss" as const,
				source_id: item.guid ?? canon,
				title: item.title ?? "(no title)",
				url: rawUrl,
				canonical_url: canon,
				summary: item.contentSnippet?.slice(0, 300) ?? undefined,
				author: item.creator ?? undefined,
				published_at: item.pubDate ? new Date(item.pubDate).getTime() : Date.now(),
				metrics: {},
				tags: [],
			};
		});
}

export { sinceDefault };
