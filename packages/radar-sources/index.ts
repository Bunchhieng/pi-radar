import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchArxiv, fetchGitHubTrending, fetchHF, fetchHN, fetchRSS, fetchReddit, safeFetch, sinceDefault } from "./fetchers.js";

const FetchParams = Type.Object({
	limit: Type.Optional(Type.Number({ description: "Max items (default 30)" })),
	since: Type.Optional(Type.String({ description: "ISO date string, default 24h ago" })),
	query: Type.Optional(Type.String({ description: "Search query override" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "radar_fetch_hn",
		label: "Radar Fetch HN",
		description: "Fetch AI/LLM stories from Hacker News via Algolia search API",
		parameters: FetchParams,
		execute: async (_id, params) => {
			const result = await safeFetch("hn", () =>
				fetchHN(params.limit ?? 30, sinceDefault(params.since), params.query ?? "AI OR LLM OR GPT OR agent"),
			);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "radar_fetch_arxiv",
		label: "Radar Fetch arXiv",
		description: "Fetch recent AI/ML papers from arXiv (cs.AI, cs.CL, cs.LG)",
		parameters: FetchParams,
		execute: async (_id, params) => {
			const result = await safeFetch("arxiv", () =>
				fetchArxiv(params.limit ?? 30, sinceDefault(params.since)),
			);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "radar_fetch_github_trending",
		label: "Radar Fetch GitHub Trending",
		description: "Fetch trending AI/LLM repos from GitHub (set GITHUB_TOKEN for higher rate limits)",
		parameters: FetchParams,
		execute: async (_id, params) => {
			const result = await safeFetch("github", () =>
				fetchGitHubTrending(params.limit ?? 30, sinceDefault(params.since)),
			);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "radar_fetch_hf",
		label: "Radar Fetch HuggingFace",
		description: "Fetch trending models and datasets from HuggingFace",
		parameters: FetchParams,
		execute: async (_id, params) => {
			const result = await safeFetch("hf", () => fetchHF(params.limit ?? 30));
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "radar_fetch_reddit",
		label: "Radar Fetch Reddit",
		description: "Fetch top AI posts from Reddit (LocalLLaMA, MachineLearning, singularity, OpenAI)",
		parameters: FetchParams,
		execute: async (_id, params) => {
			const result = await safeFetch("reddit", () =>
				fetchReddit(params.limit ?? 30, sinceDefault(params.since)),
			);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "radar_fetch_rss",
		label: "Radar Fetch RSS",
		description: "Fetch items from any RSS/Atom feed URL",
		parameters: Type.Object({
			url: Type.String({ description: "RSS/Atom feed URL" }),
			limit: Type.Optional(Type.Number()),
			since: Type.Optional(Type.String()),
		}),
		execute: async (_id, params) => {
			const result = await safeFetch("rss", () =>
				fetchRSS(params.url, params.limit ?? 30, sinceDefault(params.since)),
			);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
