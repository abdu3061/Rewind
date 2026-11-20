import { expect, it } from "vitest";
import {
  nativeBrowserMessageSchema,
  sanitizeBrowserMetadataUrl,
  type NativeBrowserMessage,
} from "@rewind/contracts";
import {
  encodeNativeBrowserMessage,
  isAllowedNativeCaller,
  NativeBrowserFrameDecoder,
} from "./native-messaging";

const id = "00000000-0000-4000-8000-000000000001";
const hello: NativeBrowserMessage = {
  version: 2,
  type: "hello",
  connectionId: id,
  profileId: id,
};
const visit: NativeBrowserMessage = {
  version: 2,
  type: "visit",
  connectionId: id,
  sessionId: id,
  generationId: id,
  capability: "a".repeat(64),
  sequence: 1,
  occurredAt: "2026-11-17T10:00:00.000Z",
  incognito: false,
  focused: true,
  url: "https://example.test/work",
  title: "Synthetic çalışma 🧪",
};
function frame(input: unknown) {
  const payload = Buffer.from(JSON.stringify(input));
  const result = Buffer.alloc(payload.length + 4);
  result.writeUInt32LE(payload.length);
  payload.copy(result, 4);
  return result;
}
it("handles fragmented headers, multibyte text and coalesced native messages", () => {
  const bytes = Buffer.concat([
    encodeNativeBrowserMessage(hello),
    encodeNativeBrowserMessage(visit),
  ]);
  const bytewise = new NativeBrowserFrameDecoder();
  const messages = [...bytes].flatMap((byte) =>
    bytewise.push(Uint8Array.of(byte)),
  );
  bytewise.finish();
  expect(messages).toEqual([hello, visit]);
  const combined = new NativeBrowserFrameDecoder();
  expect(combined.push(bytes)).toEqual([hello, visit]);
  combined.finish();
});
it("fails terminally on oversized/truncated/invalid UTF-8 or JSON frames and bounded floods", () => {
  for (const input of [
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([1, 0, 4, 0]),
    Buffer.from([2, 0, 0, 0, 0xc0, 0xaf]),
    Buffer.from([1, 0, 0, 0, 0x7b]),
    frame({ ...hello, version: 1 }),
    Buffer.concat(
      Array.from({ length: 33 }, () => encodeNativeBrowserMessage(hello)),
    ),
  ]) {
    const decoder = new NativeBrowserFrameDecoder();
    expect(() => decoder.push(input)).toThrow("NATIVE_MESSAGE_INVALID");
    expect(() => decoder.push(encodeNativeBrowserMessage(hello))).toThrow(
      "NATIVE_MESSAGE_INVALID",
    );
  }
  for (const input of [
    Buffer.from([4]),
    encodeNativeBrowserMessage(hello).subarray(0, -1),
  ]) {
    const decoder = new NativeBrowserFrameDecoder();
    decoder.push(input);
    expect(() => decoder.finish()).toThrow("NATIVE_MESSAGE_INVALID");
  }
});
it("rejects private/unfocused visits, secret-bearing URLs and expanded capabilities", () => {
  for (const extra of [
    { incognito: true },
    { focused: false },
    { articleText: "unapproved" },
    { path: "C:\\synthetic" },
    { sequence: 0 },
    { url: "chrome://settings" },
    { url: "https://user:pass@example.test" },
    { url: "https://example.test/?token=secret" },
  ])
    expect(
      nativeBrowserMessageSchema.safeParse({ ...visit, ...extra }).success,
    ).toBe(false);
  expect(
    sanitizeBrowserMetadataUrl(
      "https://example.test/work?token=secret#private",
      [],
    ),
  ).toBe("https://example.test/work");
  expect(
    sanitizeBrowserMetadataUrl("https://sub.private.test/work", [
      "private.test",
    ]),
  ).toBeNull();
  expect(
    sanitizeBrowserMetadataUrl("https://notprivate.test/work", [
      "private.test",
    ]),
  ).toBe("https://notprivate.test/work");
  expect(sanitizeBrowserMetadataUrl("file:///C:/synthetic", [])).toBeNull();
});
it("requires exact extension origins and never treats an empty allowlist as permission", () => {
  const origin = `chrome-extension://${"a".repeat(32)}`;
  expect(isAllowedNativeCaller(origin, [origin + "/"])).toBe(true);
  expect(isAllowedNativeCaller(origin + "/", [origin + "/"])).toBe(true);
  for (const value of [
    origin + "/path",
    origin + "?query",
    "https://example.test",
    origin.replace("aaa", "zzz"),
  ])
    expect(isAllowedNativeCaller(value, [origin + "/"])).toBe(false);
  expect(isAllowedNativeCaller(origin, [])).toBe(false);
});
