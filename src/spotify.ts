import type { TrackInfo } from "./utils/Lyrics/providers/types.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** The track id in a Spotify link ("open.spotify.com/track/<id>", with or without a locale or ?si=, or "spotify:track:<id>"). */
export function trackIdFrom(input: string): string | null {
  const text = input.trim();
  const uri = /^spotify:track:([A-Za-z0-9]{22})$/.exec(text);
  if (uri) return uri[1];
  const link = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?track\/([A-Za-z0-9]{22})/.exec(text);
  return link ? link[1] : null;
}

/**
 * The song's title, artists, length and cover, read from Spotify's public embed page for the
 * track (the same page behind a Spotify "embed" iframe). No login or token is involved.
 * Spotify does not put the album name in it, so that stays empty unless given.
 */
export async function readTrack(id: string, album = ""): Promise<TrackInfo> {
  const res = await fetch(`https://open.spotify.com/embed/track/${id}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Spotify answered ${res.status} for that link`);
  const html = await res.text();
  const raw = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!raw) throw new Error("Could not read the song from Spotify's page");

  const entity = JSON.parse(raw[1])?.props?.pageProps?.state?.data?.entity;
  if (!entity?.name) throw new Error("Spotify's page had no song in it");

  const artists: string[] = (entity.artists ?? []).map((a: any) => a?.name).filter(Boolean);
  const covers: { url: string; maxWidth?: number }[] = entity.visualIdentity?.image ?? entity.coverArt ?? [];
  const cover = [...covers].sort((a, b) => (b.maxWidth ?? 0) - (a.maxWidth ?? 0))[0]?.url;

  return {
    name: entity.name,
    artist: artists[0] ?? "",
    artists,
    album,
    spotifyId: id,
    coverUrl: cover,
    durationMs: Number(entity.duration) || 0,
  };
}


// ---- Spotify's anonymous web catalogue --------------------------------------------------------
// Spotify's public embed page carries a short-lived Web Player token. The mobile app uses the same
// token and persisted GraphQL query, which lets us search the public catalogue without Spotify
// Desktop, Spicetify, a developer app, or the user's account.
const ANONYMOUS_BOOTSTRAP_ID = "4uLU6hMCjMI75M1A2tKUQC";
const ANONYMOUS_BOOTSTRAP_URL = "https://open.spotify.com/embed/track/" + ANONYMOUS_BOOTSTRAP_ID;
const PATHFINDER_URL = "https://api-partner.spotify.com/pathfinder/v1/query";
const SEARCH_OPERATION = "searchDesktop";
const SEARCH_SHA256 = "eff59fa0a3d026b88b56fddbcf4bdfa16a186b8175a5c1a358c072e053c2e5b0";
const SEARCH_LIMIT = 20;
let anonymousSession: { accessToken: string; expiresAt: number } | null = null;

type AnonymousSpotifyTrack = {
  id: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  cover?: string;
};

/** Read the anonymous Web Player session from Spotify's public embed HTML. Exported for unit tests. */
export function parseAnonymousSpotifySession(html: string): { accessToken: string; expiresAt: number } | null {
  const match = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return null;
  try {
    const session = JSON.parse(match[1])?.props?.pageProps?.state?.settings?.session;
    const accessToken = session?.accessToken;
    const expiresAt = Number(session?.accessTokenExpirationTimestampMs);
    if (typeof accessToken !== "string" || !accessToken || !Number.isFinite(expiresAt) || expiresAt <= 0) return null;
    return { accessToken, expiresAt };
  } catch {
    return null;
  }
}

