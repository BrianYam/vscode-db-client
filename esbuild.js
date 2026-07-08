// Bundles the extension host into a single dist/extension.js and ships the
// sql.js wasm alongside it. DB drivers (pg/mysql2/ioredis/ssh2) are pure-JS and
// bundle fine; their OPTIONAL native accelerators are marked external so their
// absence just falls back to pure JS (same behaviour as unbundled).
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Optional native deps these libraries try to require and gracefully skip.
const OPTIONAL_NATIVE = ["cpu-features", "pg-native"];

/** Mark any *.node binary require as external (they aren't shipped). */
const nativeNodeExternal = {
  name: "native-node-external",
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }));
  },
};

async function copyWasm() {
  fs.mkdirSync("dist", { recursive: true });
  fs.copyFileSync(
    require.resolve("sql.js/dist/sql-wasm.wasm"),
    path.join("dist", "sql-wasm.wasm")
  );
}

async function main() {
  const opts = {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    platform: "node",
    target: "node18",
    format: "cjs",
    external: ["vscode", ...OPTIONAL_NATIVE],
    plugins: [nativeNodeExternal],
    minify: production,
    sourcemap: !production,
    logLevel: "info",
    // dynamic requires in mysql2/ssh2 → warn, don't fail the build
    logOverride: { "require-resolve-not-external": "silent" },
  };

  if (watch) {
    const ctx = await esbuild.context(opts);
    await copyWasm();
    await ctx.watch();
    console.log("esbuild watching…");
  } else {
    await esbuild.build(opts);
    await copyWasm();
    console.log(`bundled dist/extension.js${production ? " (production)" : ""} + wasm`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
