import { describe, expect, it } from "vitest";
import { fixtureContext, jsonResponse } from "../__fixtures__/context";
import { decodeHNText, handleHackerNews } from "./hackernews";
import { handleReddit } from "./reddit";
import { getSiteParam, handleStackOverflow } from "./stackoverflow";

describe("getSiteParam", () => {
  it("maps standalone and subdomain sites", () => {
    expect(getSiteParam("stackoverflow.com")).toBe("stackoverflow");
    expect(getSiteParam("www.stackoverflow.com")).toBe("stackoverflow");
    expect(getSiteParam("unix.stackexchange.com")).toBe("unix");
    expect(getSiteParam("example.com")).toBeNull();
  });
});

describe("handleStackOverflow", () => {
  it("renders a question and its answers", async () => {
    const ctx = fixtureContext((url) => {
      if (url.includes("/questions/12345?")) {
        return jsonResponse({
          items: [
            {
              title: "How do I widget?",
              body: "<p>Question body</p>",
              score: 5,
              owner: { display_name: "asker" },
              creation_date: 1_700_000_000,
              tags: ["javascript"],
              answer_count: 1,
              is_answered: true,
            },
          ],
        });
      }
      if (url.includes("/questions/12345/answers")) {
        return jsonResponse({
          items: [
            {
              body: "<p>Answer body</p>",
              score: 3,
              is_accepted: true,
              owner: { display_name: "answerer" },
            },
          ],
        });
      }
      return undefined;
    });
    const result = await handleStackOverflow("https://stackoverflow.com/questions/12345/how", ctx);
    expect(result?.method).toBe("stackexchange");
    expect(result?.content).toContain("How do I widget?");
    expect(result?.content).toContain("## Answers");
    expect(result?.content).toContain("(Accepted)");
  });
});

describe("handleReddit", () => {
  it("renders a post with top comments", async () => {
    const ctx = fixtureContext((url) => {
      if (url.endsWith(".json")) {
        return jsonResponse([
          {
            data: {
              children: [
                {
                  data: {
                    title: "A post",
                    selftext: "Body text",
                    author: "alice",
                    score: 10,
                    num_comments: 1,
                    created_utc: 1_700_000_000,
                    subreddit: "test",
                    url: "https://reddit.com/r/test",
                    is_self: true,
                  },
                },
              ],
            },
          },
          {
            data: {
              children: [{ kind: "t1", data: { body: "A comment", author: "bob", score: 2 } }],
            },
          },
        ]);
      }
      return undefined;
    });
    const result = await handleReddit("https://www.reddit.com/r/test/comments/1/a_post/", ctx);
    expect(result?.method).toBe("reddit");
    expect(result?.content).toContain("# A post");
    expect(result?.content).toContain("## Top Comments");
    expect(result?.content).toContain("A comment");
  });
});

describe("decodeHNText", () => {
  it("converts HN markup to text", () => {
    expect(decodeHNText("<p>Hello <i>world</i></p><pre><code>1 + 1</code></pre>")).toBe(
      "Hello *world*\n```\n1 + 1\n```",
    );
  });
});

describe("handleHackerNews", () => {
  it("renders a story with comments", async () => {
    const ctx = fixtureContext((url) => {
      if (url.endsWith("/item/1.json")) {
        return jsonResponse({
          id: 1,
          title: "Story",
          by: "alice",
          score: 5,
          time: 1_700_000_000,
          kids: [2],
        });
      }
      if (url.endsWith("/item/2.json")) {
        return jsonResponse({ id: 2, by: "bob", text: "<p>A reply</p>", kids: [] });
      }
      return undefined;
    });
    const result = await handleHackerNews("https://news.ycombinator.com/item?id=1", ctx);
    expect(result?.method).toBe("hackernews");
    expect(result?.content).toContain("# Story");
    expect(result?.content).toContain("## Comments");
    expect(result?.content).toContain("A reply");
  });

  it("renders a listing", async () => {
    const ctx = fixtureContext((url) => {
      if (url.endsWith("/topstories.json")) return jsonResponse([1]);
      if (url.endsWith("/item/1.json")) {
        return jsonResponse({
          id: 1,
          title: "Top story",
          by: "alice",
          score: 9,
          time: 1_700_000_000,
        });
      }
      return undefined;
    });
    const result = await handleHackerNews("https://news.ycombinator.com/", ctx);
    expect(result?.method).toBe("hackernews");
    expect(result?.content).toContain("# Hacker News - Top Stories");
    expect(result?.content).toContain("Top story");
  });
});
