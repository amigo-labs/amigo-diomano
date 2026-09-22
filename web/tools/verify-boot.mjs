/**
 * Does the shipped bundle start? HANDOFF §7.5.
 *
 * # Why a test exists for "the page loads"
 *
 * Everything else in CI checks the simulation, and the simulation is not what
 * broke: `game-A6IDG8Wz.js` shipped a `ReferenceError: Cannot access 'ba'
 * before initialization` and the front door said "diomano could not start" to
 * every visitor. `tsc` was green, `biome` was green, the corpus replayed to the
 * hash — because none of them ever *ran the bundle*. `deploy-check` built it
 * and threw it away.
 *
 * The failure was an evaluation-order one, which is a whole class no type
 * checker can see: a top-level `const` reading another module's top-level
 * `const` before the bundler had run it. `verify-cycles.mjs` guards the cause
 * that produced this instance; this guards the symptom, and it does so for
 * every other way a bundle can fail to boot — a bad chunk split, a missing
 * asset, a shader that will not compile.
 *
 * It is deliberately not `screenshot.mjs`, which drives eight minutes of
 * gameplay and exists to be looked at. This one asks one question in a few
 * seconds and answers it with an exit code.
 *
 * It also asks one thing only a running client can answer: whether every
 * material that patches three's shaders is drawn with the program its patch
 * produced, rather than with one three cached for another material.
 *
 * Usage:  node tools/verify-boot.mjs
 * Exits 0 when the game handle appears with a clean console, 1 otherwise.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(WEB_ROOT, "dist");

/** How long the bundle gets to put `window.diomano` up, in ms. */
const BOOT_BUDGET = 30_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
};

class Failure extends Error {}

function fail(message) {
  throw new Failure(message);
}

function chromiumLaunchOptions() {
  const explicit = process.env.DIOMANO_CHROMIUM ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const candidates = [explicit, "/opt/pw-browsers/chromium"].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return { executablePath: path };
  }
  return {};
}

/**
 * Serve `dist/` and nothing else. `vite build` copies `public/` into it, so the
 * wasm and the textures are already there — and serving only the build output
 * is the point: a file the build forgot to emit has to 404 here rather than be
 * quietly satisfied from the source tree.
 */
function serve() {
  return new Promise((ok) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let rel;
      try {
        rel = normalize(decodeURIComponent(url.pathname)).replaceAll("\\", "/");
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      rel = rel.replace(/^\/+/, "");
      if (rel === "" || rel === ".") rel = "index.html";
      const file = join(DIST, rel);
      // A `..` in the path must not reach out of the build directory.
      if (file !== DIST && !file.startsWith(DIST + sep)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, {
          "content-type": MIME[extname(file)] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        res.end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => ok(server));
  });
}

/**
 * Materials that three.js resolved to one compiled program while their
 * `onBeforeCompile` hooks write different GLSL, as `"a / b"` name pairs.
 *
 * Asked of the running client after `renderer.compile`, so every material in
 * the scene has a program. The hooks are then replayed against one stub shader
 * carrying every marker the client injects at: two materials sharing a program
 * must produce the same text from it, or one of them is not drawn with its own.
 */
async function sharedPrograms(browser, port, tier) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(`http://127.0.0.1:${port}/?seed=5eed&tier=${tier}`, { waitUntil: "load" });
    await page.waitForFunction(() => window.diomano !== undefined, null, { timeout: BOOT_BUDGET });
    return await page.evaluate(() => {
      const { renderer, scene, camera } = window.diomano;
      renderer.compile(scene, camera.camera);
      const markers = [
        "#include <common>",
        "#include <beginnormal_vertex>",
        "#include <begin_vertex>",
        "#include <project_vertex>",
        "#include <opaque_fragment>",
      ].join("\n");
      const patched = (material) => {
        const shader = { uniforms: {}, vertexShader: markers, fragmentShader: markers };
        material.onBeforeCompile(shader, renderer);
        return `${shader.vertexShader}\n----\n${shader.fragmentShader}`;
      };
      const byProgram = new Map();
      scene.traverse((object) => {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (!material || material.onBeforeCompile.toString() === "function () {}") continue;
          const program = renderer.properties.get(material).currentProgram;
          if (!program) continue;
          const group = byProgram.get(program) ?? new Map();
          group.set(material, object.name || object.type);
          byProgram.set(program, group);
        }
      });
      const clashes = [];
      for (const group of byProgram.values()) {
        const [first, ...rest] = [...group.entries()];
        if (!first) continue;
        const source = patched(first[0]);
        for (const [material, name] of rest) {
          if (patched(material) !== source) clashes.push(`${first[1]} / ${name}`);
        }
      }
      return clashes;
    });
  } finally {
    await page.close();
  }
}

