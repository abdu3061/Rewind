import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps the starter extension inactive and excludes incognito', () => {
  const manifest = JSON.parse(
    readFileSync('apps/browser-extension/public/manifest.json', 'utf8'),
  ) as Record<string, unknown>;
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.incognito).toBe('not_allowed');
  expect(manifest.permissions).toBeUndefined();
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.content_scripts).toBeUndefined();
  expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
});
