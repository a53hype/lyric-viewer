// The player bar of YouTube Music or Amazon Music in a browser (like, shuffle, repeat, volume, audio quality), as the viewer's browser extensions report it.
// The extension posts the page's state about once a second and is handed back any commands waiting for it, so nothing here
// reaches into the browser: no debugging port is needed.

export type YtmState = { /** Which extension sent it: YouTube Music or Amazon Music. */ site: "ytm" | "amazon"; title: string; heart: boolean; shuffle: boolean; /** 0 off, 1 all, 2 one. */ repeat: number; /** 0 to 1. */ volume: number; quality?: string };

const FRESH_MS = 4000;
let latest: { state: YtmState; at: number } | null = null;
let queue: { action: string; arg: number }[] = [];

/** A state report from the extension, checked field by field; null if it is not one. */
export function parseYtmState(body: any): YtmState | null {
  if (!body || typeof body.title !== "string" || body.title.length === 0 || body.title.length > 300) return null;
  const repeat = body.repeat === "ALL" ? 1 : body.repeat === "ONE" ? 2 : 0;
  const volume = Number(body.volume);
  const quality = typeof body.quality === "string" && body.quality.length <= 140 && /^[\p{L}\p{N} .,()/+~·-]+$/u.test(body.quality) ? body.quality : undefined;
  return {
    site: body.site === "amazon" ? "amazon" : "ytm",
    title: body.title,
    heart: body.like === true,
    shuffle: body.shuffle === true,
    repeat,
    volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume / 100)) : 1,
    quality,
  };
}

export function acceptYtmState(body: unknown): YtmState | null {
  const state = parseYtmState(body);
  if (state) latest = { state, at: Date.now() };
  return state;
}

/** The last report, while it is recent enough to be what is playing now. */
export function ytmNow(now = Date.now()): YtmState | null {
  return latest && now - latest.at <= FRESH_MS ? latest.state : null;
}

/** Whether a report is for the song Windows says is playing (the titles are the same text). */
export function sameSong(state: YtmState, title: string | undefined): boolean {
  return !!title && state.title.trim().toLowerCase() === title.trim().toLowerCase();
}

const ACTIONS = new Set(["heart", "shuffle", "repeat", "volume"]);

export function queueYtm(action: string, arg = 0): boolean {
  if (!ACTIONS.has(action)) return false;
  queue = [...queue.filter((c) => c.action !== action), { action, arg: Number.isFinite(arg) ? arg : 0 }].slice(-8);
  return true;
}

/** Commands waiting for the page that is playing. A page of the other site (both extensions can be installed) is handed none. */
export function drainYtm(site: "ytm" | "amazon" = "ytm"): { action: string; arg: number }[] {
  if (latest && latest.state.site !== site) return [];
  const out = queue;
  queue = [];
  return out;
}
