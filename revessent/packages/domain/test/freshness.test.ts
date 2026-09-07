import { describe, expect, it } from "vitest";
import { computeFreshness } from "../src/freshness";

describe("freshness", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");
  it("classifies sync recency", () => {
    expect(computeFreshness(null, now)).toBe("never");
    expect(computeFreshness(new Date(now - 5 * 60000).toISOString(), now)).toBe("fresh");
    expect(computeFreshness(new Date(now - 2 * 3600000).toISOString(), now)).toBe("aging");
    expect(computeFreshness(new Date(now - 30 * 3600000).toISOString(), now)).toBe("stale");
    expect(computeFreshness("garbage", now)).toBe("never");
  });
});