/** Parse the anonymous search response shape used by Spotify's current Web Player. Exported for unit tests. */
export function parseAnonymousSpotifySearch(body: unknown): AnonymousSpotifyTrack[] {
  if (!body || typeof body !== "object") return [];
  const root = body as any;
  if (Array.isArray(root.errors) && root.errors.some((error: any) => error?.message === "PersistedQueryNotFound")) return [];
  const entries: any[] = root?.data?.searchV2?.tracksV2?.items ?? [];
  return entries.flatMap((entry) => {
    const data = entry?.item?.data ?? entry?.item ?? entry;
    const uri = typeof data?.uri === "string" ? data.uri : "";
    const id = typeof data?.id === "string" ? data.id : uri.split(":").pop();
    const name = typeof data?.name === "string" ? data.name : "";
    const durationMs = Number(data?.duration?.totalMilliseconds);
    const artists = (data?.artists?.items ?? [])
      .map((artist: any) => artist?.profile?.name)
      .filter((artist: unknown): artist is string => typeof artist === "string" && !!artist.trim());
    const sources: any[] = data?.albumOfTrack?.coverArt?.sources ?? [];
    const cover = [...sources].sort((a, b) => Number(b?.width ?? 0) - Number(a?.width ?? 0))[0]?.url;
    if (!id || !/^[A-Za-z0-9]{22}$/.test(id) || !name || !Number.isFinite(durationMs) || artists.length === 0) return [];
    return [{
      id,
      name,
      artists,
      album: String(data?.albumOfTrack?.name ?? ""),
      durationMs,
      cover: typeof cover === "string" && cover.startsWith("https://") ? cover : undefined,
    }];
  });
}

async function anonymousSpotifyToken(): Promise<string | null> {
  if (anonymousSession && anonymousSession.expiresAt > Date.now() + 60_000) return anonymousSession.accessToken;
  try {
    const response = await fetch(ANONYMOUS_BOOTSTRAP_URL, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    anonymousSession = parseAnonymousSpotifySession(await response.text());
    return anonymousSession?.accessToken ?? null;
  } catch {
    return null;
  }
}

function anonymousSearchTerm(url: string): string {
  try {
    return (new URL(url).searchParams.get("q") ?? "")
      .replace(/\b(?:track|artist|album):/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
  } catch {
    return "";
  }
}

async function runAnonymousSpotifySearch(query: string, token: string): Promise<{ status: number; tracks: AnonymousSpotifyTrack[] } | null> {
  const variables = JSON.stringify({
    searchTerm: query,
    offset: 0,
    limit: SEARCH_LIMIT,
    numberOfTopResults: 5,
    includeAudiobooks: false,
    includePreReleases: true,
    includeAlbumPreReleases: false,
    includeAuthors: false,
    includeEpisodeContentRatingsV2: false,
  });
  const extensions = JSON.stringify({
    persistedQuery: { version: 1, sha256Hash: SEARCH_SHA256 },
  });
  const endpoint = new URL(PATHFINDER_URL);
  endpoint.searchParams.set("operationName", SEARCH_OPERATION);
  endpoint.searchParams.set("variables", variables);
  endpoint.searchParams.set("extensions", extensions);

  try {
    const response = await fetch(endpoint, {
      headers: {
        Authorization: "Bearer " + token,
        "app-platform": "WebPlayer",
        "User-Agent": UA,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 401) return { status: 401, tracks: [] };
    if (!response.ok) return null;
    return { status: response.status, tracks: parseAnonymousSpotifySearch(await response.json()) };
  } catch {
    return null;
  }
}

/**
 * Search Spotify's public catalogue without a Spotify Desktop session or developer credentials.
 * Returns the Web API-shaped subset already consumed by resolve.ts; null means this fallback
 * could not be used (Spotify may rotate this undocumented Web Player contract).
 */
export async function spotifyAnonymousSearch(url: string): Promise<any | null> {
  const query = anonymousSearchTerm(url);
  if (!query) return null;

  let token = await anonymousSpotifyToken();
  if (!token) return null;
  let result = await runAnonymousSpotifySearch(query, token);
  if (!result) return null;
  if (result.status === 401) {
    anonymousSession = null;
    token = await anonymousSpotifyToken();
    if (!token) return null;
    result = await runAnonymousSpotifySearch(query, token);
  }
  if (!result || result.status === 401) return null;

  return {
    tracks: {
      items: result.tracks.map((track) => ({
        id: track.id,
        name: track.name,
        artists: track.artists.map((name) => ({ name })),
        album: { name: track.album, images: track.cover ? [{ url: track.cover }] : [] },
        duration_ms: track.durationMs,
      })),
    },
  };
}
