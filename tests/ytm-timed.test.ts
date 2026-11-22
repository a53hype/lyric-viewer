import { expect, test } from "bun:test";

const worker = (await import("../src/worker/worker.js")).default as any;
const { timedToLine } = await import("../src/utils/Lyrics/providers/YouTubeMusic.ts");

const NEXT = {
  contents: { singleColumnMusicWatchNextResultsRenderer: { tabbedRenderer: { watchNextTabbedResultsRenderer: { tabs: [
    { tabRenderer: { title: "Up next" } },
    { tabRenderer: { title: "Lyrics", endpoint: { browseEndpoint: { browseId: "MPLYt_abc" } } } },
  ] } } } },
};
const TIMED = {
  contents: { elementRenderer: { newElement: { type: { componentType: { model: { timedLyricsModel: { lyricsData: {
    timedLyricsData: [
      { lyricLine: "Hello there", cueRange: { startTimeMilliseconds: "1000", endTimeMilliseconds: "3000" } },
      { lyricLine: "General Kenobi", cueRange: { startTimeMilliseconds: "3500", endTimeMilliseconds: "6000" } },
    ],
    sourceMessage: "Source: Musixmatch",
  } } } } } } } },
};
const PLAIN = {
  contents: { sectionListRenderer: { contents: [{ musicDescriptionShelfRenderer: {
    description: { runs: [{ text: "Hello there\nGeneral Kenobi" }] }, footer: { runs: [{ text: "Source: Musixmatch" }] },
  } }] } },
};

/** Fakes music.youtube.com: `android` is what the Android client's browse answers with. */
function fakeYoutube(android: () => Response) {
  const seen: { client: string; path: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input?.url ?? input);
    const body = JSON.parse(init.body);
    const client = body.context.client.clientName;
    seen.push({ client, path: new URL(url).pathname });
    if (url.includes("/next")) return Response.json(NEXT);
    return client === "ANDROID_MUSIC" ? android() : Response.json(PLAIN);
  }) as any;
  return { seen, restore: () => (globalThis.fetch = real) };
}

const ask = async () => (await worker.fetch(new Request("https://worker.local/ytm/lyrics?videoId=abcdefghijk"))).json();

test("timed lines come back when the Android client gets them", async () => {
  const fake = fakeYoutube(() => Response.json(TIMED));
  try {
    const out = await ask();
    expect(out.lines).toEqual([
      { startMs: 1000, endMs: 3000, text: "Hello there" },
      { startMs: 3500, endMs: 6000, text: "General Kenobi" },
    ]);
    expect(out.text).toBe("Hello there\nGeneral Kenobi");
    expect(out.source).toBe("Musixmatch");
    expect(fake.seen.map((s) => `${s.client} ${s.path.split("/").pop()}`)).toEqual(["WEB_REMIX next", "ANDROID_MUSIC browse"]);
  } finally {
    fake.restore();
  }
});

test("plain lyrics are still used when the Android answer fails or has no timing", async () => {
  for (const android of [() => new Response("no", { status: 403 }), () => Response.json({ contents: {} })]) {
    const fake = fakeYoutube(android);
    try {
      const out = await ask();
      expect(out.lines).toBeUndefined();
      expect(out.text).toBe("Hello there\nGeneral Kenobi");
      expect(out.source).toBe("Musixmatch");
    } finally {
      fake.restore();
    }
  }
});

test("timed lines out of order are not trusted", async () => {
  const bad = structuredClone(TIMED);
  const cues = (bad as any).contents.elementRenderer.newElement.type.componentType.model.timedLyricsModel.lyricsData.timedLyricsData;
  cues.reverse();
  const fake = fakeYoutube(() => Response.json(bad));
  try {
    expect((await ask()).lines).toBeUndefined();
  } finally {
    fake.restore();
  }
});

test("the provider turns timed lines into line-synced lyrics", () => {
  const line = timedToLine(
    [{ startMs: 1000, endMs: 3000, text: "Hello there" }, { startMs: 3500, endMs: 6000, text: "General Kenobi" }],
    10000
  );
  expect(line.Type).toBe("Line");
  expect(line.Content.map((c: any) => [c.Text, c.StartTime, c.EndTime])).toEqual([
    ["Hello there", 1, 3.5],
    ["General Kenobi", 3.5, 10],
  ]);
  expect(timedToLine(undefined, 1000)).toBeNull();
  expect(timedToLine([], 1000)).toBeNull();
});
