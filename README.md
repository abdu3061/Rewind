# Rewind

Scaffold added: starter Electron + React layout, API placeholders, DB schema, and design folder.

What I added

- package.json (minimal)
- electron/ (main.ts, preload.ts)
- public/index.html
- src/ (renderer.tsx, pages, components, styles)
- api/ (placeholders for Google ADK and session manager)
- db/ (schema + migration)
- designs/ (README for designers)

Next steps

1. Install dependencies: `npm install`.
2. Implement build for renderer (webpack/parcel/esbuild) or compile TypeScript to JS and point electron to built files.
3. Implement API logic in api/ and wire to ipcMain handlers in electron/main.ts.
4. Add real Google ADK credentials and implement calls in api/ai/googleAdkClient.ts.

