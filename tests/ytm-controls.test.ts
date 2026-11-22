import { expect, test } from "bun:test";
import { acceptYtmState, drainYtm, parseYtmState, queueYtm, sameSong, ytmNow } from "../src/ytmControls.ts";

test("a state report is read field by field", () => {
  expect(parseYtmState({ title: "Bring Me To Life", like: true, shuffle: true, repeat: "ONE", volume: 40, quality: "YouTube Music · Opus 160 kbps" })).toEqual({
    site: "ytm", title: "Bring Me To Life", heart: true, shuffle: true, repeat: 2, volume: 0.4, quality: "YouTube Music · Opus 160 kbps",
  });
  const odd = parseYtmState({ title: "x", like: "yes", repeat: "banana", volume: 500, quality: "<script>" });
  expect(odd).toEqual({ site: "ytm", title: "x", heart: false, shuffle: false, repeat: 0, volume: 1, quality: undefined });
  expect(parseYtmState(null)).toBeNull();
  expect(parseYtmState({ title: "" })).toBeNull();
  expect(parseYtmState({ title: "a".repeat(301) })).toBeNull();
});

test("a report counts only while it is recent", () => {
  acceptYtmState({ title: "Song", like: false });
  expect(ytmNow()?.title).toBe("Song");
  expect(ytmNow(Date.now() + 5000)).toBeNull();
});

test("the report must be for the song Windows shows", () => {
  const state = parseYtmState({ title: "Bring Me To Life" })!;
  expect(sameSong(state, " bring me to life ")).toBe(true);
  expect(sameSong(state, "Something Else")).toBe(false);
  expect(sameSong(state, undefined)).toBe(false);
});

test("only the four fixed actions are queued, and a newer one replaces an older of its kind", () => {
  drainYtm();
  expect(queueYtm("rm -rf")).toBe(false);
  queueYtm("volume", 0.2);
  queueYtm("heart");
  queueYtm("volume", 0.7);
  expect(drainYtm()).toEqual([{ action: "heart", arg: 0 }, { action: "volume", arg: 0.7 }]);
  expect(drainYtm()).toEqual([]);
});

test("a command goes only to the site that is playing", () => {
  acceptYtmState({ site: "amazon", title: "Song" });
  drainYtm("amazon");
  queueYtm("shuffle");
  expect(drainYtm("ytm")).toEqual([]);
  expect(drainYtm("amazon")).toEqual([{ action: "shuffle", arg: 0 }]);
  expect(parseYtmState({ site: "amazon", title: "x" })?.site).toBe("amazon");
  expect(parseYtmState({ site: "spotify", title: "x" })?.site).toBe("ytm");
});

test("a measured quality line with ~ and a comma is accepted", () => {
  const q = "Amazon Music · Ultra HD · FLAC 24-bit / 96 kHz · ~2,320 kbps";
  expect(parseYtmState({ title: "x", quality: q })?.quality).toBe(q);
  expect(parseYtmState({ title: "x", quality: "<img src=x>" })?.quality).toBeUndefined();
});
