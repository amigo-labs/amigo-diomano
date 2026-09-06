/**
 * Cross-build determinism check: native versus browser. HANDOFF §6.3.
 *
 * This is the single most valuable artifact of the project. It is the reason the
 * simulation is a separate Rust crate at all: the same source compiles to a
 * native binary and to a `.wasm`, both replay the same input log, and the
 * per-tick state hashes must match exactly. If they do not, determinism is
 * already broken and the netcode phase is dead on arrival — and no amount of
 * later work can retrofit it.
 *
 * It runs a real headless browser rather than the wasm module under Node,
 * because Node and the browser are different embeddings and the browser is the
 * one that ships.
 *
 * Usage:  node tools/verify-cross.mjs [path/to/session.log]
 * Exits 0 on agreement, 1 on divergence or on any failure to run the check —
 * "could not verify" is not "verified".
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = resolve(WEB_ROOT, "..");
const LOG_PATH = resolve(process.argv[2] ?? join(REPO_ROOT, "fixtures/session.log"));
const WASM_PATH = join(WEB_ROOT, "public/diomano.wasm");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

function fail(message) {
  console.error(`verify-cross: ${message}`);
  process.exit(1);
}

/**
 * Where to find Chromium.
 *
 * Playwright normally manages its own browser download, keyed to the exact
 * package version. CI images and sandboxes often ship a pre-installed build
 * under a different revision number, and Playwright then refuses to launch
 * rather than using it. `DIOMANO_CHROMIUM` (or `PLAYWRIGHT_CHROMIUM_EXECUTABLE`)
 * points at one explicitly; otherwise this falls back to the conventional
 * pre-installed path, and failing that lets Playwright do its usual thing.
 */
function chromiumLaunchOptions() {
  const explicit = process.env.DIOMANO_CHROMIUM ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const candidates = [explicit, "/opt/pw-browsers/chromium"].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return { executablePath: path };
  }
  return {};
}

/** Serve `web/` with `public/` flattened to the root, exactly as Vite does. */
function serve() {
  return new Promise((ok) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // `normalize` plus the prefix check keeps a crafted path from escaping the
      // web root. This server is local and short-lived, but a path traversal in
      // a build tool is still a path traversal. Malformed percent-encoding
      // throws, and inside an async handler that is an unhandled rejection
      // rather than a 400 — the same fix the other two tool servers got.
      let rel;
      try {
        rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      const candidates = [join(WEB_ROOT, rel), join(WEB_ROOT, "public", rel)];
      for (const path of candidates) {
        // With the separator: a sibling `web-evil` starts with `web` too.
        if (path !== WEB_ROOT && !path.startsWith(WEB_ROOT + sep)) continue;
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

/** Run the native verifier and collect its per-tick hashes. */
function nativeHashes(logPath) {
  return new Promise((ok, no) => {
    const child = spawn("cargo", ["run", "--quiet", "-p", "diomano-cli", "--", "replay", logPath], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", no);
    child.on("close", (code) => {
      if (code !== 0) {
        no(new Error(`diomano-cli exited ${code}`));
        return;
      }
      const hashes = [];
      for (const line of out.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        const [tick, hash] = trimmed.split(/\s+/);
        hashes.push([Number(tick), hash]);
      }
      ok(hashes);
    });
  });
}

async function main() {
  if (!existsSync(LOG_PATH)) fail(`no session log at ${LOG_PATH} (run \`just record\` first)`);
  if (!existsSync(WASM_PATH)) fail(`no wasm at ${WASM_PATH} (run \`just wasm\` first)`);

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    fail("playwright is not installed; run `bun install` in web/");
  }

  const logText = await readFile(LOG_PATH, "utf8");
  const native = await nativeHashes(LOG_PATH);
  if (native.length === 0) fail("the native replay produced no hashes");

  const server = await serve();
  const { port } = server.address();
  const browser = await chromium.launch({ headless: true, ...chromiumLaunchOptions() });
  let browserHashes;
  try {
    const page = await browser.newPage();
    // A wasm trap or a thrown error inside the page would otherwise surface as
    // a silent `undefined`, which is exactly the kind of "passing" this check
    // must never do.
    page.on("pageerror", (err) => fail(`page error: ${err.message}`));
    await page.goto(`http://127.0.0.1:${port}/tools/replay.html`, { waitUntil: "load" });
    const result = await page.evaluate((text) => window.diomanoReplay(text), logText);
    if (result.error) fail(`browser replay: ${result.error}`);
    browserHashes = result.hashes;
  } finally {
    await browser.close();
    server.close();
  }

  // --- compare -------------------------------------------------------------
  const problems = [];
  if (native.length !== browserHashes.length) {
    problems.push(
      `native produced ${native.length} hashes, browser produced ${browserHashes.length}`,
    );
  }
  const n = Math.min(native.length, browserHashes.length);
  for (let i = 0; i < n; i++) {
    const [nt, nh] = native[i];
    const [bt, bh] = browserHashes[i];
    if (nt !== bt || nh !== bh) {
      problems.push(
        `divergence at hash ${i}:\n` +
          `    native  tick ${nt} ${nh}\n` +
          `    browser tick ${bt} ${bh}\n` +
          `    the previous ${i} hashes matched, so it began in ticks ${Math.max(nt - 30, 0)}..${nt}`,
      );
      break;
    }
  }

  if (problems.length > 0) {
    console.error("\nDETERMINISM FAILURE — native and browser disagree.\n");
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      "\nThis is not a rendering bug and it is not a browser quirk. Something in\n" +
        "diomano-sim is reading state that differs between the two builds: a float\n" +
        "in simulation state, an unspecified iteration order, or arithmetic that\n" +
        "wraps in one profile and not the other (HANDOFF §10).\n",
    );
    process.exit(1);
  }

  const ticks = native[native.length - 1][0] + 30;
  console.log(
    `verify-cross: OK — ${native.length} state hashes over ${ticks} ticks
              identical between the native binary and headless Chromium.`,
  );
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
