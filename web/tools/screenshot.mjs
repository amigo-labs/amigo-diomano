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

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT_DIR = resolve(process.argv[2] ?? join(WEB_ROOT, "screenshots"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

function fail(message) {
  console.error(`screenshot: ${message}`);
  process.exit(1);
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
      let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
      if (rel === "/" || rel === "") rel = "index.html";
      const candidates = [join(WEB_ROOT, "dist", rel), join(WEB_ROOT, "public", rel)];
      for (const path of candidates) {
        if (!path.startsWith(WEB_ROOT)) continue;
        if (!existsSync(path) || path.endsWith("/")) continue;
        const body = await readFile(path);
        res.writeHead(200, {
          "content-type": MIME[extname(path)] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        res.end(body);
        return;
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
    page.on("pageerror", (err) => fail(`page error: ${err.message}`));
    const shoot = async (name) => {
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

    // Force the match to its end quickly: tick the sim hard from the console.
    // (The dev handle exists exactly for this kind of interrogation.)
    const outcome = await page.evaluate(() => {
      const sim = window.diomano.sim;
      for (let i = 0; i < 12000 && sim.e.dio_outcome() === 0; i++) sim.tick();
      return sim.e.dio_outcome();
    });
    if (outcome === 0) fail("12,000 forced ticks and no outcome — the match never ends");
    console.log(`  forced outcome: ${outcome}`);
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
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`screenshot: OK — PNGs in ${OUT_DIR}`);
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
