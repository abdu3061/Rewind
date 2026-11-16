import { describe, expect, it } from "vitest";
import { SessionService } from "@rewind/engine";
import { dispatchSessionRequest, isTrustedRendererUrl } from "./session-ipc";

describe("session IPC dispatcher", () => {
  it("turns rejected operations and malformed successful responses into structured failures", async () => {
    expect(
      await dispatchSessionRequest(
        {
          execute: async () => {
            throw new Error("private synthetic text");
          },
        },
        { action: "start" },
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "The session service is unavailable.",
      },
    });
    const malformed = {
      execute: async () => ({ ok: true, value: { session: "invalid" } }),
    };
    expect(
      await dispatchSessionRequest(
        malformed as unknown as Parameters<typeof dispatchSessionRequest>[0],
        { action: "get" },
      ),
    ).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });
  it("validates untrusted requests before changing the engine", async () => {
    const service = new SessionService({
      newId: () => "00000000-0000-4000-8000-000000000001",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(
      await dispatchSessionRequest(service, { action: "start", extra: true }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(service.getState()).toEqual({ session: null });
    expect(
      await dispatchSessionRequest(service, { action: "start" }),
    ).toMatchObject({
      ok: true,
      value: { session: { status: "active" } },
    });
  });
  it("compares the actual renderer location, including custom scheme hosts and entry paths", () => {
    expect(
      isTrustedRendererUrl(
        "rewind://app/index.html",
        "rewind://app/index.html",
      ),
    ).toBe(true);
    expect(
      isTrustedRendererUrl(
        "rewind://evil/index.html",
        "rewind://app/index.html",
      ),
    ).toBe(false);
    expect(
      isTrustedRendererUrl(
        "rewind://app/other.html",
        "rewind://app/index.html",
      ),
    ).toBe(false);
    expect(
      isTrustedRendererUrl("http://127.0.0.1:5173/", "http://127.0.0.1:5173/"),
    ).toBe(true);
    expect(
      isTrustedRendererUrl("http://127.0.0.1:5174/", "http://127.0.0.1:5173/"),
    ).toBe(false);
    expect(
      isTrustedRendererUrl(
        "http://user@127.0.0.1:5173/",
        "http://127.0.0.1:5173/",
      ),
    ).toBe(false);
    expect(isTrustedRendererUrl("not a URL", "rewind://app/index.html")).toBe(
      false,
    );
  });
});
