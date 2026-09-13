import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const html = readFileSync("index.html", "utf8");
mkdirSync(".smoke", { recursive: true });
// Serve the real page, but point the ethers import at a local copy so the test
// needs no network and proves the page's own code, not esm.sh.
writeFileSync(".smoke/index.html", html.replace(
  '"https://esm.sh/ethers@6.13.4"', '"./ethers.js"'));
execSync("npx --yes esbuild node_modules/ethers/lib.esm/index.js --bundle --format=esm --outfile=.smoke/ethers.js --log-level=error");
console.log("bundled ethers for offline page test");
