// Runs on Amazon Music's web player. It reads the player bar (like, shuffle, repeat, volume, audio quality) and presses those buttons when
// the viewer asks; nothing else is ever run. Amazon's page is built from web components, so the buttons are found by their labels, not by fixed ids.
(() => {
  const SITE = "amazon";
  const SOURCE = "lyric-viewer-amazon";

  /** Every element matching `selector` under `root`, looking inside open shadow roots too. */
  function all(root, selector) {
    const found = [...root.querySelectorAll(selector)];
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) found.push(...all(el.shadowRoot, selector));
    return found;
  }
  // Only the player at the bottom of the window is used. Searching the whole page would find page buttons such as a playlist's "Shuffle play"
  // or the like button on every song row. Amazon's page has no element for the player bar, so it is the buttons docked at the bottom of the window.
  const bar = () => document.querySelector("#transport");
  const media = () => document.querySelector("video, audio");

  /** What a control says about itself, in one lowercase string. */
  const describe = (el) =>
    [el.getAttribute("icon-name"), el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("label"), el.getAttribute("data-testid"), el.id]
      .filter((v) => typeof v === "string")
      .join(" ")
      .toLowerCase();
  const on = (el) =>
    ["aria-pressed", "aria-checked", "aria-selected", "selected", "active", "checked"].some((a) => el.hasAttribute(a) && el.getAttribute(a) !== "false") || /\b(selected|active|enabled|is-on)\b/.test(String(el.className));

  const visible = (el) => el.getClientRects().length > 0;
  const BOTTOM_PX = 180;
  const docked = (el) => {
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.bottom <= window.innerHeight + 2 && r.top > window.innerHeight - BOTTOM_PX - 40;
  };
  const buttons = () => (bar() ? all(bar(), "music-button, button, [role=button]").filter(visible) : all(document, "music-button, button, [role=button]").filter(visible).filter(docked).filter((el) => !/TrackLike|PlaylistTrack|ListItem|Toolbar_/i.test(el.getAttribute("data-testid") || "")));
  const find = (pattern, not) => buttons().find((el) => pattern.test(describe(el)) && !(not && not.test(describe(el))));
  const SHUFFLE = /\bshuffle\b/;
  const REPEAT = /\b(repeat|loop)\b/;
  const LIKE = /\b(liked?|favou?rite|heart|love)\b/;
  const NOT_LIKE = /dislike|thumb-?down/;

  function readControls() {
    const shuffle = find(SHUFFLE);
    const repeat = find(REPEAT);
    const like = find(LIKE, NOT_LIKE);
    const repeatText = repeat ? describe(repeat) : "";
    return {
      like: !!like && (on(like) || /\bliked\b|unlike|remove|filled|-fill\b|favou?rited/.test(describe(like))),
      shuffle: !!shuffle && on(shuffle),
      repeat: !repeat ? "NONE" : /\b(one|1|track|song|single)\b/.test(repeatText) && (on(repeat) || /repeat-one|repeat_one/.test(repeatText)) ? "ONE" : on(repeat) ? "ALL" : "NONE",
    };
  }

  // Amazon's quality badges, best first. Only the player bar and the song that is playing are looked at, so another song's badge in a list does not count.
  const QUALITY = [
    [/dolby atmos|\batmos\b/i, "Dolby Atmos"],
    [/360 reality audio/i, "360 Reality Audio"],
    [/ultra hd/i, "Ultra HD"],
    [/\bhd\b/i, "HD"],
    [/\bsd\b/i, "SD"],
  ];
  // The real format from the audio data, sent by quality-probe.js running in the page.
  let probed = null;
  window.addEventListener("message", (event) => {
    const d = event.data;
    if (event.source === window && d?.source === "lyric-viewer-quality" && d.type === "quality") probed = d.quality;
  });

  function badge() {
    const scopes = [bar(), ...document.querySelectorAll("[class*=nowPlaying], [class*=currentlyPlaying], [class*=now-playing]")].filter(Boolean);
    const seen = new Set();
    for (const scope of scopes) {
      for (const el of all(scope, "*")) {
        for (const text of [el.getAttribute?.("aria-label"), el.getAttribute?.("title"), el.getAttribute?.("badge-text"), el.getAttribute?.("label"), el.children.length === 0 ? el.textContent : ""]) {
          const t = String(text ?? "").trim();
          if (t && t.length <= 40) seen.add(t);
        }
      }
    }
    const joined = [...seen].join(" | ");
    for (const [pattern, label] of QUALITY) if (pattern.test(joined)) return label;
    return "";
  }

  /** "Amazon Music · Ultra HD · FLAC 24-bit / 96 kHz · ~2,310 kbps": Amazon's label, then what the audio data shows. */
  let badgeAt = 0;
  let badgeText = "";
  function quality() {
    // The badge scan walks a lot of the page, so it is repeated every few seconds, not every report.
    if (Date.now() - badgeAt > 4000) {
      badgeText = badge();
      badgeAt = Date.now();
    }
    const label = badgeText;
    const real = probed?.text ?? "";
    return label || real ? ["Amazon Music", label, real].filter(Boolean).join(" · ") : "";
  }

  function read() {
    const item = bar()?.querySelector("music-horizontal-item");
    const title = navigator.mediaSession?.metadata?.title || item?.getAttribute("primary-text");
    if (!title) return null;
    const m = media();
    const c = readControls();
    return { site: SITE, title: String(title), like: c.like, shuffle: c.shuffle, repeat: c.repeat, volume: m ? Math.round((m.muted ? 0 : m.volume) * 100) : 100, quality: quality() };
  }

  const lastPress = {};
  const press = (name, el) => {
    // A command is one press. The same action twice inside 700 ms is a repeat of the same request, not a second press.
    if (!el || Date.now() - (lastPress[name] ?? 0) < 700) return;
    lastPress[name] = Date.now();
    el.click();
  };
  // Amazon's like, shuffle and repeat buttons are not used: they could not be read reliably, so no command is ever run on this page.
  const ACTIONS = {};

  setInterval(() => {
    const state = read();
    if (!state) return;
    try {
      chrome.runtime.sendMessage({ state }, (reply) => {
        void chrome.runtime.lastError;
        for (const cmd of reply?.cmds ?? []) if (Object.prototype.hasOwnProperty.call(ACTIONS, cmd.action)) ACTIONS[cmd.action](cmd.arg);
      });
    } catch {
      // The extension was reloaded: this page's copy of the script is orphaned until the tab is refreshed.
    }
  }, 750);

  // For finding out what Amazon's page calls things: in this page's console (F12), run
  //   window.dispatchEvent(new Event('lyric-viewer-amazon-debug'))
  // and send the output.
  const line = (el) => {
    const r = el.getBoundingClientRect();
    const attrs = ["data-testid", "aria-label", "aria-pressed", "aria-checked", "aria-selected", "selected", "title", "icon-name", "id"]
      .filter((a) => el.hasAttribute(a))
      .map((a) => `${a}=${String(el.getAttribute(a)).slice(0, 50)}`);
    return `${el.tagName.toLowerCase()} y=${Math.round(r.top)} x=${Math.round(r.left)} ${attrs.join(" ")}`;
  };
  // Printed as plain lines (not one big object) so the console does not cut it short.
  const debug = () =>
    [
      `playerBar(#transport): ${!!bar()}   window height: ${window.innerHeight}`,
      `mediaSession title: ${navigator.mediaSession?.metadata?.title ?? "none"}   media element: ${!!media()}`,
      `read(): ${JSON.stringify(read())}`,
      "--- buttons docked at the bottom of the window (what the extension uses):",
      ...buttons().map(line),
      "--- every button on screen that is not a song-row button:",
      ...all(document, "music-button, button, [role=button]")
        .filter((el) => visible(el) && el.getBoundingClientRect().bottom <= window.innerHeight + 2 && el.getBoundingClientRect().height > 0 && !/TrackLike|PlaylistTrack|ListItem/i.test(el.getAttribute("data-testid") || ""))
        .map(line),
    ].join("\n");
  window.addEventListener("lyric-viewer-amazon-debug", () => console.log("Lyric Viewer Amazon debug:\n" + debug()));
  console.debug("Lyric Viewer: to see what the extension finds, run  window.dispatchEvent(new Event('lyric-viewer-amazon-debug'))");
})();
