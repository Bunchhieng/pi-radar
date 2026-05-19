import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RadarItem } from "@radar/types";

const RADAR_DIR = join(homedir(), ".pi", "radar");
const DB_PATH = join(RADAR_DIR, "radar.db");

export function createDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
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
      tags TEXT,
      extra_sources TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS metrics_snapshots (
      item_id TEXT NOT NULL,
      taken_at INTEGER NOT NULL,
      metric TEXT NOT NULL,
      value INTEGER NOT NULL,
      PRIMARY KEY (item_id, taken_at, metric)
    );

    CREATE TABLE IF NOT EXISTS seen (
      item_id TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL,
      action TEXT
    );

    CREATE TABLE IF NOT EXISTS mutes (
      pattern TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_items_published ON items(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_items_canonical ON items(canonical_url);
    CREATE INDEX IF NOT EXISTS idx_metrics_item ON metrics_snapshots(item_id, taken_at DESC);
  `);
  return db;
}

export function getDb(): Database.Database {
  if (!existsSync(RADAR_DIR)) mkdirSync(RADAR_DIR, { recursive: true });
  return createDb(DB_PATH);
}

export function remember(
  db: Database.Database,
  rawItems: RadarItem[]
): { inserted: number; updated: number; deduped: number } {
  const now = Date.now();
  let inserted = 0;
  let updated = 0;
  let deduped = 0;

  // Deduplicate the incoming batch by canonical_url before touching the DB.
  // When multiple sources link the same URL, keep the first item and track
  // the extra source refs so they get written into extra_sources.
  const canonical = new Map<string, RadarItem>();
  const batchExtras = new Map<string, string[]>();
  for (const item of rawItems) {
    const key = item.canonical_url;
    if (canonical.has(key)) {
      const extras = batchExtras.get(key) ?? [];
      extras.push(`${item.source}:${item.source_id}`);
      batchExtras.set(key, extras);
      deduped++;
    } else {
      canonical.set(key, item);
    }
  }
  const items = Array.from(canonical.values());

  const insertItem = db.prepare(
    `INSERT OR IGNORE INTO items
       (id, source, source_id, title, url, canonical_url, summary, author,
        published_at, first_seen_at, raw_json, tags, extra_sources)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateMerge = db.prepare(
    `UPDATE items SET title = ?, summary = COALESCE(?, summary), extra_sources = ? WHERE id = ?`
  );
  const existsByCanonical = db.prepare<[string], { id: string; extra_sources: string }>(
    "SELECT id, extra_sources FROM items WHERE canonical_url = ?"
  );
  const insertMetric = db.prepare(
    "INSERT OR REPLACE INTO metrics_snapshots (item_id, taken_at, metric, value) VALUES (?, ?, ?, ?)"
  );

  const upsert = db.transaction((items: RadarItem[]) => {
    for (const item of items) {
      const existing = existsByCanonical.get(item.canonical_url);
      const extras = batchExtras.get(item.canonical_url) ?? [];

      if (existing) {
        let sources: string[] = [];
        try { sources = JSON.parse(existing.extra_sources ?? "[]"); } catch { sources = []; }
        for (const s of [`${item.source}:${item.source_id}`, ...extras]) {
          if (!sources.includes(s)) sources.push(s);
        }
        updateMerge.run(item.title, item.summary ?? null, JSON.stringify(sources), existing.id);
        recordMetrics(insertMetric, existing.id, now, item.metrics);
        updated++;
      } else {
        insertItem.run(
          item.id, item.source, item.source_id, item.title, item.url, item.canonical_url,
          item.summary ?? null, item.author ?? null, item.published_at, now,
          JSON.stringify(item), JSON.stringify(item.tags ?? []),
          JSON.stringify(extras)
        );
        recordMetrics(insertMetric, item.id, now, item.metrics);
        inserted++;
      }
    }
  });

  upsert(items);
  return { inserted, updated, deduped };
}

function recordMetrics(
  stmt: Database.Statement,
  itemId: string,
  takenAt: number,
  metrics?: RadarItem["metrics"]
) {
  if (!metrics) return;
  for (const [key, value] of Object.entries(metrics)) {
    if (value !== undefined && value !== null) {
      stmt.run(itemId, takenAt, key, value);
    }
  }
}

export interface QueryParams {
  since?: string;
  sources?: string[];
  unseen?: boolean;
  limit?: number;
  exclude_muted?: boolean;
}

export function query(db: Database.Database, params: QueryParams): RadarItem[] {
  const conditions: string[] = [];
  const args: (string | number)[] = [];

  if (params.since) {
    conditions.push("i.published_at >= ?");
    args.push(new Date(params.since).getTime());
  }
  if (params.sources?.length) {
    conditions.push(`i.source IN (${params.sources.map(() => "?").join(",")})`);
    args.push(...params.sources);
  }
  if (params.unseen) {
    conditions.push("i.id NOT IN (SELECT item_id FROM seen)");
  }
  if (params.exclude_muted) {
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM mutes m WHERE
        (m.kind = 'source' AND m.pattern = i.source) OR
        (m.kind = 'author' AND m.pattern = i.author) OR
        (m.kind = 'domain' AND i.canonical_url LIKE '%' || m.pattern || '%') OR
        (m.kind = 'topic' AND (LOWER(i.title) LIKE '%' || LOWER(m.pattern) || '%'
                            OR LOWER(i.summary) LIKE '%' || LOWER(m.pattern) || '%'))
    )`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  args.push(params.limit ?? 50);

  const rows = db
    .prepare<(string | number)[], Record<string, unknown>>(
      `SELECT i.*,
         (SELECT json_object(
           'points',    MAX(CASE WHEN metric='points'    THEN value END),
           'stars',     MAX(CASE WHEN metric='stars'     THEN value END),
           'forks',     MAX(CASE WHEN metric='forks'     THEN value END),
           'score',     MAX(CASE WHEN metric='score'     THEN value END),
           'comments',  MAX(CASE WHEN metric='comments'  THEN value END),
           'likes',     MAX(CASE WHEN metric='likes'     THEN value END),
           'downloads', MAX(CASE WHEN metric='downloads' THEN value END))
          FROM metrics_snapshots ms WHERE ms.item_id = i.id
         ) AS latest_metrics
       FROM items i ${where} ORDER BY i.published_at DESC LIMIT ?`
    )
    .all(...args);

  return rows.map(rowToItem);
}

function rowToItem(row: Record<string, unknown>): RadarItem {
  let metrics: RadarItem["metrics"] = undefined;
  if (row.latest_metrics) {
    try {
      const m = JSON.parse(row.latest_metrics as string) as Record<string, unknown>;
      const cleaned: RadarItem["metrics"] = {};
      for (const [k, v] of Object.entries(m)) {
        if (v !== null) (cleaned as Record<string, unknown>)[k] = v;
      }
      if (Object.keys(cleaned).length) metrics = cleaned;
    } catch { /* ignore malformed json_object result */ }
  }
  return {
    id: row.id as string,
    source: row.source as RadarItem["source"],
    source_id: (row.source_id as string) ?? "",
    title: row.title as string,
    url: row.url as string,
    canonical_url: row.canonical_url as string,
    summary: (row.summary as string | null) ?? undefined,
    author: (row.author as string | null) ?? undefined,
    published_at: row.published_at as number,
    metrics,
    tags: row.tags ? JSON.parse(row.tags as string) : undefined,
  };
}

export interface VelocityResult {
  item: RadarItem;
  max_delta_per_hour: number;
  deltas: Record<string, number>;
}

export function velocity(db: Database.Database, windowHours: number): VelocityResult[] {
  const since = Date.now() - windowHours * 3600 * 1000;
  const rows = db
    .prepare<[number], { item_id: string; metric: string; first_val: number; last_val: number; first_at: number; last_at: number; snapshots: number }>(
      `SELECT item_id, metric,
              MIN(value) as first_val, MAX(value) as last_val,
              MIN(taken_at) as first_at, MAX(taken_at) as last_at,
              COUNT(*) as snapshots
       FROM metrics_snapshots
       WHERE taken_at >= ?
       GROUP BY item_id, metric
       HAVING snapshots >= 2`
    )
    .all(since);

  const byItem = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const hours = Math.max((row.last_at - row.first_at) / 3_600_000, 0.001);
    const dph = (row.last_val - row.first_val) / hours;
    if (dph <= 0) continue;
    if (!byItem.has(row.item_id)) byItem.set(row.item_id, {});
    byItem.get(row.item_id)![row.metric] = dph;
  }

  const results: VelocityResult[] = [];
  for (const [itemId, deltas] of byItem) {
    const raw = db
      .prepare<[string], Record<string, unknown>>("SELECT * FROM items WHERE id = ?")
      .get(itemId);
    if (!raw) continue;
    results.push({
      item: rowToItem(raw),
      max_delta_per_hour: Math.max(...Object.values(deltas)),
      deltas,
    });
  }

  return results.sort((a, b) => b.max_delta_per_hour - a.max_delta_per_hour);
}

export function markSeen(db: Database.Database, itemIds: string[], action: string) {
  const now = Date.now();
  const stmt = db.prepare("INSERT OR REPLACE INTO seen (item_id, seen_at, action) VALUES (?, ?, ?)");
  db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(id, now, action);
  })(itemIds);
}

export function mute(db: Database.Database, pattern: string, kind: string, reason?: string) {
  db.prepare("INSERT OR REPLACE INTO mutes (pattern, kind, reason, created_at) VALUES (?, ?, ?, ?)")
    .run(pattern, kind, reason ?? null, Date.now());
}

export function unmute(db: Database.Database, pattern: string) {
  db.prepare("DELETE FROM mutes WHERE pattern = ?").run(pattern);
}

export interface DbStats {
  counts_by_source: Record<string, number>;
  oldest_item?: number;
  newest_item?: number;
  total_items: number;
  total_seen: number;
  total_mutes: number;
  db_path: string;
}

export function stats(db: Database.Database): DbStats {
  const sourceRows = db
    .prepare<[], { source: string; cnt: number }>("SELECT source, COUNT(*) as cnt FROM items GROUP BY source")
    .all();
  const counts_by_source: Record<string, number> = {};
  for (const r of sourceRows) counts_by_source[r.source] = r.cnt;

  const range = db
    .prepare<[], { oldest: number; newest: number }>(
      "SELECT MIN(published_at) as oldest, MAX(published_at) as newest FROM items"
    )
    .get();

  return {
    counts_by_source,
    oldest_item: range?.oldest,
    newest_item: range?.newest,
    total_items: db.prepare<[], { n: number }>("SELECT COUNT(*) as n FROM items").get()?.n ?? 0,
    total_seen:  db.prepare<[], { n: number }>("SELECT COUNT(*) as n FROM seen").get()?.n ?? 0,
    total_mutes: db.prepare<[], { n: number }>("SELECT COUNT(*) as n FROM mutes").get()?.n ?? 0,
    db_path: DB_PATH,
  };
}
