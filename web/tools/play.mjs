/**
 * A scripted play-through of the built client, start to end card.
 *
 * # What this is for
 *
 * `verify-input` proves the controls do what the control list says, one at a
 * time. Nothing proves that a *match* reads right from beginning to end: that
 * the title card's level buttons choose without starting, that the first hint
 * asks for the thing the player then does, that the wave announces itself and
 * its peak is read out with a score, and that the end card numbers the waves
 * it shows. Those are moments a few minutes apart, so this ticks the
 * simulation forward from the console between them — the dev handle exists
 * for exactly this — and photographs each one.
 *
 * Like `verify-input`, every assertion is on observed state (the simulation,
 * or the DOM the HUD wrote), never on a wall-clock wait alone. Screenshots go
 * to `web/screenshots/` (gitignored), or to the directory given as argv[2].
 *
 * Usage:  node tools/play.mjs [outDir]
 * Exits 0 when the match played through, 1 otherwise. Not part of `just check`:
 * a whole match is minutes of simulation on a software renderer.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(WEB_ROOT, "dist");
const OUT_DIR = resolve(process.argv[2] ?? join(WEB_ROOT, "screenshots"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
};

/** Mirrors `VERB` in `src/verbs.ts`. */
const VERB = { RAISE: 1, LOWER: 2 };
/**
 * Powers the opponent may be made to cast for the pip check, as [verb, power]
 * pairs (`VERB` / `POWER` in `src/verbs.ts`), cheapest first.
 */
const POWERS = [
  [5, 3], // swamp
  [4, 2], // earthquake
  [6, 4], // volcano
];
/** Mirrors `TIDE` in `src/main.ts`. */
const TIDE = { TELEGRAPH: 1 };

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