async function main() {
  if (!existsSync(join(DIST, "index.html"))) fail("no build; run `just build-web` first");
  if (!existsSync(join(DIST, "diomano.wasm"))) {
    fail("the build has no diomano.wasm; run `just wasm` before `bun run build`");
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    fail("playwright is not installed; run `bun install` in web/");
  }

  const server = await serve();
  const { port } = server.address();
  const browser = await chromium.launch({
    headless: true,
    // A CI runner has no GPU, and a client that cannot get a WebGL2 context
    // fails for a reason this check is not about.
    args: ["--enable-unsafe-swiftshader"],
    ...chromiumLaunchOptions(),
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    // Collected, not thrown: an exception raised inside a module or a listener
    // never reaches this `try`, and the interesting ones are exactly those.
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(`http://127.0.0.1:${port}/?seed=5eed`, { waitUntil: "load" });

    // `window.diomano` is set at the end of `startGame`, so it is the one signal
    // that means the whole boot path ran: the game chunk evaluated, the wasm
    // instantiated, the renderer built its scene.
    let booted = true;
    try {
      await page.waitForFunction(() => window.diomano !== undefined, null, {
        timeout: BOOT_BUDGET,
      });
    } catch {
      booted = false;
    }

    // Read the epitaph before reporting anything: when `#fallback` has text, it
    // is a better error message than "the handle never appeared".
    const epitaph = (await page.locator("#fallback").textContent())?.trim() ?? "";

    const problems = [];
    if (epitaph.length > 0) problems.push(`the page shows an epitaph:\n      ${epitaph}`);
    if (!booted) problems.push(`no window.diomano after ${BOOT_BUDGET / 1000} s`);
    for (const e of pageErrors) problems.push(`uncaught: ${e}`);
    for (const e of consoleErrors) problems.push(`console.error: ${e}`);

    if (problems.length > 0) {
      console.error("\nBOOT FAILURE — the built client does not start.\n");
      for (const p of problems) console.error(`  ${p}`);
      console.error(
        "\nThis is the bundle, not the source: `tsc` and `biome` cannot see an\n" +
          "evaluation-order or asset problem. If the message is a ReferenceError\n" +
          "about a name being used before initialization, run `just verify-cycles`\n" +
          "— a module cycle lets the bundler pick the order, and it picks freely.\n",
      );
      process.exit(1);
    }

    // And: does a full re-upload stay full? `restart` resets the world in place
    // and asks the terrain and the sea for a whole-buffer upload; when a tick
    // lands before the next frame renders, that frame's `sync` sees dirty
    // chunks, and adding their ranges would narrow the upload to them — every
    // other chunk would keep drawing the dead world.
    const narrowed = await page.evaluate(() => {
      const g = window.diomano;
      const buffers = (object) => {
        const out = [];
        object.traverse((o) => {
          if (o.geometry) {
            for (const [name, a] of Object.entries(o.geometry.attributes)) out.push([name, a]);
          }
        });
        return out;
      };
      g.planet.refreshAll();
      g.water.refreshAll();
      // One chunk, as a single tick would leave it.
      g.sim.meshDirty.fill(0);
      g.sim.meshDirty[0] = 1;
      g.planet.sync(g.sim.e.dio_sea_level());
      g.water.sync();
      const problems = [];
      for (const [layer, root] of [
        ["terrain", g.planet.group],
        ["water", g.water.mesh],
      ]) {
        for (const [name, a] of buffers(root)) {
          if (a.updateRanges.length > 0) {
            problems.push(`${layer} ${name}: ${a.updateRanges.length} ranges after refreshAll`);
          }
        }
      }
      g.sim.meshDirty.fill(0);
      return problems;
    });
    if (narrowed.length > 0) {
      console.error(`
FULL UPLOAD NARROWED — a refresh after a world reset uploads only the dirty chunks.

  \`refreshAll\` asks for the whole buffer; a \`sync\` before the frame that
  uploads it added per-chunk update ranges, and three then uploads only those.
`);
      for (const n of narrowed) console.error(`  ${n}`);
      process.exit(1);
    }

    // Also: does every patched material get the shader it patched? Asked of
    // both tiers, because each one puts a different set of materials together.
    // The booted page is closed first: two clients rasterising on SwiftShader
    // at once starve each other past the boot budget.
    await page.close();
    for (const tier of [1, 2]) {
      const shared = await sharedPrograms(browser, port, tier);
      if (shared.length > 0) {
        console.error(`
SHADER PROGRAMS — materials with different shaders share one program (tier ${tier}).

  three.js caches a compiled program by \`customProgramCacheKey()\`, which
  defaults to \`onBeforeCompile.toString()\`. Two materials built by the same
  function with different injected GLSL therefore have the same key, and the
  second is drawn with the first one's program — its own patch never compiles.
  Give the material a key that names what it injects.
`);
        for (const s of shared) console.error(`  ${s}`);
        process.exit(1);
      }
    }

    // A crash after the boot: a throw inside a frame must stop the loop and say
    // so, rather than escape the rAF callback and throw again every frame
    // behind a picture that has silently stopped. Injected into the render
    // half, which is the half that used to have no handler.
    const crashing = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const crashErrors = [];
    crashing.on("pageerror", (err) => crashErrors.push(err.message));
    try {
      await crashing.goto(`http://127.0.0.1:${port}/?seed=5eed`, { waitUntil: "load" });
      await crashing.waitForFunction(() => window.diomano !== undefined, null, {
        timeout: BOOT_BUDGET,
      });
      await crashing.evaluate(() => {
        window.diomano.radial.sync = () => {
          throw new Error("injected render fault");
        };
      });
      let reported = true;
      try {
        await crashing.waitForFunction(
          () => (document.querySelector("#fallback")?.textContent ?? "").includes("injected"),
          null,
          { timeout: BOOT_BUDGET },
        );
      } catch {
        reported = false;
      }
      if (!reported || crashErrors.length > 0) {
        console.error(`
RENDER FAULT — a throw inside a frame is not reported.

  The loop calls \`render\` from requestAnimationFrame. A throw there must reach
  \`halt\`, which stops the loop and writes the epitaph; otherwise it escapes the
  callback, the next frame throws again, and the page shows a frozen picture.
  epitaph shown: ${reported}; uncaught errors: ${crashErrors.length}
`);
        process.exit(1);
      }
    } finally {
      await crashing.close();
    }

    // Second question: when the boot *does* fail, does the front door say so
    // legibly? The epitaph is written into `#fallback`, which sits above the
    // title card rather than replacing it, so a real failure once shipped as a
    // grey monospace line struck through the middle of the controls table —
    // unreadable, and it read as a rendering glitch rather than as a report.
    // Asserted here because it is the one screen a broken build ever shows.
    const failing = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await failing.route("**/assets/game-*.js", (route) => route.abort());
      await failing.goto(`http://127.0.0.1:${port}/?seed=5eed`, { waitUntil: "load" });
      await failing.waitForFunction(
        () => (document.querySelector("#fallback")?.textContent ?? "").length > 0,
        null,
        { timeout: BOOT_BUDGET },
      );
      if (await failing.locator("#title").count()) {
        console.error(`
FRONT DOOR — the epitaph is printed over the title card.

  A failed boot leaves #title in the document, and #fallback draws on top of
  it (z-index 20 over 10), so the error lands across the controls table. The
  card has to go before the epitaph goes up.
`);
        process.exit(1);
      }
    } finally {
      await failing.close();
    }

    console.log(`verify-boot: OK — the built client reaches a running game with a clean
            console, every patched material compiles its own shader at both
            tiers, a full re-upload stays full, a fault inside a frame stops
            the loop and says so, and a failed boot reports itself on a
            cleared page.`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(`verify-boot: ${err instanceof Failure ? err.message : (err.stack ?? err)}`);
  process.exit(1);
});
