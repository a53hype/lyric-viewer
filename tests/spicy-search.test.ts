import { expect, mock, test } from "bun:test";

// The TTML parser needs fast-xml-parser, which these tests do not use; stand in for it when it is not installed.
try {
  require.resolve("fast-xml-parser");
} catch {
  mock.module("../src/utils/Lyrics/ttml/parser.ts", () => ({ parseTTML: () => null }));
}
try {
  require.resolve("linkedom");
} catch {
  mock.module("linkedom", () => ({ DOMParser: class {} }));
}
process.env.SPICY_LYRICS_SECRET_KEY = "sl_sk_test";

const { findSpicyIds } = await import("../src/spicy.ts");
const { lookupOne } = await import("../src/lookup.ts");

const ID_A = "4cOdK2wGLETKBW3PvgPWqT";
const ID_B = "4PTG3Z6ehGkBFwjybzWkR8";
const ID_C = "1234567890123456789012";
const SEARCH = {
  Body: { results: [
    { id: ID_A, tier: "exact", variants: [{ id: ID_B }] },
    { id: ID_C, tier: "other_artist", variants: [] },
  ] },
};
const LYRICS = { Body: { Type: "Line", Content: [{ Type: "Vocal", Text: "Never gonna", StartTime: 1, EndTime: 2 }], source: "spicy_lyrics" } };
const TRACK = { name: "Never Gonna Give You Up", artist: "Rick Astley", artists: ["Rick Astley"], album: "Whenever You Need Somebody", durationMs: 213573 };

function fakeSpicy(handler: (url: URL) => Response) {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input?.url ?? input));
    calls.push(url.pathname + url.search);
    return handler(url);
  }) as any;
  return { calls, restore: () => (globalThis.fetch = real) };
}

test("the search is by title, artist, album and seconds, and only exact results count", async () => {
  const fake = fakeSpicy(() => Response.json(SEARCH));
  try {
    expect(await findSpicyIds(TRACK, "k")).toEqual([ID_A, ID_B]);
    const query = new URL("https://x" + fake.calls[0]).searchParams;
    expect(query.get("title")).toBe("Never Gonna Give You Up");
    expect(query.get("artist")).toBe("Rick Astley");
    expect(query.get("album")).toBe("Whenever You Need Somebody");
    expect(query.get("duration")).toBe("213.573");
  } finally {
    fake.restore();
  }
});

test("a rate limit is reported; other trouble just gives no ids", async () => {
  let fake = fakeSpicy(() => new Response("{}", { status: 429, headers: { "Retry-After": "7" } }));
  try {
    await expect(findSpicyIds(TRACK, "k")).rejects.toThrow("try again in 7s");
  } finally {
    fake.restore();
  }
  fake = fakeSpicy(() => new Response("{}", { status: 503 }));
  try {
    expect(await findSpicyIds(TRACK, "k")).toEqual([]);
  } finally {
    fake.restore();
  }
});

test("Spicy Lyrics is asked for a song that was not found on Spotify, using its own search", async () => {
  const fake = fakeSpicy((url) => (url.pathname === "/v1/tracks/search" ? Response.json(SEARCH) : Response.json(LYRICS)));
  try {
    const track = { ...TRACK };
    const out = await lookupOne("spicy", track);
    expect(out.state).toBe("found");
    expect(out.sync).toBe("line");
    expect(track.spotifyIds).toEqual([ID_A, ID_B]);
    expect(track.spotifyId).toBe(ID_A);
    expect(fake.calls[1]).toBe(`/v1/lyrics/${ID_A}`);
  } finally {
    fake.restore();
  }
});

test("the Spotify ids from a running Spotify are the fallback when the search finds nothing", async () => {
  const fake = fakeSpicy((url) =>
    url.pathname === "/v1/tracks/search" ? Response.json({ Body: { results: [] } }) : Response.json(LYRICS)
  );
  try {
    const out = await lookupOne("spicy", { ...TRACK, spotifyId: ID_B, spotifyIds: [ID_B] });
    expect(out.state).toBe("found");
    expect(fake.calls[1]).toBe(`/v1/lyrics/${ID_B}`);
  } finally {
    fake.restore();
  }
});

test("no match anywhere is 'none', not an error", async () => {
  const fake = fakeSpicy(() => Response.json({ Body: { results: [] } }));
  try {
    const out = await lookupOne("spicy", { ...TRACK });
    expect(out.state).toBe("none");
  } finally {
    fake.restore();
  }
});
