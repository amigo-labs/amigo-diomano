/**
 * Do the controls do what the control list says? HANDOFF §8.
 *
 * # Why a test exists for "the keys work"
 *
 * The input layer is the one part of the client that no other check can reach.
 * `cargo test` proves the simulation applies a command; `verify-cross` proves it
 * applies the same one everywhere; `verify-boot` proves the bundle starts. None
 * of them presses a key, and the input layer is exactly where this project's
 * regressions have come from: a magnet click test that compared a residue of the
 * drag accumulator and teleported the population on nearly every stroke, a
 * modifier ring that stuck after release, a wheel that zoomed out from under a
 * stroke, an intro tour that took the camera back two seconds after the player
 * started using it. Every one of those was found by playing, not by CI.
 *
 * So this drives the real client in a real browser and asserts on the
 * *simulation's* state afterwards: the hand's own target cell moved, the verb
 * event ring did or did not grow, the magnet is active, the camera is somewhere
 * else. It asserts on what the game did, never on a screenshot.
 *
 * # Every wait is on the tick counter
 *
 * Headless Chromium renders through SwiftShader at a few frames a second, and
 * the fixed-step loop drops ticks it cannot run. A `waitForTimeout` can
 * therefore elapse with the simulation not having advanced at all, which reads
 * as "the key did nothing" for a control that works perfectly. So `ticks(n)`
 * waits for `dio_tick_count` to advance and every hold is measured in ticks.
 * For the same reason a reading that must be simultaneous with an event — the
 * hand's amount at the instant of a blur — is taken inside the same
 * `page.evaluate` as the event, not in the round trip after it.
 *
 * Usage:  node tools/verify-input.mjs
 * Exits 0 when every control behaves, 1 otherwise. Slow (minutes) on a software
 * renderer, so it is a recipe of its own rather than part of `just check`.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(WEB_ROOT, "dist");

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

async function main() {
  if (!existsSync(join(DIST, "index.html"))) fail("no build; run `just build-web` first");

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
    args: ["--enable-unsafe-swiftshader"],
    ...chromiumLaunchOptions(),
  });

  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));

    // tier=1 for the cheapest renderer, ai=0 so the opponent is not writing
    // verb events into the ring this tool counts.
    await page.goto(`http://127.0.0.1:${port}/?seed=5eed&tier=1&ai=0`, { waitUntil: "load" });
    await page.waitForFunction(() => window.diomano !== undefined, null, { timeout: 90_000 });
    await page.waitForFunction(
      () => document.querySelector("#title-hint")?.textContent?.includes("beginnen"),
      null,
      { timeout: 90_000 },
    );

    const CENTRE = { x: 400, y: 330 };
    await page.mouse.click(CENTRE.x, CENTRE.y);

    const read = (fn, arg) => page.evaluate(fn, arg);
    const tick = () => read(() => window.diomano.sim.e.dio_tick_count());
    /** Wait until the simulation has advanced `n` ticks. */
    const ticks = async (n) => {
      const from = await tick();
      await page.waitForFunction((t) => window.diomano.sim.e.dio_tick_count() >= t, from + n, {
        timeout: 90000,
      });
    };
    /** Hold a key across `n` ticks of simulation. */
    const hold = async (key, n) => {
      await page.keyboard.down(key);
      await ticks(n);
      await page.keyboard.up(key);
      await ticks(1);
    };

    const results = [];
    const check = (name, ok, detail) => results.push({ name, ok, detail });

    const state = () =>
      read(() => {
        const s = window.diomano.sim;
        return {
          hand: s.e.dio_hand_amount(0),
          material: s.e.dio_hand_material(0),
          events: s.e.dio_verb_events_written() >>> 0,
          magnet: s.e.dio_magnet_active(0),
          tick: s.e.dio_tick_count(),
        };
      });
    const cam = () =>
      read(() => {
        const c = window.diomano.camera.camera;
        return { x: c.position.x, y: c.position.y, z: c.position.z, d: c.position.length() };
      });
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    /** Height of the cell the hand is on, which is what a sculpt must move. */
    const targetHeight = () =>
      read(() => {
        const g = window.diomano;
        const t = g.hand.target();
        if (!t) return null;
        return {
          cell: `${t.face}:${t.x},${t.y}`,
          height: g.sim.height[g.sim.idx(t.face, t.x, t.y)],
        };
      });

    await ticks(4);
    await page.mouse.move(CENTRE.x, CENTRE.y);
    await ticks(2);

    // The refusal is the diegetic "no": a sound and a red palm. Counting the
    // audio call is the only way to see it from out here, and it is the call
    // `hand.flash()` travels with in `game.ts`.
    await page.evaluate(() => {
      const audio = window.diomano.audio;
      const original = audio.refusal.bind(audio);
      window.__refusals = 0;
      audio.refusal = () => {
        window.__refusals += 1;
        original();
      };
    });
    const refusals = () => read(() => window.__refusals);

    // --- 1. F digs, and it digs the cell under the hand ---------------------
    const t0 = await targetHeight();
    await hold("f", 6);
    const s1 = await state();
    const t1 = await targetHeight();
    check("F digs and fills the hand", s1.hand > 0, `hand carries ${s1.hand}`);
    check(
      "the dug cell is the one under the hand",
      t0 && t1 && t0.cell === t1.cell && t1.height < t0.height,
      `${t0?.cell} height ${t0?.height} -> ${t1?.height}`,
    );

    // --- 2. one tap is one terrace, and a working raise is not refused -----
    const before = await targetHeight();
    const refusedBefore = await refusals();
    await page.keyboard.press("r");
    await ticks(6);
    const afterTap = await targetHeight();
    check(
      "R tapped once raises the cell",
      before && afterTap && afterTap.height > before.height,
      `height ${before?.height} -> ${afterTap?.height}`,
    );
    const refusedAfter = await refusals();
    check(
      "a raise that works is not refused",
      refusedAfter === refusedBefore,
      `${refusedAfter - refusedBefore} refusals for an applied raise`,
    );

    // --- 3. holding raises further than a tap ------------------------------
    const beforeHold = afterTap;
    await hold("r", 8);
    const afterHold = await targetHeight();
    check(
      "R held raises further than a tap",
      afterHold &&
        beforeHold &&
        afterHold.height - beforeHold.height > afterTap.height - before.height,
      `+${afterHold.height - beforeHold.height} held vs +${afterTap.height - before.height} tapped`,
    );

    // --- 4. an empty hand raise fires no verb event ------------------------
    let guard = 0;
    while ((await state()).hand > 0 && guard++ < 25) await hold("r", 4);
    const emptied = await state();
    const eventsBefore = emptied.events;
    const refusedEmpty = await refusals();
    await hold("r", 8);
    const after = await state();
    check(
      "a raise with an empty hand fires no verb event",
      emptied.hand === 0 && after.events === eventsBefore,
      `hand ${emptied.hand}, events ${eventsBefore} -> ${after.events}`,
    );
    // And the player is told — once per keypress, not once every other tick: a
    // held key that cannot dig would otherwise strobe the palm.
    await ticks(6);
    const refusedNow = (await refusals()) - refusedEmpty;
    check(
      "a raise with an empty hand is refused, once",
      refusedNow === 1,
      `${refusedNow} refusals for one held keypress`,
    );

    // --- 5. material keys, and the ring shows the choice -------------------
    await page.keyboard.press("2");
    await ticks(3);
    const water = await state();
    const ringColour = await read(() => {
      const g = window.diomano;
      let found = null;
      g.scene.traverse((o) => {
        if (o.geometry?.type === "RingGeometry") found = o.material.color.getHex();
      });
      return found;
    });
    check("2 switches the hand to water", water.material === 1, `material ${water.material}`);
    check(
      "the footprint ring shows the material",
      ringColour === 0x4fa8d8,
      `ring #${ringColour?.toString(16)}`,
    );
    await page.keyboard.press("1");
    await ticks(2);

    // --- 6. keyboard camera -------------------------------------------------
    const camBefore = await cam();
    await hold("d", 8);
    const camAfter = await cam();
    check(
      "D orbits the planet",
      dist(camBefore, camAfter) > 0.05,
      `moved ${dist(camBefore, camAfter).toFixed(3)} radii`,
    );
    const zoomBefore = (await cam()).d;
    await hold("q", 8);
    const zoomAfter = (await cam()).d;
    check(
      "Q zooms in",
      zoomAfter < zoomBefore - 0.01,
      `distance ${zoomBefore.toFixed(3)} -> ${zoomAfter.toFixed(3)}`,
    );

    // --- 7. space toggles the menu -----------------------------------------
    await page.mouse.move(CENTRE.x, CENTRE.y);
    await ticks(2);
    await page.keyboard.press("Space");
    await page.waitForTimeout(400);
    const opened = await read(() => window.diomano.radial.open);
    await page.keyboard.press("Space");
    await page.waitForTimeout(400);
    const closed = await read(() => window.diomano.radial.open);
    check("Space toggles the power menu", opened && !closed, `open ${opened}, then ${closed}`);

    // --- 8. right click on a slice closes ----------------------------------
    await page.keyboard.press("Space");
    await page.waitForTimeout(400);
    const slice = await page.$(".radial-slice");
    if (slice) {
      const box = await slice.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
      await page.waitForTimeout(400);
      check(
        "a right click on a slice closes the menu",
        !(await read(() => window.diomano.radial.open)),
        "",
      );
    } else {
      check("a right click on a slice closes the menu", false, "no slice rendered");
    }

    // --- 9. B cycles the brush, and the ring grows with it -----------------
    const ringScale = () =>
      read(() => {
        const g = window.diomano;
        let s = null;
        g.scene.traverse((o) => {
          if (o.geometry?.type === "RingGeometry") s = o.scale.x;
        });
        return s;
      });
    await page.mouse.move(CENTRE.x, CENTRE.y);
    await ticks(2);
    const r0 = await ringScale();
    await page.keyboard.press("b");
    await ticks(2);
    const r1 = await ringScale();
    await page.keyboard.press("b");
    await ticks(2);
    const r2 = await ringScale();
    await page.keyboard.press("b");
    await ticks(2);
    const r3 = await ringScale();
    check(
      "B cycles the brush and the ring follows",
      r1 > r0 && r2 > r1 && Math.abs(r3 - r0) < 1e-6,
      `ring ${r0?.toFixed(3)} -> ${r1?.toFixed(3)} -> ${r2?.toFixed(3)} -> ${r3?.toFixed(3)}`,
    );

    // --- 10. left click places the magnet ----------------------------------
    await page.mouse.click(CENTRE.x + 30, CENTRE.y - 20);
    await ticks(3);
    const magnet = await state();
    check("a left click places the magnet", magnet.magnet === 1, `active ${magnet.magnet}`);

    // --- 11. blur releases held keys ---------------------------------------
    await page.keyboard.down("f");
    await ticks(3);
    // The blur and the reading in one round trip: at three frames a second, two
    // separate `evaluate` calls are a tick or two apart, and the digging that
    // legitimately happens in between would look like digging after the blur.
    const atBlur = await read(() => {
      dispatchEvent(new Event("blur"));
      return window.diomano.sim.e.dio_hand_amount(0);
    });
    await ticks(6);
    const afterBlur = (await state()).hand;
    await page.keyboard.up("f");
    check(
      "blur releases held keys",
      afterBlur === atBlur,
      `hand ${atBlur} -> ${afterBlur} across the blur`,
    );

    // --- 12. the intro tour does not take the camera back ------------------
    const idleBefore = await cam();
    await ticks(30);
    const idleAfter = await cam();
    check(
      "no intro tour claims the camera after input",
      dist(idleBefore, idleAfter) < 0.2,
      `camera drifted ${dist(idleBefore, idleAfter).toFixed(3)} radii while idle`,
    );

    let failed = 0;
    for (const r of results) {
      if (!r.ok) failed++;
      console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
    if (errors.length > 0) fail(`console errors:\n  ${errors.join("\n  ")}`);
    if (failed > 0) fail(`${failed} of ${results.length} controls misbehaved`);
    console.log(`verify-input: OK — ${results.length} controls behave as the control list says.`);
  } finally {
    await browser.close();
    server.close();
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof Failure) {
    console.error(`verify-input: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
