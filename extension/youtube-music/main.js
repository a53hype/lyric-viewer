// Runs inside the YouTube Music page (it needs the page's own player objects, which an extension's isolated scripts cannot see).
// It reads the player bar's state and does the four fixed actions the viewer can ask for; nothing else is ever run.
(() => {
  const SOURCE = "lyric-viewer-ytm";
  const player = () => document.getElementById("movie_player");
  const bar = () => document.querySelector("ytmusic-player-bar");

  // YouTube's audio formats by their itag (the table youtube-dl keeps, plus the newer Opus ones). Rates are nominal; YouTube does not
  // publish the exact ones. A format that is not listed still shows its codec, so the line is never blank for a known codec.
  const FORMATS = {
    139: "AAC 48 kbps", 140: "AAC 128 kbps", 141: "AAC 256 kbps", 256: "AAC surround", 258: "AAC surround",
    171: "Vorbis 128 kbps", 172: "Vorbis 256 kbps",
    249: "Opus 50 kbps", 250: "Opus 70 kbps", 251: "Opus 160 kbps", 600: "Opus 35 kbps", 774: "Opus 256 kbps",
    599: "HE-AAC 30 kbps", 325: "DTS Express", 328: "Dolby Digital Plus",
  };
  const CODECS = { opus: "Opus", vorbis: "Vorbis", mp4a: "AAC", "ec-3": "Dolby Digital Plus", "ac-3": "Dolby Digital", dtse: "DTS Express" };
  function quality() {
    let tier = "";
    try {
      const text = JSON.stringify(player()?.getStatsForNerds?.() ?? {});
      const m = /(opus|vorbis|mp4a[\w.]*|ec-3|ac-3|dtse)\s*\((\d+)\)/i.exec(text);
      if (m) {
        const codec = CODECS[m[1].toLowerCase().slice(0, 4) === "mp4a" ? "mp4a" : m[1].toLowerCase()];
        tier = FORMATS[m[2]] ?? (codec ? `${codec} (format ${m[2]})` : "");
      }
    } catch {}
    // What the audio data itself shows (sample rate and the bitrate actually received), from quality-probe.js.
    const seen = window.__lvQuality?.();
    if (!tier && !seen) return "";
    if (!seen) return `YouTube Music · ${tier}`;
    if (!tier) return `YouTube Music · ${seen.text}`;
    const khz = seen.rate ? ` · ${+(seen.rate / 1000).toFixed(1)} kHz` : "";
    const measured = seen.kbps ? ` · ~${seen.kbps.toLocaleString("en-US")} kbps received` : "";
    return `YouTube Music · ${tier}${khz}${measured}`;
  }

  function read() {
    const meta = navigator.mediaSession?.metadata;
    if (!meta?.title) return null;
    const b = bar();
    let repeat = "NONE";
    try {
      repeat = b?.getState?.().queue?.repeatMode ?? "NONE";
    } catch {}
    let volume = 100;
    try {
      volume = Number(player()?.getVolume?.());
    } catch {}
    return {
      site: "ytm",
      title: String(meta.title),
      like: document.querySelector("#like-button-renderer")?.getAttribute("like-status") === "LIKE",
      shuffle: !!b?.hasAttribute("shuffle-on"),
      repeat,
      volume: Number.isFinite(volume) ? volume : 100,
      quality: quality(),
    };
  }

  const ACTIONS = {
    heart() {
      const el = document.querySelector("#like-button-renderer");
      el?.updateLikeStatus?.(el.getAttribute("like-status") === "LIKE" ? "INDIFFERENT" : "LIKE");
    },
    shuffle() {
      bar()?.queue?.shuffle?.();
    },
    repeat() {
      bar()?.onRepeatButtonClick?.();
    },
    volume(arg) {
      const v = Math.round(Math.min(1, Math.max(0, Number(arg) || 0)) * 100);
      const b = bar();
      if (b?.updateVolume) b.updateVolume(v);
      else player()?.setVolume?.(v);
    },
  };

  setInterval(() => {
    const state = read();
    if (state) window.postMessage({ source: SOURCE, type: "state", state }, location.origin);
  }, 750);

  window.addEventListener("message", (event) => {
    const d = event.data;
    if (event.source !== window || d?.source !== SOURCE || d.type !== "cmd") return;
    if (Object.prototype.hasOwnProperty.call(ACTIONS, d.action)) ACTIONS[d.action](d.arg);
  });
})();
