import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pluginDir = resolve(root, "plugin");
const releaseDir = resolve(root, "release");
execSync("npm run build --workspace plugin", {
  cwd: root,
  env: {
    ...process.env,
    SYNCVAULT_SERVER_URL: process.env.SYNCVAULT_SERVER_URL ?? "https://syncvault.hangyakuzero.workers.dev",
  },
  stdio: "inherit",
});
const version = JSON.parse(readFileSync(resolve(pluginDir, "package.json"), "utf8")).version;

const target = resolve(releaseDir, `syncvault-${version}`);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

for (const file of ["manifest.json", "main.js"]) {
  copyFileSync(resolve(pluginDir, file), resolve(target, file));
}
if (existsSync(resolve(pluginDir, "styles.css"))) {
  copyFileSync(resolve(pluginDir, "styles.css"), resolve(target, "styles.css"));
} else {
  writeFileSync(resolve(target, "styles.css"), "/* SyncVault: no custom styles yet */\n");
}

// Root manifest mirror: BRAT identifies plugins via <repo>/manifest.json.
copyFileSync(resolve(pluginDir, "manifest.json"), resolve(root, "manifest.json"));

execSync(`zip -j -q ${target}.zip ${target}/manifest.json ${target}/main.js ${target}/styles.css`);

console.log(`release bundle: ${target}`);
console.log(`zip: ${target}.zip`);
console.log("root manifest.json mirrored for BRAT");
