import { describe, expect, it } from "vitest";
import { compareExpectation } from "./wait";

describe("compareExpectation", () => {
  it("compares text and regular expressions", () => {
    expect(compareExpectation("Welcome home", "Welcome", "contains")).toBe(true);
    expect(compareExpectation("Welcome home", "welcome", "not_contains")).toBe(true);
    expect(compareExpectation("item-42", "^item-\\d+$", "matches")).toBe(true);
    expect(compareExpectation("item-42", "[", "matches")).toBe(false);
    expect(compareExpectation("a", "b", "not_equals")).toBe(true);
  });

  it("coerces boolean and numeric expectations to strings", () => {
    expect(compareExpectation("true", true, "equals")).toBe(true);
    expect(compareExpectation("false", false, "equals")).toBe(true);
    expect(compareExpectation("3", 3, "equals")).toBe(true);
  });

  it("compares numbers for range operators", () => {
    expect(compareExpectation("5", "3", "gt")).toBe(true);
    expect(compareExpectation("5", "5", "gte")).toBe(true);
    expect(compareExpectation("5", "6", "lt")).toBe(true);
    expect(compareExpectation("5", "5", "lte")).toBe(true);
    expect(compareExpectation("five", "5", "gt")).toBe(false);
  });
});
