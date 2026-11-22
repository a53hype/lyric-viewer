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
  const bar = () => document.querySelector("#transport") ?? document.body;
  const media = () => document.querySelector("video, audio");

  /** What a control says about itself, in one lowercase string. */
  const describe = (el) =>
    [el.getAttribute("icon-name"), el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("label"), el.getAttribute("data-testid"), el.id, el.className]
      .filter((v) => typeof v === "string")
      .join(" ")
      .toLowerCase();
  const on = (el) =>
    ["aria-pressed", "aria-checked", "selected", "active", "checked"].some((a) => el.hasAttribute(a) && el.getAttribute(a) !== "false") || /\b(selected|active|enabled|is-on)\b/.test(String(el.className));

  const buttons = () => all(bar(), "music-button, button, [role=button]");
  const find = (pattern, not) => buttons().find((el) => pattern.test(describe(el)) && !(not && not.test(describe(el))));

  function readControls() {
    const shuffle = find(/shuffle/);
    const repeat = find(/repeat|loop/);
    const like = find(/\b(like|favou?rite|heart|love)\b/, /dislike|thumb-?down/);
    const repeatText = repeat ? describe(repeat) : "";
    return {
      like: !!like && (on(like) || /unlike|remove|filled|-fill\b|favou?rited/.test(describe(like))),
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
    const scopes = [bar(), ...document.querySelectorAll("[class*=nowPlaying], [class*=currentlyPlaying], [class*=now-playing]")];
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
  function quality() {
    const label = badge();
    const real = probed?.text ?? "";
    return label || real ? ["Amazon Music", label, real].filter(Boolean).join(" · ") : "";
  }

  function read() {
    const item = bar().querySelector("music-horizontal-item");
    const title = navigator.mediaSession?.metadata?.title || item?.getAttribute("primary-text");
    if (!title) return null;
    const m = media();
    const c = readControls();
    return { site: SITE, title: String(title), like: c.like, shuffle: c.shuffle, repeat: c.repeat, volume: m ? Math.round((m.muted ? 0 : m.volume) * 100) : 100, quality: quality() };
  }

  const ACTIONS = {
    heart: () => find(/\b(like|favou?rite|heart|love)\b/, /dislike|thumb-?down/)?.click(),
    shuffle: () => find(/shuffle/)?.click(),
    repeat: () => find(/repeat|loop/)?.click(),
    volume: (arg) => {
      const m = media();
      if (m) {
        m.muted = false;
        m.volume = Math.min(1, Math.max(0, Number(arg) || 0));
      }
    },
  };

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
  const debug = () => ({
    controls: buttons().map((el) => ({ tag: el.tagName.toLowerCase(), says: describe(el), pressed: el.getAttribute("aria-pressed"), selected: el.hasAttribute("selected"), class: String(el.className).slice(0, 60) })),
    read: read(),
    mediaElement: !!media(),
  });
  window.addEventListener("lyric-viewer-amazon-debug", () => console.log("Lyric Viewer Amazon debug:", JSON.stringify(debug(), null, 2)));
  console.debug("Lyric Viewer: to see what the extension finds, run  window.dispatchEvent(new Event('lyric-viewer-amazon-debug'))");
})();
