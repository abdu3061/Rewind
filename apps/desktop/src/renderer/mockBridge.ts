export function initMockBridge() {
  if (typeof window === "undefined") return;
  const isElectron = navigator.userAgent.includes("Electron");
  if (isElectron || "bridge" in window) return;

  (window as unknown as { bridge: Record<string, unknown> }).bridge = {
    sessions: {
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      status: async () => ({ ok: true, active: false }),
    },
  };
}
