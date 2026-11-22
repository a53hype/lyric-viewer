/**
 * Looks up Spotify Canvas videos using the public Canvas service used by Spicy Lyrics Mobile.
 *
 * This is deliberately independent of Spotify's desktop process, Chromium debugger port and login
 * session. The caller only needs a Spotify track ID. The service returns an MP4 URL or an explicit
 * null result when the track has no video Canvas.
 *
 * Canvas is decorative: failures are best-effort and the caller keeps the normal cover background.
 */
export type SpotifyCanvasMedia = {
  url: string;
  type: string;
};

type MemoEntry = {
  value: SpotifyCanvasMedia | null;
  at: number;
};

const BASE_URL = "https://regional.canvasstore.slnode.spicylyrics.org";
const FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 1500;
const FAILURE_PAUSE_MS = 60 * 1000;
const MAX_FAILURE_PAUSE_MS = 30 * 60 * 1000;
const MAX_MEMO_ENTRIES = 500;

const memo = new Map<string, MemoEntry>();
const inFlight = new Map<string, Promise<SpotifyCanvasMedia | null>>();
let failedAt = 0;
let failurePauseMs = 0;

const isTrackId = (id: string) => /^[A-Za-z0-9]{22}$/.test(id);

function isVideoUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname.toLowerCase().endsWith(".mp4");
  } catch {
    return false;
  }
}

/**
 * Parse the service response documented by Spicy Lyrics Mobile:
 * { data: { "<spotifyTrackId>": { url, type } } } or { data: { "<id>": null } }.
 *
 * A missing data object/key or an error entry is an invalid response, not a cacheable miss.
 * Image Canvas entries are treated as misses because the existing cover stage already shows art.
 */
export function parseCanvasResponse(payload: unknown, trackId: string): SpotifyCanvasMedia | null {
  if (!payload || typeof payload !== "object") throw new Error("Canvas service returned an invalid response");
  const data = (payload as any).data;
  if (!data || typeof data !== "object" || !Object.prototype.hasOwnProperty.call(data, trackId)) {
    throw new Error("Canvas service response did not contain the requested track");
  }

  const entry = data[trackId];
  if (entry === null) return null;
  if (!entry || typeof entry !== "object") throw new Error("Canvas service returned an unreadable track entry");
  if (entry.error) throw new Error("Canvas service could not resolve this track");

  // Some tracks have an image Canvas rather than a video. The normal cover is the correct fallback.
  if (!isVideoUrl(entry.url)) return null;
  return {
    url: new URL(entry.url).href,
    type: typeof entry.type === "string" && entry.type.trim() ? entry.type : "VIDEO_LOOPING",
  };
}

class RetryLater extends Error {
  constructor(readonly afterMs: number) {
    super("Canvas service requested a retry delay");
  }
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function lookupOnce(trackId: string): Promise<SpotifyCanvasMedia | null> {
  const response = await fetch(BASE_URL + "/provider/canvaslist/" + trackId, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  // The service uses HTTP 400 for an ID it will never resolve.
  if (response.status === 400) return null;

  if (!response.ok) {
    const wait = retryAfterMs(response.headers.get("Retry-After"));
    if (wait !== null && wait > 0) throw new RetryLater(wait);
    throw new Error("Canvas service returned HTTP " + response.status);
  }

  return parseCanvasResponse(await response.json(), trackId);
}

async function askTwice(trackId: string): Promise<SpotifyCanvasMedia | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await lookupOnce(trackId);
    } catch (error) {
      if (error instanceof RetryLater || attempt === 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  return null;
}

function remember(trackId: string, value: SpotifyCanvasMedia | null): void {
  memo.set(trackId, { value, at: Date.now() });
  while (memo.size > MAX_MEMO_ENTRIES) memo.delete(memo.keys().next().value as string);
}

/**
 * Return the Canvas MP4 for a Spotify track ID, or null for no video / a best-effort lookup failure.
 * Exact no-Canvas results are cached for one day; found videos are cached for seven days.
 * Concurrent requests for the same ID share one lookup, and failures trigger exponential backoff.
 */
export async function findSpotifyCanvas(trackId: string): Promise<SpotifyCanvasMedia | null> {
  if (!isTrackId(trackId)) return null;

  const known = memo.get(trackId);
  if (known) {
    const ttl = known.value ? FOUND_TTL_MS : MISS_TTL_MS;
    if (Date.now() - known.at < ttl) return known.value;
    memo.delete(trackId);
  }

  const pending = inFlight.get(trackId);
  if (pending) return pending;
  if (Date.now() - failedAt < failurePauseMs) return null;

  const request = (async () => {
    try {
      const answer = await askTwice(trackId);
      remember(trackId, answer);
      failedAt = 0;
      failurePauseMs = 0;
      return answer;
    } catch (error) {
      const nextPause = failurePauseMs ? failurePauseMs * 2 : FAILURE_PAUSE_MS;
      failurePauseMs = Math.min(MAX_FAILURE_PAUSE_MS, Math.max(FAILURE_PAUSE_MS, nextPause));
      if (error instanceof RetryLater) failurePauseMs = Math.max(failurePauseMs, Math.min(MAX_FAILURE_PAUSE_MS, error.afterMs));
      failedAt = Date.now();
      return null;
    } finally {
      inFlight.delete(trackId);
    }
  })();

  inFlight.set(trackId, request);
  return request;
}

/** Clears in-memory state for deterministic unit tests. Not used by the application. */
export function clearCanvasLookupCacheForTests(): void {
  memo.clear();
  inFlight.clear();
  failedAt = 0;
  failurePauseMs = 0;
}
