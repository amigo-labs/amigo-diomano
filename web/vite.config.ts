import { defineConfig } from "vite";

// No plugins, no wasm loader, no glue: the module is fetched with
// `WebAssembly.instantiateStreaming` from `public/` at runtime (HANDOFF §9.4),
// so Vite only ever sees TypeScript.
export default defineConfig({
  root: ".",
  build: {
    target: "es2022",
    // Every budget in §7.5 is stated for the compressed payload, so keeping the
    // report on makes an overrun visible at build time rather than on a user's
    // office machine.
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        manualChunks: { three: ["three"] },
      },
    },
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
