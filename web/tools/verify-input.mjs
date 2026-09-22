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
 * # Every wait is on observed state, never on the wall clock
 *
 * Headless Chromium renders through SwiftShader at a few frames a second, and
 * the fixed-step loop drops ticks it cannot run. A `waitForTimeout` can
 * therefore elapse with the simulation not having advanced at all, which reads
 * as "the key did nothing" for a control that works perfectly.
 *
 * So there are two waits and no sleeps. `ticks(n)` waits for `dio_tick_count`
 * to advance, and every hold is measured in ticks — that is the right
 * instrument for anything the simulation does. `becomes` waits for a value the
 * *client* owns to reach what is expected, which is the right one for the
 * radial menu: the menu is not simulation state, it opens on the keypress
 * itself, so a tick wait would be waiting for the wrong thing and a fixed
 * sleep would be a race on a slow runner. It reports a timeout as a failed
 * check rather than throwing, so one stuck control does not cost the report on
 * the other sixteen.
 *
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
    /**
     * Wait for a value the client owns to reach `expected`.
     *
     * Returns whether it got there inside the budget, so a control that never
     * responds is one failed line in the report rather than a thrown error
     * that loses every check after it.
     */
    const becomes = async (fn, expected, budgetMs = 15_000) => {
      try {
        await page.waitForFunction(fn, expected, { timeout: budgetMs, polling: 50 });
        return true;
      } catch {
        return false;
      }
    };
    /**
     * Leave the radial menu closed, whatever state it is in.
     *
     * The menu suppresses the hand while it is open, so a backdrop left
     * standing makes every later check fail for a reason that has nothing to
     * do with the control it names. Escape first, then a click on the backdrop
     * as the fallback; the return value says whether it worked.
     */
    const ensureMenuClosed = async () => {
      if (!(await read(() => window.diomano.radial.open))) return true;
      await page.keyboard.press("Escape");
      if (await becomes((want) => window.diomano.radial.open === want, false)) return true;
      await page.mouse.click(8, 8);
      return becomes((want) => window.diomano.radial.open === want, false);
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

    const ringColour = () =>
      read(() => {
        const g = window.diomano;
        let found = null;
        g.scene.traverse((o) => {
          if (o.geometry?.type === "RingGeometry") found = o.material.color.getHex();
        });
        return found;
      });
    /** A cell whose whole 5x5 neighbourhood is deep sea, or dry high ground. */
    const findCell = (wet) =>
      read((wantWet) => {
        const s = window.diomano.sim;
        const sea = s.e.dio_sea_level();
        const ok = (f, x, y) => {
          const c = s.idx(f, x, y);
          return wantWet
            ? s.water[c] >= 200
            : s.water[c] === 0 && s.lava[c] === 0 && s.height[c] > sea + 48;
        };
        for (let f = 0; f < 6; f++) {
          for (let y = 4; y < s.N - 4; y += 2) {
            for (let x = 4; x < s.N - 4; x += 2) {
              let all = true;
              for (let dy = -2; dy <= 2 && all; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                  if (!ok(f, x + dx, y + dy)) {
                    all = false;
                    break;
                  }
                }
              }
              if (all) return { face: f, x, y };
            }
          }
        }
        return null;
      }, wet);
    /**
     * Point the hand at a cell. Returns the cell the hand actually picked, so a
     * check can insist it landed where it was sent.
     *
     * The camera tilts toward the horizon, so the cell `aimAtCell` centres on
     * is below the middle of the viewport, by an amount that depends on the
     * zoom. Rather than guess the screen point, ask the client where the cell
     * is once the camera has moved and put the pointer there.
     */
    const aimAt = async (cell) => {
      // A middle click first: any press ends the opening tour, and while the
      // tour is running it owns the camera and would override the aim on the
      // next frame. Middle has no verb of its own, so nothing else happens.
      await page.mouse.click(CENTRE.x, CENTRE.y, { button: "middle" });
      await read((c) => window.diomano.aimAtCell(c.face, c.x, c.y), cell);
      await ticks(3);
      const at = await read((c) => window.diomano.cellScreen(c.face, c.x, c.y), cell);
      await page.mouse.move(at.x, at.y);
      await ticks(2);
      // A second, one-pixel move: the hand re-picks every frame anyway, but a
      // pointer that never moved after the camera settled has been seen to
      // report the previous frame's cell on a slow renderer.
      await page.mouse.move(at.x + 1, at.y);
      await ticks(2);
      return read(() => window.diomano.hand.target());
    };
    /** Whether the hand landed inside the 5x5 `findCell` vouched for. */
    const near = (target, cell) =>
      target !== null &&
      cell !== null &&
      target.face === cell.face &&
      Math.abs(target.x - cell.x) <= 2 &&
      Math.abs(target.y - cell.y) <= 2;
    const show = (t) => (t ? `${t.face}:${t.x},${t.y}` : "none");
    const underHand = () =>
      read(() => {
        const g = window.diomano;
        const t = g.hand.target();
        return t ? g.sim.e.dio_material_under(t.face, t.x, t.y) : null;
      });

    await ticks(4);
    // Start on dry ground. The empty hand takes what is under it, and at this
    // seed the centre of the opening view is open sea — where `F` would come up
    // with water and the earth checks below would have nothing to measure. The
    // sea gets its own checks once the hand has proven itself on land.
    const landCell = await findCell(false);
    const seaCell = await findCell(true);
    let landed = null;
    if (landCell) landed = await aimAt(landCell);
    else await page.mouse.move(CENTRE.x, CENTRE.y);
    await ticks(2);
    check(
      "the hand starts over dry ground",
      near(landed, landCell) && (await underHand()) === 0,
      `sent to ${show(landCell)}, hand on ${show(landed)}, under hand ${await underHand()}`,
    );

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

    // --- 5. the empty hand takes what is under it ---------------------------
    //
    // There is no material key: lowered over the sea the hand comes up with
    // water, and the ring says so before the key goes down. The map decides
    // where the sea is, so the cell is found in the simulation and the camera
    // is pointed at it through the console handle.
    if (seaCell && landCell) {
      const onSea = await aimAt(seaCell);
      const previewOverSea = await ringColour();
      const underSea = await underHand();
      await hold("f", 6);
      const water = await state();
      check(
        "F over the sea fills the hand with water",
        near(onSea, seaCell) && underSea === 1 && water.material === 1 && water.hand > 0,
        `sent to ${show(seaCell)}, hand on ${show(onSea)}, under hand ${underSea}, ` +
          `material ${water.material}, hand ${water.hand}`,
      );
      check(
        "the footprint ring previews water before the key",
        previewOverSea === 0x4fa8d8,
        `ring #${previewOverSea?.toString(16)}`,
      );

      // A hand holding water keeps holding water: over dry ground `F` moves
      // nothing, and says so exactly once.
      const onLand = await aimAt(landCell);
      const underLand = await underHand();
      const refusedBeforeDry = await refusals();
      await hold("f", 8);
      await ticks(6);
      const dry = await state();
      check(
        "water in the hand over dry ground is refused, once",
        near(onLand, landCell) &&
          underLand === 0 &&
          dry.material === 1 &&
          dry.hand === water.hand &&
          (await refusals()) - refusedBeforeDry === 1,
        `hand on ${show(onLand)}, under hand ${underLand}, material ${dry.material}, ` +
          `hand ${water.hand} -> ${dry.hand}, ` +
          `${(await refusals()) - refusedBeforeDry} refusals`,
      );

      // Pour it back into the sea, which absorbs it (§4.3: the sea is a
      // boundary condition), so the ground stays dry for what follows.
      await aimAt(seaCell);
      guard = 0;
      while ((await state()).hand > 0 && guard++ < 40) await hold("r", 4);
      const emptiedAgain = await state();

      // Held `F` on ground until the hand is full: the stall is one "no", not a
      // strobe — and the ground stops moving with a reason on screen.
      await aimAt(landCell);
      const refusedBeforeFull = await refusals();
      const capacity = await read(() => window.diomano.sim.e.dio_hand_capacity());
      await page.keyboard.down("f");
      guard = 0;
      while ((await state()).hand < capacity && guard++ < 60) await ticks(4);
      await ticks(12);
      await page.keyboard.up("f");
      await ticks(1);
      const full = await state();
      check(
        "a hand that fills up mid-hold is refused, once",
        emptiedAgain.hand === 0 &&
          full.hand === capacity &&
          full.material === 0 &&
          (await refusals()) - refusedBeforeFull === 1,
        `hand ${emptiedAgain.hand} -> ${full.hand} of ${capacity}, material ${full.material}, ` +
          `${(await refusals()) - refusedBeforeFull} refusals`,
      );
      // And empty it again on the same ground, so the checks below start from
      // a hand that can still dig.
      guard = 0;
      while ((await state()).hand > 0 && guard++ < 60) await hold("r", 4);
    } else {
      check(
        "F over the sea fills the hand with water",
        false,
        `no cell found: sea ${JSON.stringify(seaCell)}, land ${JSON.stringify(landCell)}`,
      );
    }
    await page.mouse.move(CENTRE.x, CENTRE.y);
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
    const opened = await becomes((want) => window.diomano.radial.open === want, true);
    await page.keyboard.press("Space");
    const closed = await becomes((want) => window.diomano.radial.open === want, false);
    check(
      "Space toggles the power menu",
      opened && closed,
      opened
        ? closed
          ? ""
          : "a second press did not close it"
        : "the first press did not open it",
    );

    // --- 8. right click on a slice closes ----------------------------------
    await page.keyboard.press("Space");
    // Wait on the slices being in the document, not on Playwright's notion of
    // an element being *visible*: `waitForSelector` defaults to visibility, and
    // a slice that is present and painted can still fail that check while the
    // backdrop is fading, which reads as "the menu has no slices".
    const sliceCount = () => read(() => document.querySelectorAll(".radial-slice").length);
    const menuUp = await becomes(
      (want) => document.querySelectorAll(".radial-slice").length > want,
      0,
    );
    const slice = menuUp ? await page.$(".radial-slice") : null;
    if (slice) {
      const box = await slice.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
      const dismissed = await becomes((want) => window.diomano.radial.open === want, false);
      check(
        "a right click on a slice closes the menu",
        dismissed,
        dismissed ? "" : "the menu stayed open",
      );
    } else {
      check(
        "a right click on a slice closes the menu",
        false,
        `menu open: ${await read(() => window.diomano.radial.open)}, slices: ${await sliceCount()}`,
      );
    }
    // Whatever happened above, the menu must not be left standing: it suppresses
    // the hand, so an open backdrop silently fails every check after it — which
    // is how one stuck control once cost three lines of this report.
    await ensureMenuClosed();

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

    // --- 13. the wheel zooms toward the pointer, past the pole too ---------
    //
    // Screen-right is the camera's own `east` at every pitch, so zooming in with
    // the pointer right of centre must carry the eye that way — and past the
    // pole, where `cos(pitch)` turns negative, yaw moves the eye the other way
    // round, which is what `yawSign` is for.
    const cameraRight = () =>
      read(() => {
        const c = window.diomano.camera.camera;
        const m = c.matrixWorld.elements;
        return { right: [m[0], m[1], m[2]], p0: [c.position.x, c.position.y, c.position.z] };
      });
    const wheelToward = async () => {
      // Out first, from the centre — no sideways component — so the zoom in
      // below cannot start at the near limit and move nothing.
      await page.mouse.move(CENTRE.x, CENTRE.y);
      for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 300);
      await ticks(10);
      await page.mouse.move(CENTRE.x + 300, CENTRE.y);
      await ticks(1);
      const before = await cameraRight();
      await page.mouse.wheel(0, -200);
      await ticks(8);
      const after = await cam();
      const d = [after.x - before.p0[0], after.y - before.p0[1], after.z - before.p0[2]];
      return d[0] * before.right[0] + d[1] * before.right[1] + d[2] * before.right[2];
    };
    const upY = () => read(() => window.diomano.camera.camera.up.y);
    // `aimAt` may have left the camera on either spherical branch, so measure
    // on whichever side it is and then carry it over the pole to the other.
    const startUp = await upY();
    const sidewaysHere = await wheelToward();
    const side = Math.sign(startUp) || 1;
    await page.keyboard.down("w");
    guard = 0;
    while ((await upY()) * side > -0.3 && guard++ < 60) await ticks(2);
    await page.keyboard.up("w");
    await ticks(10);
    const endUp = await upY();
    const crossed = endUp * side < 0;
    const sidewaysThere = await wheelToward();
    check(
      "the wheel zooms toward the pointer, over the pole too",
      sidewaysHere > 0 && crossed && sidewaysThere > 0,
      `up.y ${startUp.toFixed(2)}: eye moved ${sidewaysHere.toFixed(4)} toward the pointer; ` +
        `up.y ${endUp.toFixed(2)}: ${sidewaysThere.toFixed(4)}${crossed ? "" : " (never crossed the pole)"}`,
    );
    // Back over the top, so the checks below see the planet as they did.
    await page.keyboard.down("s");
    guard = 0;
    while ((await upY()) * side < 0.3 && guard++ < 60) await ticks(2);
    await page.keyboard.up("s");
    await ticks(4);

    // --- 14. an orbit whose release was never seen does not carry on -------
    //
    // The right button can come up where the page cannot see it — focus taken
    // mid-drag, capture lost to the OS. The next move then arrives with no
    // orbit button held, and the orbit must end there rather than follow the
    // bare pointer until the next right click.
    await page.mouse.move(CENTRE.x, CENTRE.y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(CENTRE.x + 40, CENTRE.y, { steps: 4 });
    const orbiting = await read(() => window.diomano.camera.panning);
    const released = await read(
      (at) => {
        const canvas = document.querySelector("canvas");
        canvas.dispatchEvent(
          new PointerEvent("pointermove", {
            clientX: at.x,
            clientY: at.y,
            pointerId: 1,
            pointerType: "mouse",
            buttons: 0,
            bubbles: true,
          }),
        );
        return !window.diomano.camera.panning;
      },
      { x: CENTRE.x + 60, y: CENTRE.y },
    );
    await page.mouse.up({ button: "right" });
    await ensureMenuClosed();
    check(
      "a move with no orbit button held ends the orbit",
      orbiting && released,
      orbiting ? (released ? "" : "the camera kept orbiting") : "the right drag never orbited",
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
