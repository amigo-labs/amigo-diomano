import { defineConfig } from "vite";

/** Builds the gallery on its own, into `tools/gallery/dist`, never into the client's. */
export default defineConfig({
  root: __dirname,
  publicDir: false,
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
