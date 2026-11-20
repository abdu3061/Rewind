import { describe, expect, it } from "vitest";
import { sessionStateSchema, type SessionAction } from "@rewind/contracts";
import { SessionService } from "./session-service";

function harness() {
  let tick = 0;
  let id = 0;
  const service = new SessionService({
    newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  });
  return service;
}

describe("SessionService", () => {
  it("does not publish prepared state and rejects stale or repeated commits", () => {
    const service = harness();
    const first = service.prepare("start");
    const second = service.prepare("start");
    expect(service.getState()).toEqual({ session: null });
    if (!first.ok || !second.ok) throw new Error("Expected candidates.");
    first.value.state.session!.status = "ended";
    expect(first.value.commit()).toMatchObject({
      ok: true,
      value: { session: { status: "active" } },
    });
    expect(first.value.commit().ok).toBe(false);
    expect(second.value.commit().ok).toBe(false);
  });
  it("rejects a new session identity reused by a broken environment", () => {
    const service = new SessionService({
      newId: () => "00000000-0000-4000-8000-000000000001",
      now: () => "2026-11-16T10:00:00.000Z",
    });
    service.execute("start");
    service.execute("end");
    expect(service.execute("start")).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(service.getState().session?.status).toBe("ended");
  });
  it("rejects invalid or active restored state instead of resuming authority", () => {
    const service = harness();
    expect(
      service.restore({
        id: "00000000-0000-4000-8000-000000000001",
        status: "active",
        startedAt: "2026-11-16T10:00:00.000Z",
        updatedAt: "2026-11-16T10:00:00.000Z",
        endedAt: null,
      }).ok,
    ).toBe(false);
    expect(service.getState()).toEqual({ session: null });
  });
  it("runs a full lifecycle, retains the ended session, and starts a distinct session", () => {
    const service = harness();
    expect(service.getState()).toEqual({ session: null });
    for (const action of ["start", "pause", "resume", "end"] as const) {
      expect(service.execute(action).ok).toBe(true);
      expect(sessionStateSchema.safeParse(service.getState()).success).toBe(
        true,
      );
    }
    const ended = service.getState().session;
    expect(ended).toMatchObject({
      status: "ended",
      endedAt: "2026-01-01T00:00:03.000Z",
    });
    expect(service.execute("start").ok).toBe(true);
    expect(service.getState().session?.id).not.toBe(ended?.id);
    expect(service.getState().session?.endedAt).toBeNull();
  });

  const cases: {
    state: "missing" | "active" | "paused" | "ended";
    allowed: SessionAction[];
  }[] = [
    { state: "missing", allowed: ["get", "start"] },
    { state: "active", allowed: ["get", "pause", "end"] },
    { state: "paused", allowed: ["get", "resume", "end"] },
    { state: "ended", allowed: ["get", "start"] },
  ];
  for (const { state, allowed } of cases) {
    for (const action of ["get", "start", "pause", "resume", "end"] as const) {
      it(`${state} -> ${action}: ${allowed.includes(action) ? "allowed" : "rejected without mutation"}`, () => {
        const service = harness();
        if (state !== "missing") service.execute("start");
        if (state === "paused") service.execute("pause");
        if (state === "ended") service.execute("end");
        const before = service.getState();
        const result = service.execute(action);
        expect(result.ok).toBe(allowed.includes(action));
        if (!result.ok) {
          expect(result.error.code).toBe("INVALID_TRANSITION");
          expect(service.getState()).toEqual(before);
        }
        if (action === "get") expect(service.getState()).toEqual(before);
      });
    }
  }

  it("returns copies so callers cannot change engine state", () => {
    const service = harness();
    service.execute("start");
    const state = service.getState();
    if (!state.session) throw new Error("Expected a session.");
    state.session.status = "ended";
    expect(service.getState().session?.status).toBe("active");
  });

  it("keeps valid timestamps when the system clock moves backwards", () => {
    let time = "2026-01-02T00:00:00.000Z";
    const service = new SessionService({
      newId: () => "00000000-0000-4000-8000-000000000001",
      now: () => time,
    });
    service.execute("start");
    time = "2026-01-01T00:00:00.000Z";
    service.execute("end");
    expect(sessionStateSchema.safeParse(service.getState()).success).toBe(true);
    expect(service.getState().session?.endedAt).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });
});
