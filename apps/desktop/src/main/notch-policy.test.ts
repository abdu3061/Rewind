import { describe, expect, it } from "vitest";
import { notchAllowsRecording, notchBounds } from "./notch-policy";
import { presentationCommandSchema } from "@rewind/contracts";
import { parseNotchCommand } from "../renderer/notch-command";

describe("notch geometry and capability boundary", () => {
  it("centers within the chosen work area, including negative monitor origins", () => {
    expect(
      notchBounds({ x: -1920, y: -80, width: 1920, height: 1040 }, false),
    ).toEqual({ x: -1032, y: -80, width: 144, height: 64 });
    expect(
      notchBounds({ x: 1920, y: 40, width: 1280, height: 680 }, true, 420),
    ).toEqual({ x: 2180, y: 40, width: 760, height: 420 });
  });
  it("uses DIPs directly at scaled and constrained displays without leaving work area", () => {
    // 1920 physical pixels at 150% = 1280 Electron DIPs. No second scaling.
    expect(notchBounds({ x: 0, y: 0, width: 1280, height: 720 }, true)).toEqual(
      { x: 260, y: 0, width: 760, height: 270 },
    );
    expect(
      notchBounds({ x: -300, y: 12, width: 300, height: 180 }, true, 500),
    ).toEqual({ x: -300, y: 12, width: 300, height: 180 });
  });
  it("admits only actual local quick actions, never grants, cloud, recovery or maintenance", () => {
    for (const kind of [
      "runtime.get",
      "timeline.query",
      "versions.list",
      "checkpoints.create",
    ])
      expect(notchAllowsRecording({ kind })).toBe(true);
    for (const kind of [
      "privacy.update",
      "recording.configure",
      "recording.state",
      "files.permission",
      "browser.permission",
      "assistant.ask",
      "content.search",
      "recovery.confirm",
      "storage.cleanup",
      "runtime.retry",
      "checkpoints.delete",
    ])
      expect(notchAllowsRecording({ kind })).toBe(false);
    expect(notchAllowsRecording(null)).toBe(false);
  });
  it("rejects extra window capabilities, unbounded resizing and arbitrary navigation", () => {
    for (const command of [
      { action: "resize", height: 10000 },
      { action: "open", page: "C:\\secret" },
      { action: "expand", focus: true },
      { action: "quit" },
    ])
      expect(presentationCommandSchema.safeParse(command).success).toBe(false);
  });
});
describe("honest local command vocabulary", () => {
  it("routes supported natural phrasing to real capabilities", () => {
    expect(parseNotchCommand("Please pause my recording.")).toEqual({
      kind: "session",
      action: "pause",
    });
    expect(parseNotchCommand("What was I working on?")).toEqual({
      kind: "search",
    });
    expect(parseNotchCommand("Show websites I visited")).toEqual({
      kind: "search",
      browser: true,
    });
    expect(parseNotchCommand("Restore a file")).toEqual({
      kind: "open",
      page: "Files",
    });
    expect(parseNotchCommand("Save a checkpoint")).toEqual({
      kind: "checkpoint",
    });
  });
  it("treats unsupported requests as bounded local searches, never as destructive or cloud actions", () => {
    expect(parseNotchCommand("delete everything")).toEqual({
      kind: "search",
      text: "delete everything",
    });
    expect(parseNotchCommand("Find thesis")).toEqual({
      kind: "search",
      text: "thesis",
    });
    expect(parseNotchCommand("a".repeat(1000))).toEqual({
      kind: "search",
      text: "a".repeat(500),
    });
  });
});
