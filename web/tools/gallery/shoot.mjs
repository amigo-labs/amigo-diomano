/**
 * Screenshot the model gallery in headless Chromium.
 *
 * Usage:  node tools/gallery/shoot.mjs [out.png] [tier]
 * Needs `tools/gallery/dist` (see index.html) and `public/models/*.glb`.
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = resolve(process.argv[2] ?? join(WEB_ROOT, "tools/gallery/gallery.png"));
const TIER = process.argv[3] ? `?tier=${process.argv[3]}` : "";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

if (!existsSync(join(WEB_ROOT, "tools/gallery/dist/index.html"))) {
  console.error(
    "gallery: no build; run `bunx vite build --config tools/gallery/vite.config.ts` first",
  );
  process.exit(1);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  // Malformed percent-encoding throws; a bad request must not take the server
  // down mid-screenshot.
  let rel;
  try {
    rel = normalize(decodeURIComponent(url.pathname)).replaceAll("\\", "/").replace(/^\/+/, "");
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  if (rel === "" || rel === ".") rel = "index.html";
  for (const root of [join(WEB_ROOT, "tools/gallery/dist"), join(WEB_ROOT, "public")]) {
    // Inside *this* root, not merely inside web/: a `..` in the path must not
    // reach a sibling directory.
    const file = join(root, rel);
    if (file !== root && !file.startsWith(root + sep)) continue;
    try {
      if (!statSync(file).isFile()) continue;
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
      return;
    } catch {}
  }
  res.writeHead(404).end("not found");
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const { port } = server.address();

const { chromium } = await import("playwright");
const executablePath = ["/opt/pw-browsers/chromium"].find((p) => existsSync(p));
const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader"],
  ...(executablePath ? { executablePath } : {}),
});
// Everything from here on runs inside try/finally: a timeout or a page error
// used to leave the server and the browser for process exit to reap, and
// `process.exit` from inside an event handler skips cleanup entirely.
let failure = null;
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 600 } });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await page.goto(`http://127.0.0.1:${port}/${TIER}`, { waitUntil: "load" });
  await page.waitForSelector("body[data-ready]", { timeout: 20000 });
  await page.waitForTimeout(300);
  if (pageErrors.length > 0) throw new Error(`page error: ${pageErrors.join("; ")}`);
  await page.screenshot({ path: OUT, fullPage: true });
  console.log(OUT);
} catch (err) {
  failure = err;
} finally {
  await browser.close();
  server.close();
}
if (failure !== null) {
  console.error(`gallery: ${failure instanceof Error ? failure.message : String(failure)}`);
  process.exit(1);
}
