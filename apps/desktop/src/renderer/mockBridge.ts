export function initMockBridge() {
  const win = window as unknown as {
    bridge?: unknown;
    electron?: unknown;
    api?: unknown;
  };
  if (win.bridge || win.electron || win.api) return;

  (window as unknown as { bridge: Record<string, unknown> }).bridge = {
    sessions: {
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      status: async () => ({ ok: true, active: false }),
    },
  };
}
