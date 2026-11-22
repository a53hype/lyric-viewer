import { expect, test } from "bun:test";

const ID = "4cOdK2wGLETKBW3PvgPWqT";

const {
  clearCanvasLookupCacheForTests,
  findSpotifyCanvas,
  parseCanvasResponse,
} = await import("../src/canvas.ts");
const {
  parseAnonymousSpotifySearch,
  parseAnonymousSpotifySession,
} = await import("../src/spotify.ts");

test("Canvas service response accepts only the requested track's HTTPS MP4", () => {
  expect(parseCanvasResponse({
    data: {
      [ID]: {
        url: "https://video-fa.scdn.co/video/example.mp4",
        type: "VIDEO_LOOPING",
      },
    },
  }, ID)).toEqual({
    url: "https://video-fa.scdn.co/video/example.mp4",
    type: "VIDEO_LOOPING",
  });

  expect(parseCanvasResponse({ data: { [ID]: null } }, ID)).toBeNull();
  expect(parseCanvasResponse({
    data: { [ID]: { url: "https://images.example.com/canvas.jpg", type: "IMAGE" } },
  }, ID)).toBeNull();
  expect(parseCanvasResponse({
    data: { [ID]: { url: "http://video.example.com/canvas.mp4" } },
  }, ID)).toBeNull();
  expect(() => parseCanvasResponse({ data: {} }, ID)).toThrow("did not contain the requested track");
});

test("Canvas lookups coalesce concurrent calls and cache a found video", async () => {
  clearCanvasLookupCacheForTests();
  const realFetch = globalThis.fetch;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = () => resolve(); });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls++;
    expect(String(input)).toBe("https://regional.canvasstore.slnode.spicylyrics.org/provider/canvaslist/" + ID);
    await gate;
    return Response.json({
      data: { [ID]: { url: "https://video-fa.scdn.co/video/example.mp4", type: "VIDEO_LOOPING" } },
    });
  }) as typeof fetch;

  try {
    const first = findSpotifyCanvas(ID);
    const second = findSpotifyCanvas(ID);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a?.url).toBe("https://video-fa.scdn.co/video/example.mp4");
    expect(await findSpotifyCanvas(ID)).toEqual(a);
    expect(calls).toBe(1);
    expect(await findSpotifyCanvas("not-a-spotify-id")).toBeNull();
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
    clearCanvasLookupCacheForTests();
  }
});

test("anonymous Spotify embed session parser reads the short-lived Web Player token", () => {
  const session = {
    accessToken: "anonymous-web-player-token",
    accessTokenExpirationTimestampMs: 1_900_000_000_000,
  };
  const html = '<script id="__NEXT_DATA__" type="application/json">' +
    JSON.stringify({ props: { pageProps: { state: { settings: { session } } } } }) +
    "</script>";

  expect(parseAnonymousSpotifySession(html)).toEqual({
    accessToken: "anonymous-web-player-token",
    expiresAt: 1_900_000_000_000,
  });
  expect(parseAnonymousSpotifySession("<html></html>")).toBeNull();
});

test("anonymous Spotify search parser extracts catalogue track metadata", () => {
  expect(parseAnonymousSpotifySearch({
    data: {
      searchV2: {
        tracksV2: {
          items: [{
            item: {
              data: {
                id: ID,
                uri: "spotify:track:" + ID,
                name: "Never Gonna Give You Up",
                duration: { totalMilliseconds: 213573 },
                artists: { items: [{ profile: { name: "Rick Astley" } }] },
                albumOfTrack: {
                  name: "Whenever You Need Somebody",
                  coverArt: {
                    sources: [
                      { url: "https://i.scdn.co/image/small", width: 64 },
                      { url: "https://i.scdn.co/image/large", width: 640 },
                    ],
                  },
                },
              },
            },
          }],
        },
      },
    },
  })).toEqual([{
    id: ID,
    name: "Never Gonna Give You Up",
    artists: ["Rick Astley"],
    album: "Whenever You Need Somebody",
    durationMs: 213573,
    cover: "https://i.scdn.co/image/large",
  }]);

  expect(parseAnonymousSpotifySearch({ data: { searchV2: { tracksV2: { items: [] } } } })).toEqual([]);
});