/** Serve `dist/` and nothing else — see `verify-input.mjs` for why. */
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
    // A software renderer on a shared runner can take many seconds over one
    // frame; Playwright's 30-second default made clicks and screenshots fail
    // for no reason the game had any part in.
    page.setDefaultTimeout(120_000);
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));

    const results = [];
    const check = (name, ok, detail) => {
      results.push({ name, ok, detail });
      console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    };
    const read = (fn, arg) => page.evaluate(fn, arg);
    const shoot = async (name) => {
      await page.screenshot({ path: join(OUT_DIR, `${name}.png`) });
      console.log(`  -> ${name}.png`);
    };
    const tick = () => read(() => window.diomano.sim.e.dio_tick_count());
    /** Wait until the simulation has advanced `n` ticks on its own loop. */
    const ticks = async (n) => {
      const from = await tick();
      await page.waitForFunction((t) => window.diomano.sim.e.dio_tick_count() >= t, from + n, {
        timeout: 90_000,
      });
    };
    /** Wait for a condition the client owns; false on timeout rather than a throw. */
    const becomes = async (fn, arg, budgetMs = 20_000) => {
      try {
        await page.waitForFunction(fn, arg, { timeout: budgetMs, polling: 50 });
        return true;
      } catch {
        return false;
      }
    };
    /**
     * Photograph the banner that was just asserted.
     *
     * A banner lives 2.4 to 4.2 seconds of wall clock. On a software renderer
     * under load one capture has been measured at fifteen, and the frame it
     * waits for is the very one whose HUD pass takes the expired banner down —
     * so the check passes and the picture shows no banner. The dev handle puts
     * the last banner back and holds it for the capture, then lets it go; the
     * opacity wait covers the half-second fade-in on top.
     */
    const shootBanner = async (name) => {
      await read(() => window.diomano.hud.holdBanner(120_000));
      await becomes(() => {
        const el = document.querySelector(".hud-banner.shown");
        return el !== null && getComputedStyle(el).opacity === "1";
      }, null);
      await shoot(name);
      await read(() => window.diomano.hud.holdBanner(0));
    };
    /**
     * Tick the simulation from the console until `until` holds — the first
     * wave's `telegraph`, a wave `scored`, or an `outcome` — or `limit` ticks
     * pass. Chunked, so the page renders frames in between and a long run does
     * not starve the HUD of the frames it reads the edges on.
     */
    const tickUntil = async (until, limit) => {
      let done = 0;
      while (done < limit) {
        const r = await read(
          ({ until, chunk, telegraph }) => {
            const sim = window.diomano.sim;
            const met = () =>
              until === "telegraph"
                ? sim.e.dio_tide_phase() === telegraph
                : until === "scored"
                  ? sim.e.dio_tide_scored() === 1
                  : sim.e.dio_outcome() !== 0;
            let n = 0;
            while (n < chunk && !met()) {
              sim.tick();
              n++;
            }
            return { n, met: met() };
          },
          { until, chunk: 1500, telegraph: TIDE.TELEGRAPH },
        );
        done += r.n;
        if (r.met) return true;
        // One rendered frame between chunks.
        await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => ok())));
      }
      return false;
    };

    // The opponent on, at the level the card will choose; tier 1 for the
    // cheapest renderer. No `level=` in the URL — the card has to set it.
    await page.goto(`http://127.0.0.1:${port}/?seed=5eed&tier=1`, { waitUntil: "load" });
    await page.evaluate(() => {
      try {
        localStorage.removeItem("diomano.level");
      } catch {
        // A page that cannot store still plays; the check below says so.
      }
    });
    await page.waitForFunction(() => window.diomano !== undefined, null, { timeout: 90_000 });
    await page.waitForFunction(
      () => document.querySelector("#title-hint")?.textContent?.includes("beginnen"),
      null,
      { timeout: 90_000 },
    );

    // --- the title card: choose a level without starting --------------------
    check(
      "Normal is chosen by default",
      await read(
        () => document.querySelector("#title-level button.chosen")?.textContent === "Normal",
      ),
    );
    await page.click("#title-level button[data-level='0']");
    await page.waitForTimeout(600);
    const afterChoice = await read(() => ({
      tick: window.diomano.sim.e.dio_tick_count(),
      title: !document.querySelector("#title")?.classList.contains("overlay-hidden"),
      chosen: document.querySelector("#title-level button.chosen")?.textContent ?? "",
      url: location.search,
      stored: (() => {
        try {
          return localStorage.getItem("diomano.level");
        } catch {
          return null;
        }
      })(),
    }));
    check(
      "choosing a level does not start the match",
      afterChoice.tick === 0 && afterChoice.title,
      `tick ${afterChoice.tick}, card up: ${afterChoice.title}`,
    );
    check(
      "the chosen level is marked, remembered and in the URL",
      afterChoice.chosen === "Leicht" &&
        afterChoice.stored === "0" &&
        afterChoice.url.includes("level=easy"),
      JSON.stringify(afterChoice),
    );
    await shoot("play-0-title");

    // Anywhere on the card that is not a control starts the match.
    await page.mouse.click(640, 40);
    await ticks(5);
    check("a click on the card starts the match", (await tick()) > 0);

    // --- the first hint, and doing what it says ------------------------------
    const firstHint = await becomes(
      () =>
        document.querySelector(".hud-hint.shown")?.textContent?.startsWith("Ebne Land") ?? false,
      null,
      30_000,
    );
    check("the first hint asks for level ground", firstHint);
    // The player's own settlement, and a dry cell beside it, put in the middle
    // of the screen — what the hint asks the player to look at.
    const beside = await read(() => {
      const s = window.diomano.sim;
      const home = s.settlements().find((t) => t.owner === 0);
      if (!home) return null;
      const sea = s.e.dio_sea_level();
      for (let r = 2; r < 8; r++) {
        for (const [dx, dy] of [
          [r, 0],
          [-r, 0],
          [0, r],
          [0, -r],
        ]) {
          const x = home.x + dx;
          const y = home.y + dy;
          if (x < 1 || y < 1 || x >= s.N - 1 || y >= s.N - 1) continue;
          const c = s.idx(home.face, x, y);
          if (s.water[c] === 0 && s.lava[c] === 0 && s.height[c] > sea) {
            return { face: home.face, x, y };
          }
        }
      }
      return null;
    });
    if (!beside) fail("no dry cell beside the player's settlement");
    await read((c) => window.diomano.aimAtCell(c.face, c.x, c.y), beside);
    await page.waitForTimeout(1200);
    await shoot("play-1-hint");
    // Lower first — the hand starts empty and a raise would be refused — then
    // put the earth back: the plain sculpt the hint is about.
    for (const verb of [VERB.LOWER, VERB.LOWER, VERB.RAISE, VERB.RAISE]) {
      await read(({ c, v }) => window.diomano.sim.push(0, v, c.face, c.x, c.y, 0), {
        c: beside,
        v: verb,
      });
      await ticks(2);
    }
    check(
      "a sculpt retires the first hint",
      await becomes(
        () =>
          !(document.querySelector(".hud-hint")?.textContent ?? "").startsWith("Ebne Land") ||
          !document.querySelector(".hud-hint.shown"),
        null,
      ),
    );

    // --- the first wave, announced --------------------------------------------
    // Pull back a little first, so the shot shows the coast the wave is coming
    // for — and before the banner, which is up for seconds of wall clock that a
    // software renderer spends quickly.
    await page.mouse.move(640, 400);
    for (let i = 0; i < 2; i++) {
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(80);
    }
    const telegraph = await tickUntil("telegraph", 6000);
    check("the first wave's telegraph begins", telegraph);
    check(
      "the telegraph is announced",
      await becomes(
        () => document.querySelector(".hud-banner.shown")?.textContent === "Welle 1 rollt an",
        null,
      ),
    );
    check(
      "the wave hint names the flood line",
      await becomes(
        () =>
          document.querySelector(".hud-hint.shown")?.textContent?.startsWith("Die Welle kommt") ??
          false,
        null,
      ),
    );
    await shootBanner("play-2-wave-incoming");

    // --- the peak, read out ----------------------------------------------------
    check("the first wave peaks and is scored", await tickUntil("scored", 3000));
    const peak = await read(() => ({
      mine: window.diomano.sim.e.dio_score(0, 0),
      theirs: window.diomano.sim.e.dio_score(1, 0),
    }));
    const verdict =
      peak.mine > peak.theirs ? "gewonnen" : peak.theirs > peak.mine ? "verloren" : "unentschieden";
    const expected = `Welle 1 · ${peak.mine} : ${peak.theirs} — ${verdict}`;
    const banner = await becomes(
      (want) => document.querySelector(".hud-banner.shown")?.textContent === want,
      expected,
    );
    check(
      "the peak banner reads the wave's score",
      banner,
      banner ? expected : await read(() => document.querySelector(".hud-banner")?.textContent),
    );
    await shootBanner("play-3-peak");
    const tally = await read(() => document.querySelector(".hud-waves")?.textContent ?? "");
    check("the tally marks the first wave", /^[●○◐]·+$/.test(tally), JSON.stringify(tally));

    // --- something happens out of sight ------------------------------------------
    // The opponent casts on its own home, which is on the far side of the
    // planet from the player's: what the off-screen pips exist for. Pushed for
    // player 1 from the console, because whether the scripted opponent casts
    // in this window is its business, and the pip must not wait on it.
    const cast = await read(
      ({ powers }) => {
        const s = window.diomano.sim;
        const home = s.settlements().find((t) => t.owner === 1);
        if (!home) return null;
        const mana = s.e.dio_mana(1);
        for (const [verb, power] of powers) {
          if (s.e.dio_power_enabled(power) && s.e.dio_power_cost(power) <= mana) {
            s.push(1, verb, home.face, home.x, home.y, 0);
            return { verb, home: `${home.face}:${home.x},${home.y}` };
          }
        }
        return null;
      },
      { powers: POWERS },
    );
    if (!cast) fail("the opponent has no power it can afford to cast");
    let pips = 0;
    for (let i = 0; i < 40 && pips === 0; i++) {
      pips = await read(() => window.diomano.indicators.drawn);
      if (pips === 0) await page.waitForTimeout(100);
    }
    check("an opponent's power out of sight shows a pip", pips > 0, `${pips} drawn`);
    await page.waitForTimeout(250);
    await shoot("play-3b-pip");

    // --- to the end -------------------------------------------------------------
    check("the match ends", await tickUntil("outcome", 30_000));
    const card = await becomes(() => document.querySelector("button[data-restart]") !== null, null);
    check("the end card comes up", card);
    const endText = await read(() => document.querySelector(".overlay")?.textContent ?? "");
    check("the end card names the opponent's level", endText.includes("Gegner: Leicht"));
    const rows = await read(() =>
      [...document.querySelectorAll(".overlay table.waves tr")].map((r) => ({
        cls: r.className,
        text: r.textContent,
      })),
    );
    check(
      "the end card numbers and marks each wave",
      rows.length > 0 &&
        rows[0].text.startsWith("Welle 1") &&
        rows.every((r) => ["won", "lost", "draw"].includes(r.cls)),
      JSON.stringify(rows),
    );
    await shoot("play-4-end");

    // --- the rematch -------------------------------------------------------------
    await page.click("button[data-restart='same']");
    check(
      "the rematch starts a running match",
      await becomes(() => {
        const s = window.diomano.sim;
        return s.e.dio_outcome() === 0 && s.e.dio_tick_count() > 10;
      }, null),
    );

    if (errors.length > 0) fail(`console errors:\n  ${errors.join("\n  ")}`);
    const failed = results.filter((r) => !r.ok).length;
    if (failed > 0) fail(`${failed} of ${results.length} checks failed`);
    console.log(`play: OK — ${results.length} checks, screenshots in ${OUT_DIR}`);
  } finally {
    await browser.close();
    server.close();
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof Failure) {
    console.error(`play: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
