import { describe, expect, it } from 'vitest';
import { SessionService } from '@rewind/engine';
import { dispatchSessionRequest, isTrustedRendererUrl } from './session-ipc';

describe('session IPC dispatcher', () => {
  it('validates untrusted requests before changing the engine', () => {
    const service = new SessionService({
      newId: () => '00000000-0000-4000-8000-000000000001',
      now: () => '2026-01-01T00:00:00.000Z',
    });
    expect(dispatchSessionRequest(service, { action: 'start', extra: true })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(service.getState()).toEqual({ session: null });
    expect(dispatchSessionRequest(service, { action: 'start' })).toMatchObject({
      ok: true,
      value: { session: { status: 'active' } },
    });
  });
  it('compares the actual renderer location, including custom scheme hosts and entry paths', () => {
    expect(isTrustedRendererUrl('rewind://app/index.html', 'rewind://app/index.html')).toBe(true);
    expect(isTrustedRendererUrl('rewind://evil/index.html', 'rewind://app/index.html')).toBe(false);
    expect(isTrustedRendererUrl('rewind://app/other.html', 'rewind://app/index.html')).toBe(false);
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/', 'http://127.0.0.1:5173/')).toBe(true);
    expect(isTrustedRendererUrl('http://127.0.0.1:5174/', 'http://127.0.0.1:5173/')).toBe(false);
    expect(isTrustedRendererUrl('http://user@127.0.0.1:5173/', 'http://127.0.0.1:5173/')).toBe(
      false,
    );
    expect(isTrustedRendererUrl('not a URL', 'rewind://app/index.html')).toBe(false);
  });
});
