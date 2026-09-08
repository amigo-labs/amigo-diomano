/**
 * No runtime import cycles in the client. HANDOFF §7.5.
 *
 * # Why this is a gate and not a lint preference
 *
 * A cycle between two ES modules does not fail to compile and does not fail to
 * run. It hands the *evaluation order* to the bundler, and the bundler is free
 * to pick either module first. Everything keeps working for as long as it keeps
 * picking the lucky one.
 *
 * That is not a hypothetical. `planet.ts` imported `CLOUD_NOISE_GLSL` from
 * `atmosphere.ts` and `atmosphere.ts` imported `BASE_RADIUS` back, and for
 * weeks Rollup emitted `atmosphere.ts` first, so the fragment shader's
 * `${CLOUD_NOISE_GLSL}` — read at module scope, while the template literal is
 * being built — found a string. Then an unrelated commit added a module, the
 * order flipped, and the shipped client died on load with `Cannot access 'ba'
 * before initialization`: the same source, the same tests, a different draw
 * from the same hat.
 *
 * So the rule is the cycle, not the crash. A cycle that happens to be ordered
 * correctly today is a crash scheduled for whenever the graph next changes, and
 * the commit that collects it will have nothing to do with it.
 *
 * # What counts as an edge
 *
 * Only imports that survive to runtime. `import type` and `{ type X }` are
 * erased by `tsc` and cannot order anything — which is why the deliberate
 * `main.ts` ⇄ `game.ts` relationship is not a finding: `main.ts` names the
 * `Game` type only, and reaches the module itself through `import()`, whose
 * whole purpose here is to defer the chunk until the title card is up.
 *
 * Usage:  node tools/verify-cycles.mjs
 * Exits 0 when the graph is acyclic, 1 with the cycles printed otherwise.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const WEB_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SRC = join(WEB_ROOT, "src");

const rel = (p) => relative(WEB_ROOT, p).replaceAll("\\", "/");

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** `./planet` as written in the source, to the file it means on disk. */
function resolveSpecifier(from, spec) {
  const base = resolve(dirname(from), spec);
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The runtime edges out of one file, each tagged with the import that made it.
 *
 * Parsed with the TypeScript compiler rather than matched with a regex,
 * because the distinction that decides every edge — `{ type X }` versus `{ X }`,
 * a static `from` clause versus a dynamic `import()` — is exactly the
 * distinction a regex gets wrong, and a checker that cries wolf gets switched
 * off.
 */
function edges(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );
  const found = [];

  const add = (spec, clause) => {
    if (!spec.startsWith(".")) return;
    const target = resolveSpecifier(file, spec);
    if (target) found.push({ target, clause });
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      // `import "./x"` — a side effect, and the strongest edge there is.
      if (!clause) {
        add(statement.moduleSpecifier.text, `import "${statement.moduleSpecifier.text}"`);
        continue;
      }
      if (clause.isTypeOnly) continue;
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings) && !clause.name) {
        const values = bindings.elements.filter((e) => !e.isTypeOnly);
        if (values.length === 0) continue;
        add(statement.moduleSpecifier.text, `{ ${values.map((e) => e.name.text).join(", ")} }`);
        continue;
      }
      // A default or namespace binding: a value either way.
      add(statement.moduleSpecifier.text, statement.getText(source).split("\n")[0]);
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      !statement.isTypeOnly
    ) {
      // A re-export runs the module it re-exports from.
      add(statement.moduleSpecifier.text, statement.getText(source).split("\n")[0]);
    }
  }
  return found;
}

const files = sources(SRC);
const graph = new Map(files.map((f) => [f, edges(f)]));

// Depth-first, reporting the cycle by the back edge that closes it. Reported
// once per back edge: the same cycle reached from three different entry points
// is one problem with one fix.
const cycles = [];
const seen = new Set();
const state = new Map();
const stack = [];

function walk(node) {
  state.set(node, "open");
  stack.push(node);
  for (const edge of graph.get(node) ?? []) {
    if (state.get(edge.target) === "open") {
      const loop = [...stack.slice(stack.indexOf(edge.target)), edge.target];
      const key = loop.map(rel).join(">");
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push({ loop, closedBy: edge });
      }
    } else if (!state.has(edge.target)) {
      walk(edge.target);
    }
  }
  stack.pop();
  state.set(node, "done");
}

for (const file of files) if (!state.has(file)) walk(file);

if (cycles.length > 0) {
  console.error("\nIMPORT CYCLE — the bundler, not the source, decides what runs first.\n");
  for (const { loop, closedBy } of cycles) {
    console.error(`  ${loop.map(rel).join("\n    -> ")}`);
    console.error(`    closed by ${closedBy.clause} in ${rel(loop[loop.length - 2])}\n`);
  }
  console.error(
    "A top-level `const` in either module may be read before it is initialised,\n" +
      "and which one is a coin the bundler flips again on every graph change. Break\n" +
      "the cycle: move the shared value into a module that imports neither — the\n" +
      "argument `surf.ts` already makes in its header — or make the import a type-\n" +
      "only one if that is all it ever was.\n",
  );
  process.exit(1);
}

console.log(`verify-cycles: OK — ${files.length} modules, no runtime import cycles.`);
