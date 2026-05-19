import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RadarItem } from "@radar/types";
import { createDb, markSeen, mute, query, remember, unmute } from "../db.js";
import type Database from "better-sqlite3";

function makeItem(overrides: Partial<RadarItem> = {}): RadarItem {
  return {
    id: "abc123",
    source: "hn",
    source_id: "12345",
    title: "Test Item",
    url: "https://example.com/test",
    canonical_url: "https://example.com/test",
    published_at: Date.now() - 3600_000,
    metrics: { points: 100, comments: 10 },
    ...overrides,
  };
}

describe("radar-memory db", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("inserts a new item", () => {
    const item = makeItem();
    const result = remember(db, [item]);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.deduped).toBe(0);

    const rows = query(db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Test Item");
  });

  it("deduplicates by canonical_url within a batch", () => {
    const canonUrl = "https://example.com/dedup-test";
    const item1 = makeItem({ id: "id001", source: "hn", canonical_url: canonUrl, url: canonUrl });
    const item2 = makeItem({ id: "id002", source: "reddit", canonical_url: canonUrl, url: canonUrl });

    const result = remember(db, [item1, item2]);
    expect(result.inserted).toBe(1);
    expect(result.deduped).toBe(1);

    const rows = query(db, { limit: 10 });
    expect(rows).toHaveLength(1);
  });

  it("merges extra_sources when same canonical arrives again", () => {
    const canonUrl = "https://example.com/merge-test";
    const item1 = makeItem({ id: "id001", source: "hn", canonical_url: canonUrl, url: canonUrl });
    remember(db, [item1]);

    const item2 = makeItem({ id: "id002", source: "reddit", canonical_url: canonUrl, url: canonUrl });
    const result = remember(db, [item2]);
    expect(result.updated).toBe(1);
    expect(result.inserted).toBe(0);
  });

  it("records metric snapshots", () => {
    const item = makeItem({ metrics: { points: 50 } });
    remember(db, [item]);

    const item2 = makeItem({ metrics: { points: 150 } });
    remember(db, [item2]);

    const rows = query(db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].metrics?.points).toBe(150);
  });

  it("marks items as seen and filters with unseen", () => {
    const item = makeItem({ published_at: Date.now() - 1000 });
    remember(db, [item]);

    let unseen = query(db, { unseen: true, limit: 10 });
    expect(unseen).toHaveLength(1);

    markSeen(db, [item.id], "shown");

    unseen = query(db, { unseen: true, limit: 10 });
    expect(unseen).toHaveLength(0);
  });

  it("mutes and unmutes a pattern", () => {
    mute(db, "medium.com", "domain", "too much fluff");

    const item = makeItem({
      canonical_url: "https://medium.com/some-article",
      url: "https://medium.com/some-article",
      published_at: Date.now() - 1000,
    });
    remember(db, [item]);

    const muted = query(db, { exclude_muted: true, limit: 10 });
    expect(muted).toHaveLength(0);

    unmute(db, "medium.com");
    const after = query(db, { exclude_muted: true, limit: 10 });
    expect(after).toHaveLength(1);
  });

  it("filters by source", () => {
    remember(db, [
      makeItem({ id: "h1", source: "hn", canonical_url: "https://a.com", url: "https://a.com" }),
      makeItem({ id: "r1", source: "reddit", canonical_url: "https://b.com", url: "https://b.com" }),
    ]);

    const hnOnly = query(db, { sources: ["hn"], limit: 10 });
    expect(hnOnly).toHaveLength(1);
    expect(hnOnly[0].source).toBe("hn");
  });
});
