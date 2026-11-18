import { defineConfig } from "vite";
import { builtinModules } from "node:module";
export default defineConfig({
  build: {
    rollupOptions: {
      external: [...builtinModules, "electron", /^node:/, /^pdfjs-dist\//],
    },
  },
});
