import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RadarItem } from "@radar/types";
import { Type } from "typebox";
import { getDb, markSeen, mute, query, remember, stats, unmute, velocity } from "./db.js";

export default function (pi: ExtensionAPI) {
  const db = getDb();

  pi.registerTool({
    name: "radar_remember",
    label: "Radar Remember",
    description: "Upsert items into radar DB, record metric snapshots, dedup by canonical_url",
    parameters: Type.Object({
      items: Type.Array(Type.Any(), { description: "Array of RadarItem objects to store" }),
    }),
    execute: async (_id, params) => {
      const result = remember(db, params.items as RadarItem[]);
      return {
        content: [{ type: "text", text: `Stored: ${result.inserted} inserted, ${result.updated} updated, ${result.deduped} deduped` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "radar_query",
    label: "Radar Query",
    description: "Query stored radar items with optional filters",
    parameters: Type.Object({
      since: Type.Optional(Type.String({ description: "ISO date string, e.g. '2025-01-01T00:00:00Z'" })),
      sources: Type.Optional(Type.Array(Type.String(), { description: "Filter by source: hn, arxiv, github, hf, reddit, rss" })),
      unseen: Type.Optional(Type.Boolean({ description: "Only return items not yet shown to user" })),
      limit: Type.Optional(Type.Number({ description: "Max items to return (default 50)" })),
      exclude_muted: Type.Optional(Type.Boolean({ description: "Exclude muted topics/domains/authors/sources" })),
    }),
    execute: async (_id, params) => {
      const items = query(db, {
        since: params.since,
        sources: params.sources,
        unseen: params.unseen ?? false,
        limit: params.limit ?? 50,
        exclude_muted: params.exclude_muted ?? false,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(items) }],
        details: { count: items.length, items },
      };
    },
  });

  pi.registerTool({
    name: "radar_velocity",
    label: "Radar Velocity",
    description: "Find items with fastest-rising metrics (needs ≥2 snapshots in window)",
    parameters: Type.Object({
      window_hours: Type.Optional(Type.Number({ description: "Look-back window in hours (default 24)" })),
    }),
    execute: async (_id, params) => {
      const results = velocity(db, params.window_hours ?? 24);
      return {
        content: [{ type: "text", text: JSON.stringify(results) }],
        details: { count: results.length, results },
      };
    },
  });

  pi.registerTool({
    name: "radar_mark_seen",
    label: "Radar Mark Seen",
    description: "Mark items as seen with a given action",
    parameters: Type.Object({
      item_ids: Type.Array(Type.String(), { description: "Array of item IDs to mark" }),
      action: Type.String({ description: "One of: shown, opened, tried, dismissed" }),
    }),
    execute: async (_id, params) => {
      markSeen(db, params.item_ids, params.action);
      return {
        content: [{ type: "text", text: `Marked ${params.item_ids.length} items as ${params.action}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "radar_mute",
    label: "Radar Mute",
    description: "Add a mute pattern",
    parameters: Type.Object({
      pattern: Type.String({ description: "e.g. 'medium.com', 'someperson', 'reddit', 'image generation'" }),
      kind: Type.String({ description: "One of: topic, domain, author, source" }),
      reason: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      mute(db, params.pattern, params.kind, params.reason);
      return {
        content: [{ type: "text", text: `Muted ${params.kind}:${params.pattern}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "radar_unmute",
    label: "Radar Unmute",
    description: "Remove a mute pattern",
    parameters: Type.Object({
      pattern: Type.String({ description: "Pattern to unmute" }),
    }),
    execute: async (_id, params) => {
      unmute(db, params.pattern);
      return {
        content: [{ type: "text", text: `Unmuted: ${params.pattern}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "radar_stats",
    label: "Radar Stats",
    description: "Get radar DB statistics",
    parameters: Type.Object({}),
    execute: async () => {
      const s = stats(db);
      const lines = [
        `DB: ${s.db_path}`,
        `Total items: ${s.total_items}`,
        `Seen: ${s.total_seen}`,
        `Mutes: ${s.total_mutes}`,
        `By source: ${JSON.stringify(s.counts_by_source)}`,
      ];
      if (s.oldest_item) lines.push(`Oldest: ${new Date(s.oldest_item).toISOString()}`);
      if (s.newest_item) lines.push(`Newest: ${new Date(s.newest_item).toISOString()}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: s,
      };
    },
  });
}
