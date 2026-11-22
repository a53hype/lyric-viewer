// Reads the audio format the page is really playing, from the audio data the player hands to the browser: the codec, and for MP4 audio
// the sample rate and bit depth written in its header, and the actual bitrate (bytes received per second of audio). Nothing is changed,
// copied or sent anywhere; it only counts bytes and reads the unencrypted header of the stream. It has to run before the page's own scripts.
(() => {
  if (window.__lvQuality || typeof MediaSource === "undefined") return;
  const SOURCE = "lyric-viewer-quality";
  const tracked = new Map(); // SourceBuffer -> { mime, info, win: [{bytes, sec}], last, pending, at }

  // ---- MP4 header reading ----------------------------------------------------------------------------------------------
  const tag = (u8, at) => String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]);
  function boxes(u8, start, end) {
    const out = [];
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      let head = 8;
      if (size === 1 && p + 16 <= end) {
        size = Number(dv.getBigUint64(p + 8));
        head = 16;
      } else if (size === 0) size = end - p;
      if (size < head || p + size > end) break;
      out.push({ type: tag(u8, p + 4), start: p + head, end: p + size });
      p += size;
    }
    return out;
  }
  const child = (u8, box, type, skip = 0) => boxes(u8, box.start + skip, box.end).find((b) => b.type === type);

  /** The AAC stream's own declared average bitrate, from its "esds" descriptors. */
  function esdsBitrate(u8, box) {
    let p = box.start + 4;
    const readLen = () => {
      let n = 0;
      for (let i = 0; i < 4 && p < box.end; i++) {
        const b = u8[p++];
        n = (n << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return n;
    };
    while (p < box.end) {
      const t = u8[p++];
      readLen();
      if (t === 0x03) p += 3; // ES_Descriptor: id (2) and flags (1)
      else if (t === 0x04) {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        const avg = dv.getUint32(p + 1 + 1 + 3 + 4);
        return avg > 0 ? Math.round(avg / 1000) : 0;
      } else return 0;
    }
    return 0;
  }

  /** Format facts from an MP4 init segment: { codec, rate, depth, channels, declaredKbps }, or null. */
  function parseMp4(u8) {
    const moov = boxes(u8, 0, u8.length).find((b) => b.type === "moov");
    if (!moov) return null;
    for (const trak of boxes(u8, moov.start, moov.end).filter((b) => b.type === "trak")) {
      let box = trak;
      for (const t of ["mdia", "minf", "stbl", "stsd"]) {
        box = box && child(u8, box, t);
      }
      if (!box) continue;
      const entry = boxes(u8, box.start + 8, box.end)[0];
      if (!entry || entry.end - entry.start < 28) continue;
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      let codec = entry.type;
      const kids = boxes(u8, entry.start + 28, entry.end);
      if (codec === "enca") {
        const frma = kids.find((b) => b.type === "sinf") && child(u8, kids.find((b) => b.type === "sinf"), "frma");
        if (frma) codec = tag(u8, frma.start);
      }
      const info = { codec, channels: dv.getUint16(entry.start + 16), depth: dv.getUint16(entry.start + 18), rate: dv.getUint32(entry.start + 24) >>> 16, declaredKbps: 0 };
      const dfLa = kids.find((b) => b.type === "dfLa");
      if (dfLa) {
        const s = dfLa.start + 4 + 4; // version/flags, then the metadata block header; STREAMINFO follows
        if (s + 14 <= dfLa.end) {
          info.rate = (u8[s + 10] << 12) | (u8[s + 11] << 4) | (u8[s + 12] >> 4);
          info.depth = (((u8[s + 12] & 1) << 4) | (u8[s + 13] >> 4)) + 1;
        }
      }
      const dec3 = kids.find((b) => b.type === "dec3");
      if (dec3) info.declaredKbps = (u8[dec3.start] << 5) | (u8[dec3.start + 1] >> 3);
      const esds = kids.find((b) => b.type === "esds");
      if (esds) info.declaredKbps = esdsBitrate(u8, esds);
      return info;
    }
    return null;
  }

  const WEBM_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
  /** A WebM/Opus stream (YouTube's): Opus is always played at 48 kHz, so only the codec is read from the MIME type. */
  const isWebm = (u8) => u8.length > 4 && WEBM_MAGIC.every((b, i) => u8[i] === b);

  // ---- Labels ----------------------------------------------------------------------------------------------------------------
  const NAMES = { flac: "FLAC", fLaC: "FLAC", opus: "Opus", Opus: "Opus", vorbis: "Vorbis", mp4a: "AAC", "ec-3": "Dolby Digital Plus", "ac-3": "Dolby Digital", alac: "ALAC", ac4: "Dolby AC-4", "ac-4": "Dolby AC-4" };
  function codecFromMime(mime) {
    const m = /codecs="?([^";,]+)/i.exec(mime ?? "");
    const c = (m?.[1] ?? "").trim();
    if (/^mp4a\.40\.(5|29)$/.test(c)) return "HE-AAC";
    if (/^mp4a\.6[9b]$/.test(c) || c === "mp3") return "MP3";
    return NAMES[c.split(".")[0]] ?? NAMES[c] ?? "";
  }

  function describe(rec) {
    const fromHeader = rec.info;
    const name = (fromHeader?.codec && NAMES[fromHeader.codec]) || codecFromMime(rec.mime);
    const rate = fromHeader?.rate || (/opus/i.test(rec.mime) ? 48000 : 0);
    const depth = name === "FLAC" || name === "ALAC" ? fromHeader?.depth || 0 : 0;
    const sec = rec.win.reduce((a, w) => a + w.sec, 0);
    const kbps = sec >= 5 ? Math.round((rec.win.reduce((a, w) => a + w.bytes, 0) * 8) / sec / 1000) : 0;
    return { name, rate, depth, channels: fromHeader?.channels || 0, kbps, declaredKbps: fromHeader?.declaredKbps || 0 };
  }

  /** "FLAC 24-bit / 96 kHz · ~2,310 kbps", "AAC 44.1 kHz · 256 kbps", "Opus 48 kHz · ~142 kbps". */
  function text(d) {
    if (!d.name) return "";
    const khz = d.rate ? `${+(d.rate / 1000).toFixed(1)} kHz` : "";
    const first = [d.name, d.depth ? `${d.depth}-bit` : "", d.depth && khz ? "/" : "", khz].filter(Boolean).join(" ").replace(" /", " /");
    const rate = d.declaredKbps ? `${d.declaredKbps} kbps` : d.kbps ? `~${d.kbps.toLocaleString("en-US")} kbps` : "";
    return [first, rate].filter(Boolean).join(" · ");
  }

  // ---- Watching the player's audio ---------------------------------------------------------------------------------------------
  const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = addSourceBuffer.apply(this, arguments);
    try {
      if (/^audio\//i.test(mime)) {
        const rec = { mime, info: null, win: [], last: 0, pending: 0, at: 0 };
        tracked.set(sb, rec);
        sb.addEventListener("updateend", () => {
          try {
            const end = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0;
            const delta = end - rec.last;
            rec.last = end;
            if (delta > 0 && delta < 40 && rec.pending > 0) {
              rec.win.push({ bytes: rec.pending, sec: delta });
              if (rec.win.length > 14) rec.win.shift();
              rec.at = Date.now();
            }
            rec.pending = 0;
          } catch {}
        });
      }
    } catch {}
    return sb;
  };
  const changeType = SourceBuffer.prototype.changeType;
  if (changeType) {
    SourceBuffer.prototype.changeType = function (mime) {
      const rec = tracked.get(this);
      if (rec) Object.assign(rec, { mime, info: null, win: [] });
      return changeType.apply(this, arguments);
    };
  }
  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    try {
      const rec = tracked.get(this);
      if (rec) {
        const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const head = u8.length > 8 ? tag(u8, 4) : "";
        if (head === "ftyp" || head === "moov" || isWebm(u8)) {
          // A new init segment: a new stream (the next song, or another quality), so start measuring afresh.
          rec.info = head === "ftyp" || head === "moov" ? parseMp4(u8) : null;
          rec.win = [];
          rec.last = 0;
        }
        rec.pending += u8.length;
      }
    } catch {}
    return appendBuffer.apply(this, arguments);
  };

  /** What the page is playing now, or null. */
  function current() {
    let best = null;
    for (const rec of tracked.values()) if (rec.at && Date.now() - rec.at < 60000 && (!best || rec.at > best.at)) best = rec;
    if (!best) return null;
    const d = describe(best);
    return d.name ? { ...d, text: text(d) } : null;
  }

  window.__lvQuality = current;
  window.__lvQualityParse = { parseMp4, text, describe, codecFromMime };
  setInterval(() => window.postMessage({ source: SOURCE, type: "quality", quality: current() }, location.origin), 1000);
})();
