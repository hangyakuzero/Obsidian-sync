import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  platform: "browser",
  define: {
    __SYNCVAULT_SERVER_URL__: JSON.stringify(
      process.env.SYNCVAULT_SERVER_URL ?? "http://localhost:8787",
    ),
  },
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}