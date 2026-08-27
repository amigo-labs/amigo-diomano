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
        // three's core in one chunk, fetched behind the title card. The entry
        // chunk imports no three at all — see the header of `main.ts`.
        //
        // Watch this number. It is a *tree-shaken* set, and it is easy to
        // un-shake by accident: putting the `THREE` namespace object on the
        // debug handle in `game.ts` — three characters — took it from 490 kB to
        // 705 kB, because a namespace that something can read is a namespace
        // nothing can be dropped from. `reportCompressedSize` above is what
        // makes that visible at build time.
        manualChunks: { three: ["three"] },
      },
    },
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
