import { describe, expect, it } from "vitest";
import { specialHandlers } from "./index";

describe("specialHandlers", () => {
  it("registers every scraper in priority order", () => {
    expect(specialHandlers).toHaveLength(15);
    expect(specialHandlers.every((handler) => typeof handler === "function")).toBe(true);
  });
});
