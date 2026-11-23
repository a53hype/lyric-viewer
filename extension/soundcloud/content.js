// Runs on soundcloud.com. It reads the player bar at the bottom (like, shuffle, repeat, volume, audio quality) and presses those buttons
// when the viewer asks; nothing else is ever run. Buttons are found by SoundCloud's own class names first, then by their labels.
(() => {
  const SITE = "soundcloud";
  const bar = () => document.querySelector(".playControls");
  const media = () => document.querySelector("audio, video");
  const text = (el) => [el?.getAttribute("aria-label"), el?.getAttribute("title"), el?.textContent].filter((v) => typeof v === "string").join(" ").toLowerCase();
  const visible = (el) => !!el && el.getClientRects().length > 0;

  /** A control by SoundCloud's class, else by what a button in the player bar says about itself. */
  function control(classes, label) {
    const root = bar() ?? document;
    for (const c of classes) {
      const el = root.querySelector(c);
      if (el) return el.matches("button, [role=button]") ? el : el.querySelector("button, [role=button]") ?? el;
    }
    return [...root.querySelectorAll("button, [role=button]")].find((el) => visible(el) && label.test(text(el)) && !/dislike|unlike all/.test(text(el))) ?? null;
  }
  const likeBtn = () => control([".playbackSoundBadge__like"], /\b(like|liked|unlike)\b/);
  const shuffleBtn = () => control([".shuffleControl button", ".shuffleControl"], /shuffle/);
  const repeatBtn = () => control([".repeatControl button", ".repeatControl"], /repeat/);

  const has = (el, ...names) => !!el && [el, el.parentElement, el.closest?.(".shuffleControl, .repeatControl, .playbackSoundBadge__like")].some((n) => n && names.some((c) => n.classList?.contains(c)));
  const pressed = (el) => !!el && ["aria-pressed", "aria-checked"].some((a) => el.getAttribute(a) === "true");

  function readControls() {
    const like = likeBtn();
    const shuffle = shuffleBtn();
    const repeat = repeatBtn();
    const rep = repeat ? `${repeat.className} ${repeat.parentElement?.className ?? ""} ${repeat.closest?.(".repeatControl")?.className ?? ""}` : "";
    return {
      like: !!like && (has(like, "sc-button-selected", "sc-button-active") || pressed(like) || /\bunlike\b|\bliked\b/.test(text(like))),
      shuffle: !!shuffle && (has(shuffle, "m-shuffling") || pressed(shuffle)),
      repeat: !repeat ? "NONE" : /\bm-one\b/.test(rep) ? "ONE" : /\bm-all\b/.test(rep) ? "ALL" : "NONE",
    };
  }

  // The real format from the audio data (quality-probe.js, for streams the page plays through the browser's media pipeline) ...
  let probed = null;
  let pageVolume = null;
  window.addEventListener("message", (event) => {
    const d = event.data;
    if (event.source === window && d?.source === "lyric-viewer-quality" && d.type === "quality") {
      probed = d.quality;
      pageVolume = d.volume;
    }
  });
  // ... and, for streams it cannot see into, the format SoundCloud names in the stream's own address (for example ".128.mp3" or ".64.opus").
  const CODEC = { mp3: "MP3", opus: "Opus", aac: "AAC", m4a: "AAC", mp4: "AAC" };
  let hint = "";
  let hintAt = 0;
  const noteResource = (name) => {
    if (!/sndcdn\.com/.test(name)) return;
    const m = /[./_-](\d{2,3})\.(mp3|opus|aac|m4a)\b/i.exec(name) ?? /\b(aac|opus|mp3)_(\d{2,3})k\b/i.exec(name);
    if (!m) return;
    const [kbps, codec] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
    hint = `${CODEC[codec.toLowerCase()]} ${kbps} kbps`;
    hintAt = Date.now();
  };
  try {
    for (const e of performance.getEntriesByType("resource")) noteResource(e.name);
    new PerformanceObserver((list) => list.getEntries().forEach((e) => noteResource(e.name))).observe({ type: "resource", buffered: false });
  } catch {}

  function quality() {
    // Prefer what was measured. The address hint is only a fallback, and only for the song it was seen on.
    if (probed?.text) return `SoundCloud · ${probed.text}`;
    return hint ? `SoundCloud · ${hint}` : "";
  }

  let lastTitle = "";
  function read() {
    const title = navigator.mediaSession?.metadata?.title || document.querySelector(".playbackSoundBadge__titleLink")?.getAttribute("title");
    if (!title) return null;
    if (title !== lastTitle) {
      // A new song: a hint older than a few seconds belongs to the previous one (the page's first report keeps what it already saw).
      if (lastTitle && Date.now() - hintAt > 3000) hint = "";
      lastTitle = title;
    }
    const m = media();
    const c = readControls();
    return { site: SITE, title: String(title), like: c.like, shuffle: c.shuffle, repeat: c.repeat, volume: m ? Math.round((m.muted ? 0 : m.volume) * 100) : pageVolume != null ? Math.round(pageVolume * 100) : 100, quality: quality() };
  }

  const lastPress = {};
  const press = (name, el) => {
    // A command is one press: the same action twice inside 700 ms is a repeat of the same request.
    if (!el || Date.now() - (lastPress[name] ?? 0) < 700) return;
    lastPress[name] = Date.now();
    el.click();
  };
  const ACTIONS = {
    heart: () => press("heart", likeBtn()),
    shuffle: () => press("shuffle", shuffleBtn()),
    repeat: () => press("repeat", repeatBtn()),
    volume: (arg) => {
      const m = media();
      if (m) {
        m.muted = false;
        m.volume = Math.min(1, Math.max(0, Number(arg) || 0));
      } else window.postMessage({ source: "lyric-viewer-quality", type: "volume", value: Number(arg) || 0 }, location.origin);
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

  // For finding out what SoundCloud's page calls things: in this page's console (F12), run
  //   window.dispatchEvent(new Event('lyric-viewer-soundcloud-debug'))
  // and send the output.
  const line = (el) =>
    `${el.tagName.toLowerCase()} class=${String(el.className).slice(0, 80)} ` +
    ["aria-label", "aria-pressed", "aria-checked", "title"].filter((a) => el.hasAttribute(a)).map((a) => `${a}=${String(el.getAttribute(a)).slice(0, 40)}`).join(" ");
  const debug = () =>
    [
      `player bar (.playControls): ${!!bar()}   media element: ${!!media()}`,
      `read(): ${JSON.stringify(read())}`,
      `stream hint: ${hint || "none"}   probe: ${JSON.stringify(probed)}`,
      `like: ${likeBtn() ? line(likeBtn()) : "NOT FOUND"}`,
      `shuffle: ${shuffleBtn() ? line(shuffleBtn()) : "NOT FOUND"}`,
      `repeat: ${repeatBtn() ? line(repeatBtn()) : "NOT FOUND"}`,
      "--- buttons in the player bar:",
      ...[...(bar() ?? document).querySelectorAll("button, [role=button]")].filter(visible).slice(0, 25).map(line),
    ].join("\n");
  window.addEventListener("lyric-viewer-soundcloud-debug", () => console.log("Lyric Viewer SoundCloud debug:\n" + debug()));
  console.debug("Lyric Viewer: to see what the extension finds, run  window.dispatchEvent(new Event('lyric-viewer-soundcloud-debug'))");
})();
