import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { randomBytes } from 'node:crypto';

export default defineConfig(({ command }) => {
  const nonce = randomBytes(16).toString('base64');
  return {
    plugins: [
      react(),
      {
        name: 'rewind-development-csp',
        apply: 'serve',
        transformIndexHtml: {
          order: 'post',
          handler: (html) =>
            html.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`),
        },
      },
    ],
    ...(command === 'serve' ? { html: { cspNonce: nonce } } : {}),
    base: './',
    server: { host: '127.0.0.1', strictPort: true },
  };
});
