import { describe, expect, it } from "vitest";
import { canonicalize, makeId } from "../utils.js";

describe("canonicalize", () => {
  it("removes utm params", () => {
    const url = "https://example.com/post?utm_source=hn&utm_medium=social";
    expect(canonicalize(url)).toBe("https://example.com/post");
  });

  it("removes trailing slash", () => {
    expect(canonicalize("https://example.com/path/")).toBe("https://example.com/path");
  });

  it("lowercases hostname", () => {
    expect(canonicalize("https://Example.COM/path")).toBe("https://example.com/path");
  });

  it("keeps root slash", () => {
    expect(canonicalize("https://example.com/")).toContain("example.com");
  });
});

describe("makeId", () => {
  it("returns 16-char hex string", () => {
    const id = makeId("hn", "https://example.com");
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    expect(makeId("hn", "https://x.com")).toBe(makeId("hn", "https://x.com"));
  });

  it("differs by source", () => {
    expect(makeId("hn", "https://x.com")).not.toBe(makeId("arxiv", "https://x.com"));
  });
});
