/**
 * Development screenshots of the built client in headless Chromium.
 *
 * Not a CI gate: a visual smoke test for the shell UI, the intro pan and the
 * end card, which no unit test can see. Serves `web/dist` (build first) plus
 * `public/`, drives the page with Playwright, and drops PNGs into the
 * directory given as argv[2] (default: `web/screenshots`).
 *
 * Usage:  node tools/screenshot.mjs [outDir]
 */

import { existsSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT_DIR = resolve(process.argv[2] ?? join(WEB_ROOT, "screenshots"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * Thrown rather than `process.exit`. Most `fail` calls sit inside `main`'s
 * `try`, whose `finally` closes the browser and the server, and `process.exit`
 * would skip that `finally`; the two before it (no build, no wasm) have nothing
 * to clean up yet. Either way the `.catch` at the bottom is where the exit
 * happens.
 */
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

/** Serve `dist/` as the root, with `public/` as a fallback for the wasm. */
function serve() {
  return new Promise((ok) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // Pathname is always absolute. join() treats a segment starting with /
      // as a new root, so "/main.js" would skip WEB_ROOT/dist entirely.
      // Malformed percent-encoding throws; a bad request must not take the
      // server down mid-screenshot.
      let rel;
      try {
        rel = normalize(decodeURIComponent(url.pathname)).replaceAll("\\", "/");
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      rel = rel.replace(/^\/+/, "");
      if (rel === "" || rel === ".") rel = "index.html";
      for (const root of [join(WEB_ROOT, "dist"), join(WEB_ROOT, "public")]) {
        // Inside *this* root, not merely inside web/: a `..` in the path must
        // not reach a sibling directory.
        const file = join(root, rel);
        if (file !== root && !file.startsWith(root + sep)) continue;
        try {
          if (!statSync(file).isFile()) continue;
          const body = await readFile(file);
          res.writeHead(200, {
            "content-type": MIME[extname(file)] ?? "application/octet-stream",
            "cache-control": "no-store",
          });
          res.end(body);
          return;
        } catch {
          // Try the next candidate.
        }
      }
      res.writeHead(404).end("not found");
    });
    server.listen(0, "127.0.0.1", () => ok(server));
  });
}

async function main() {
  if (!existsSync(join(WEB_ROOT, "dist/index.html"))) fail("no build; run `bun run build` first");
  await mkdir(OUT_DIR, { recursive: true });

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
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // Recorded, not thrown: an exception inside an event listener never reaches
    // this `try`. Checked before every screenshot and once at the end.
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    const checkPage = () => {
      if (pageErrors.length > 0) fail(`page error: ${pageErrors.join("; ")}`);
    };
    const shoot = async (name) => {
      checkPage();
      await page.screenshot({ path: join(OUT_DIR, `${name}.png`) });
      console.log(`  ${name}.png`);
    };

    await page.goto(`http://127.0.0.1:${port}/?seed=5eed`, { waitUntil: "load" });
    // Let the planet render behind the title card.
    await page.waitForTimeout(2500);
    await shoot("1-title");

    // Click through: audio unlock + match start + intro pan onto the enemy.
    await page.mouse.click(640, 400);
    await page.waitForTimeout(1200);
    await shoot("2-intro-enemy");

    // Mid-pan back home.
    await page.waitForTimeout(3500);
    await shoot("3-intro-pan");

    // Settled gameplay view.
    await page.waitForTimeout(4000);
    await shoot("4-gameplay");

    // The controls overlay: off by default, one key away, and off again. It is
    // asserted rather than only photographed — a card that never appeared makes
    // exactly as plausible a PNG as one that did.
    if (await page.locator(".hud-controls.shown").count()) {
      fail("the controls overlay is up before anyone asked for it");
    }
    await page.keyboard.press("F1");
    await page.waitForTimeout(400);
    if (!(await page.locator(".hud-controls.shown").count())) {
      fail("F1 did not open the controls overlay");
    }
    await shoot("4a-controls");
    await page.keyboard.press("F1");
    await page.waitForTimeout(400);
    if (await page.locator(".hud-controls.shown").count()) {
      fail("F1 did not close the controls overlay again");
    }

    // Close working view: zoom to the floor. The clouds must dissolve on the
    // way in (view.ts, cloudFade) so the terrain under the hand is readable.
    await page.mouse.move(640, 400);
    for (let i = 0; i < 14; i++) {
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(1200);
    await shoot("4b-close");

    // The power menu, opened at close range over lit ground — precisely the
    // case the legibility report was about, and the one no unit test can see.
    // Asserted open first: a screenshot of a menu that never appeared is a
    // screenshot of nothing, and it would pass review as easily as a good one.
    await page.mouse.click(640, 400, { button: "right" });
    await page.waitForTimeout(400);
    if (!(await page.evaluate(() => window.diomano.radial.open))) {
      fail("right-click did not open the power menu");
    }
    await shoot("4c-menu");

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // The wave landing, which is the one moment the sea is supposed to look
    // like weather rather than like a level. Ticked forward from the console
    // rather than waited out: the first wave is minutes away.
    //
    // With the opponent off, deliberately. The scripted AI can win by siege
    // against a player who never acts well before the first wave lands at the
    // shipped cadence, and a world that has ended freezes — so on the normal
    // page this loop would tick a frozen world forever and see no wave.
    const phase = await page.evaluate(() => {
      const sim = window.diomano.sim;
      for (let i = 0; i < 60000 && sim.e.dio_tide_phase() !== 2; i++) sim.tick();
      return sim.e.dio_tide_phase();
    });
    if (phase !== 2 && !(await page.evaluate(() => window.diomano.sim.e.dio_outcome() !== 0))) {
      fail("the tide never reached impact");
    }
    if (phase === 2) {
      await page.waitForTimeout(700);
      await shoot("4d-surge");
    }

    for (let i = 0; i < 14; i++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(800);

    // Force the match to its end quickly: tick the sim hard from the console.
    // (The dev handle exists exactly for this kind of interrogation.)
    const { outcome, decidedAt } = await page.evaluate(() => {
      const sim = window.diomano.sim;
      for (let i = 0; i < 12000 && sim.e.dio_outcome() === 0; i++) sim.tick();
      return { outcome: sim.e.dio_outcome(), decidedAt: sim.e.dio_tick_count() };
    });
    if (outcome === 0) fail("12,000 forced ticks and no outcome — the match never ends");
    // Minimum match length: telegraph (300) + half impact (75) after the first
    // calm (900) is the first wave peak at tick 1,275. An outcome before that
    // means somebody's spawn dissolved with no war fought — the instant-defeat
    // regression this line exists to catch.
    if (decidedAt < 1275) {
      fail(`match decided at tick ${decidedAt}, before the first wave peak (1,275)`);
    }
    console.log(`  forced outcome: ${outcome} at tick ${decidedAt}`);
    // One rendered frame notices the outcome; the card follows 2.5 s later.
    await page.waitForTimeout(3500);
    await shoot("5-game-over");

    // Restart via the first button and confirm a live world comes back.
    await page.click("button[data-restart='same']");
    await page.waitForTimeout(1500);
    await shoot("6-restarted");
    const running = await page.evaluate(() => {
      const sim = window.diomano.sim;
      const before = sim.e.dio_tick_count();
      return new Promise((ok) => {
        setTimeout(() => ok(sim.e.dio_tick_count() > before && sim.e.dio_outcome() === 0), 700);
      });
    });
    if (!running) fail("restart did not produce a running match");
    console.log("  restart: running match confirmed");

    // The failure path, on its own page: starve the loader of its wasm and the
    // epitaph in `#fallback` must appear *without* an unhandled rejection.
    //
    // Worth a step of its own because this file is the thing that catches it —
    // `page.on("pageerror")` above fails the run on one — and because the
    // rejection was real: `boot()` used to rethrow after showing the fallback,
    // which is noise in a player's console and a failed run here, for an error
    // that had already been reported on screen.
    const failPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const rejections = [];
    failPage.on("pageerror", (err) => rejections.push(err.message));
    await failPage.route("**/diomano.wasm", (r) => r.abort());
    await failPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
    await failPage.waitForTimeout(2500);
    const epitaph = await failPage.evaluate(() => {
      const el = document.querySelector("#fallback");
      return { shown: getComputedStyle(el).display !== "none", text: el.textContent ?? "" };
    });
    if (!epitaph.shown || !epitaph.text.includes("could not start")) {
      fail(`a boot failure did not show the epitaph: ${JSON.stringify(epitaph)}`);
    }
    if (rejections.length > 0) {
      fail(`a boot failure left an unhandled rejection: ${rejections.join(", ")}`);
    }
    await failPage.close();
    console.log("  failed boot: epitaph shown, no unhandled rejection");
    checkPage();
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`screenshot: OK — PNGs in ${OUT_DIR}`);
}

main().catch((err) => {
  const text =
    err instanceof Failure ? err.message : err instanceof Error ? (err.stack ?? err.message) : err;
  console.error(`screenshot: ${text}`);
  process.exit(1);
});
