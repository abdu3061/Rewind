import { defineConfig } from "vite";

export default defineConfig({
  define: { __REWIND_NATIVE_HOST_NAME__: JSON.stringify("com.rewind.bridge") },
  build: {
    target: "es2022",
    minify: false,
    lib: {
      entry: { background: "src/background.ts", popup: "src/popup.ts" },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    emptyOutDir: true,
  },
});
