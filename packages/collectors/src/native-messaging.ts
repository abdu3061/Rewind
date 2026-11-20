import {
  nativeBrowserMessageSchema,
  type NativeBrowserMessage,
} from "@rewind/contracts";

export const maxNativeMessageBytes = 256 * 1024;
const invalid = () => new Error("NATIVE_MESSAGE_INVALID");

/** Windows Native Messaging framing, not a host executable or an authenticated transport. */
export function encodeNativeBrowserMessage(
  input: NativeBrowserMessage,
): Buffer {
  const parsed = nativeBrowserMessageSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const payload = Buffer.from(JSON.stringify(parsed.data), "utf8");
  if (!payload.length || payload.length > maxNativeMessageBytes)
    throw invalid();
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

/** Terminal on malformed input; retains at most one bounded frame and never resynchronizes. */
export class NativeBrowserFrameDecoder {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private payload: Buffer | null = null;
  private payloadBytes = 0;
  private terminal = false;
  private fail(): never {
    this.terminal = true;
    this.payload?.fill(0);
    this.payload = null;
    this.header.fill(0);
    throw invalid();
  }
  push(chunk: Uint8Array): NativeBrowserMessage[] {
    if (this.terminal || chunk.byteLength > 1024 * 1024) return this.fail();
    const input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const messages: NativeBrowserMessage[] = [];
    let position = 0;
    while (position < input.length) {
      if (!this.payload) {
        const size = Math.min(4 - this.headerBytes, input.length - position);
        input.copy(this.header, this.headerBytes, position, position + size);
        position += size;
        this.headerBytes += size;
        if (this.headerBytes < 4) continue;
        const length = this.header.readUInt32LE();
        if (length === 0 || length > maxNativeMessageBytes) return this.fail();
        this.payload = Buffer.alloc(length);
      }
      const size = Math.min(
        this.payload.length - this.payloadBytes,
        input.length - position,
      );
      input.copy(this.payload, this.payloadBytes, position, position + size);
      position += size;
      this.payloadBytes += size;
      if (this.payloadBytes < this.payload.length) continue;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          this.payload,
        );
        const parsed = nativeBrowserMessageSchema.safeParse(JSON.parse(text));
        if (!parsed.success || messages.length >= 32) return this.fail();
        messages.push(parsed.data);
      } catch {
        return this.fail();
      }
      this.payload.fill(0);
      this.payload = null;
      this.payloadBytes = 0;
      this.headerBytes = 0;
    }
    return messages;
  }
  finish(): void {
    if (this.terminal || this.headerBytes !== 0 || this.payload) this.fail();
    this.terminal = true;
  }
}

/** Only checks browser-supplied origin syntax/allowlist. Pipe ACLs and fresh authority are still mandatory. */
export function isAllowedNativeCaller(
  origin: string,
  allowedOrigins: readonly string[],
): boolean {
  const matched = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(origin);
  if (!matched?.[1]) return false;
  const canonical = `chrome-extension://${matched[1]}/`;
  return allowedOrigins.includes(canonical);
}
