import { safeUrl, type Credit } from "./credit.ts";
import type { TrackInfo } from "./utils/Lyrics/providers/types.ts";

// Spicy Lyrics through its developer API, with your own secret key (config.json, or the
// SPICY_LYRICS_SECRET_KEY environment variable). The key is only ever sent to Spicy Lyrics'
// own API and is never printed or stored anywhere else. Personal use only: nothing is
// kept on disk, and the results are not shared or served to anyone.
const API = "https://api.spicylyrics.org";

export type SpicyAnswer = { lyrics: any; credit: Credit };

const PROVIDERS: Record<string, string> = { apple_music: "Apple Music", spotify: "Spotify" };

/** The credit the API's terms ask to be shown wherever its lyrics are. */
function creditFor(body: any): Credit {
  if (body?.source === "spicy_lyrics") {
    const person = (role: string, who: any) =>
      who?.username ? [{ role, name: String(who.username), url: safeUrl(who.url) }] : [];
    return {
      text: "Lyrics from Spicy Lyrics",
      people: [
        ...person("uploaded by", body.UploadAttribution?.Uploader),
        ...person("made by", body.UploadAttribution?.Maker),
      ],
    };
  }
  const provider = PROVIDERS[body?.source];
  return {
    text: provider ? `Lyrics from Spicy Lyrics (synced from ${provider})` : "Lyrics from Spicy Lyrics (source not identified)",
    people: [],
  };
}
/**
 * The song's Spotify ids as Spicy Lyrics itself finds them, by title, artist, album and length (its own search,
 * with your key), so Spotify does not have to be open or the song found on Spotify first. Only results it calls
 * "exact" count; the other tiers are other songs or other artists. The best match comes first, then the same
 * song on other releases. Throws on a rate limit or a refused key, and gives no ids on any other trouble.
 */
export async function findSpicyIds(track: TrackInfo, key: string): Promise<string[]> {
  const title = track.name.trim().slice(0, 200);
  if (!title) return [];
  const params = new URLSearchParams({ title, limit: "5" });
  const artist = (track.artists?.length ? track.artists : [track.artist]).filter(Boolean).join(", ").slice(0, 200);
  if (artist) params.set("artist", artist);
  if (track.album) params.set("album", track.album.slice(0, 200));
  // Its search takes seconds, not milliseconds.
  const seconds = track.durationMs / 1000;
  if (seconds > 0 && seconds <= 86400) params.set("duration", seconds.toFixed(3));

  let res: Response;
  try {
    res = await fetch(`${API}/v1/tracks/search?${params}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return [];
  }
  if (res.status === 429) {
    const wait = res.headers.get("Retry-After") ?? res.headers.get("RateLimit-Reset");
    throw new Error(`Rate limited by Spicy Lyrics${wait ? `; try again in ${wait}s` : ""}`);
  }
  if (res.status === 401) throw new Error("Spicy Lyrics did not accept the key");
  if (!res.ok) return [];

  const results: any[] = ((await res.json().catch(() => null)) as any)?.Body?.results ?? [];
  const ids: string[] = [];
  for (const result of results) {
    if (result?.tier !== "exact") continue;
    for (const id of [result.id, ...(Array.isArray(result.variants) ? result.variants.map((v: any) => v?.id) : [])]) {
      if (typeof id === "string" && /^[A-Za-z0-9]{22}$/.test(id) && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

export async function fetchFromSpicy(track: TrackInfo, key: string): Promise<SpicyAnswer | null> {
  if (!track.spotifyId) return null;

  const res = await fetch(`${API}/v1/lyrics/${encodeURIComponent(track.spotifyId)}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 404) return null;
  const envelope: any = await res.json().catch(() => null);

  if (!res.ok) {
    const message = envelope?.Body?.message ?? `HTTP ${res.status}`;
    if (res.status === 429) {
      const wait = res.headers.get("Retry-After") ?? res.headers.get("RateLimit-Reset");
      throw new Error(`Rate limited by Spicy Lyrics${wait ? `; try again in ${wait}s` : ""}`);
    }
    if (res.status === 401) throw new Error(`Spicy Lyrics did not accept the key (${message})`);
    throw new Error(`Spicy Lyrics: ${String(message).slice(0, 160)}`);
  }

  const body = envelope?.Body;
  if (!body?.Type) return null;
  return { lyrics: body, credit: creditFor(body) };
}
