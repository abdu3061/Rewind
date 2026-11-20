import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRelayRequest, DocumentText } from "@rewind/contracts";
import { RecordingDocumentClient } from "./document-client";

const text: DocumentText = {
  state: "available",
  format: "pdf",
  text: "synthetic selected text",
  truncated: false,
  pagesRead: 1,
  totalPages: 1,
};
function setup() {
  const sent: DocumentRelayRequest[] = [];
  const send = vi.fn((value: DocumentRelayRequest) => {
    sent.push(structuredClone(value));
  });
  const client = new RecordingDocumentClient(send, { parse: 100, stop: 40 });
  const reply = (
    result: DocumentText = text,
    closed = true,
    id = sent[0]!.id,
  ) =>
    client.receive({ version: 1, type: "document-result", id, result, closed });
  const stopped = (closed = true, id = sent.at(-1)!.id) =>
    client.receive({ version: 1, type: "document-stopped", id, closed });
  return { client, send, sent, reply, stopped };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("recording utility document relay", () => {
  it("an old owner cannot stop a replacement parser request", async () => {
    const s = setup(),
      old = new AbortController(),
      current = new AbortController();
    const first = s.client.extract("pdf", Uint8Array.of(1), old.signal);
    s.reply();
    expect(await first).toEqual(text);
    const second = s.client.extract("pdf", Uint8Array.of(2), current.signal);
    const count = s.sent.length;
    old.abort();
    expect(await s.client.stop(old.signal)).toBe(true);
    expect(s.sent).toHaveLength(count);
    expect(s.client.busy).toBe(true);
    s.reply(text, true, s.sent.at(-1)!.id);
    expect(await second).toEqual(text);
  });
  it("retains owner authority for an unconfirmed parser after its result settles", async () => {
    const s = setup(),
      owner = new AbortController(),
      unrelated = new AbortController();
    const result = s.client.extract("pdf", Uint8Array.of(1), owner.signal);
    s.reply(text, false);
    expect(await result).toMatchObject({ state: "unavailable" });
    expect(await s.client.stop(unrelated.signal)).toBe(true);
    expect(s.sent).toHaveLength(1);
    const first = s.client.stop(owner.signal);
    expect(s.client.stop(owner.signal)).toBe(first);
    s.stopped(false);
    expect(await first).toBe(false);
    expect(s.client.busy).toBe(true);
    const retry = s.client.stop(owner.signal);
    s.stopped();
    expect(await retry).toBe(true);
    expect(s.client.busy).toBe(false);
  });
  it("can stop the owning request after a lost reply", async () => {
    const s = setup(),
      owner = new AbortController();
    const result = s.client.extract("pdf", Uint8Array.of(1), owner.signal);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ reason: "timeout" });
    const stopped = s.client.stop(owner.signal);
    s.stopped();
    expect(await stopped).toBe(true);
    expect(s.client.busy).toBe(false);
  });
  it("relays bounded original bytes and accepts only the matching format/identity", async () => {
    const s = setup(),
      bytes = Uint8Array.of(1, 2);
    const result = s.client.extract("pdf", bytes);
    expect(s.sent[0]).toMatchObject({
      type: "document-parse",
      format: "pdf",
      bytes,
    });
    expect(s.reply(text, true, "00000000-0000-4000-8000-000000000001")).toBe(
      false,
    );
    expect(
      s.reply({ state: "unavailable", format: "docx", reason: "malformed" }),
    ).toBe(false);
    expect(s.reply()).toBe(true);
    expect(await result).toEqual(text);
    expect(bytes).toEqual(Uint8Array.of(1, 2));
    expect(await s.client.stop()).toBe(true);
  });
  it("coalesces stop requests, cancels publication and waits for the close acknowledgement", async () => {
    const s = setup(),
      result = s.client.extract("pdf", Uint8Array.of(1));
    const first = s.client.stop(),
      second = s.client.stop();
    expect(first).toBe(second);
    expect(s.sent).toHaveLength(2);
    expect(s.stopped(true, s.sent[0]!.id)).toBe(false);
    s.stopped();
    expect(await first).toBe(true);
    expect(await result).toMatchObject({
      state: "unavailable",
      reason: "cancelled",
    });
    expect(s.reply()).toBe(false);
  });
  it("does not treat abort as proof of actual stop", async () => {
    const s = setup(),
      abort = new AbortController();
    const result = s.client.extract("pdf", Uint8Array.of(1), abort.signal);
    abort.abort();
    expect(s.sent.at(-1)?.type).toBe("document-stop");
    s.stopped(false);
    expect(await s.client.extract("pdf", Uint8Array.of(2))).toMatchObject({
      state: "unavailable",
      reason: "unavailable",
    });
    s.reply(text, false);
    expect(await result).toMatchObject({
      state: "unavailable",
      reason: "cancelled",
    });
    const retry = s.client.stop();
    s.stopped(true);
    expect(await retry).toBe(true);
  });
  it("refuses text if the parser process has not actually closed", async () => {
    const s = setup(),
      result = s.client.extract("pdf", Uint8Array.of(1));
    s.reply(text, false);
    expect(await result).toMatchObject({
      state: "unavailable",
      reason: "unavailable",
    });
    expect(await s.client.extract("pdf", Uint8Array.of(2))).toMatchObject({
      state: "unavailable",
    });
    const stopped = s.client.stop();
    s.stopped(true);
    expect(await stopped).toBe(true);
    const next = s.client.extract("pdf", Uint8Array.of(3));
    s.reply(text, true, s.sent.at(-1)!.id);
    expect(await next).toEqual(text);
  });
  it("remains unconfirmed on a lost reply until an explicit close succeeds", async () => {
    const s = setup(),
      result = s.client.extract("pdf", Uint8Array.of(1));
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({
      state: "unavailable",
      reason: "timeout",
    });
    const stop = s.client.stop();
    await vi.advanceTimersByTimeAsync(40);
    expect(await stop).toBe(false);
    expect(await s.client.extract("pdf", Uint8Array.of(2))).toMatchObject({
      state: "unavailable",
    });
    const retry = s.client.stop();
    s.stopped();
    expect(await retry).toBe(true);
  });
  it("does not replace a newer closure proof with an older timed-out stop", async () => {
    const s = setup(),
      result = s.client.extract("pdf", Uint8Array.of(1));
    const stopped = s.client.stop();
    s.reply();
    s.stopped(false);
    expect(await result).toMatchObject({
      state: "unavailable",
      reason: "cancelled",
    });
    expect(await stopped).toBe(true);
    const next = s.client.extract("pdf", Uint8Array.of(2));
    s.reply(text, true, s.sent.at(-1)!.id);
    expect(await next).toEqual(text);
  });
  it("rejects concurrent requests and malformed replies", async () => {
    const s = setup(),
      first = s.client.extract("pdf", Uint8Array.of(1));
    expect(await s.client.extract("pdf", Uint8Array.of(2))).toMatchObject({
      state: "unavailable",
    });
    expect(s.client.receive({ type: "document-result", result: text })).toBe(
      false,
    );
    expect(
      s.client.receive({
        version: 1,
        type: "document-result",
        id: s.sent[0]!.id,
        result: { ...text, text: "x".repeat(65537) },
        closed: true,
      }),
    ).toBe(false);
    s.reply();
    expect(await first).toEqual(text);
  });
  it("latches an ambiguous transport failure until stop is confirmed", async () => {
    const s = setup();
    s.send.mockImplementationOnce(() => {
      throw new Error("SYNTHETIC_PORT_CLOSED");
    });
    expect(await s.client.extract("pdf", Uint8Array.of(1))).toMatchObject({
      state: "unavailable",
    });
    const stopped = s.client.stop();
    s.stopped();
    expect(await stopped).toBe(true);
  });
  it("rejects an already cancelled job and empty input without sending bytes", async () => {
    const s = setup(),
      abort = new AbortController();
    abort.abort();
    expect(
      await s.client.extract("pdf", Uint8Array.of(1), abort.signal),
    ).toMatchObject({ state: "unavailable", reason: "cancelled" });
    expect(await s.client.extract("pdf", new Uint8Array())).toMatchObject({
      state: "unavailable",
      reason: "limit",
    });
    expect(s.send).not.toHaveBeenCalled();
  });
});
