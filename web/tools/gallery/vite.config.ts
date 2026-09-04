import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** Builds the gallery on its own, into `tools/gallery/dist`, never into the client's. */
export default defineConfig({
  // `import.meta.url` rather than `__dirname`: the config is loaded as ESM,
  // where `__dirname` does not exist.
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: false,
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
