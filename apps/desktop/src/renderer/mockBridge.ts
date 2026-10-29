export function initMockBridge() {
  if (typeof window === "undefined") return;
  if ("bridge" in window && (window as unknown as { bridge: unknown }).bridge) {
    return;
  }
  (window as unknown as { bridge: Record<string, unknown> }).bridge = {
    sessions: {
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      status: async () => ({ ok: true, active: false }),
    },
  };
}
