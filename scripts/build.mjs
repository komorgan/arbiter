// Bundles Arbiter with esbuild. Everything except Electron is inlined, so neither the packaged desktop app nor the
// server image needs node_modules at runtime.
//   node scripts/build.mjs            desktop (dist/main.mjs, dist/preload.cjs) + server/CLI (dist/arbiter.mjs)
//   node scripts/build.mjs --server   server/CLI only (used by the Docker image)
import { build } from "esbuild";

const serverOnly = process.argv.includes("--server");
const common = { bundle: true, platform: "node", target: "node22", sourcemap: "linked", logLevel: "info", external: ["electron"] };
// Some bundled CommonJS code calls require(); give ESM output a real one.
const esmRequire = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" };

// The CLI (including `arbiter server`). resourceRoot() resolves to dist/.., so public/ and examples/ sit beside dist/.
await build({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/arbiter.mjs", format: "esm", banner: esmRequire });

if (!serverOnly) {
  await build({ ...common, entryPoints: ["src/desktop/main.ts"], outfile: "dist/main.mjs", format: "esm", banner: esmRequire });
  await build({
    ...common,
    entryPoints: ["src/desktop/preload.ts"],
    outfile: "dist/preload.cjs",
    format: "cjs",
    platform: "browser", // sandboxed preload: no Node builtins
  });
}
