import { expect, test } from "bun:test";
import { acceptYtmState, drainYtm, parseYtmState, queueYtm, sameSong, ytmNow } from "../src/ytmControls.ts";

test("a state report is read field by field", () => {
  expect(parseYtmState({ title: "Bring Me To Life", like: true, shuffle: true, repeat: "ONE", volume: 40, quality: "YouTube Music · Opus 160 kbps" })).toEqual({
    title: "Bring Me To Life", heart: true, shuffle: true, repeat: 2, volume: 0.4, quality: "YouTube Music · Opus 160 kbps",
  });
  const odd = parseYtmState({ title: "x", like: "yes", repeat: "banana", volume: 500, quality: "<script>" });
  expect(odd).toEqual({ title: "x", heart: false, shuffle: false, repeat: 0, volume: 1, quality: undefined });
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
