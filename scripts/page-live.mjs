// Loads the real page and clicks "Look for offers" against the REAL public relays.
// Proves the shipped page discovers an intent nobody told it about.
import { spawn, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";

const PORT = 8794;
const types = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer((req, res) => {
  const p = join(".smoke", req.url === "/" ? "index.html" : req.url.split("?")[0]);
  let body; try { body = readFileSync(p); } catch { res.writeHead(404); return res.end("no"); }
  res.writeHead(200, { "content-type": types[extname(p)] ?? "text/plain" });
  res.end(body);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"].find((c) => { try { execSync(`test -x "${c}"`); return true; } catch { return false; } });
if (!CHROME) { console.log("SKIP: no Chrome"); server.close(); process.exit(0); }
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9224", "--no-first-run",
  "--user-data-dir=/tmp/nuri-p2p-live", "--disable-gpu", "about:blank"], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) { await sleep(250);
  try { target = (await (await fetch("http://127.0.0.1:9224/json/list")).json()).find((t) => t.type === "page"); } catch {} }
if (!target) { console.error("chrome never came up"); chrome.kill(); server.close(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) pending.get(d.id)(d); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send("Page.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
await sleep(2500);

// Ask the relays ourselves first. If intents are out there, the page MUST show them;
// treating "nothing found" as a pass once hid a real parsing bug in the page.
const onRelays = await new Promise((res) => {
  const w = new WebSocket("wss://nos.lol"); const out = [];
  const t = setTimeout(() => { try { w.close(); } catch {} res(out); }, 8000);
  w.onopen = () => w.send(JSON.stringify(["REQ", "pre", { kinds: [38383], "#m": ["seaport-1.6"], limit: 20 }]));
  w.onmessage = (m) => { const d = JSON.parse(m.data);
    if (d[0] === "EVENT") { try { if (JSON.parse(d[2].content).expiry > Math.floor(Date.now()/1000)) out.push(d[2]); } catch {} }
    if (d[0] === "EOSE") { clearTimeout(t); try { w.close(); } catch {} res(out); } };
  w.onerror = () => { clearTimeout(t); res(out); };
});
console.log(`relays currently hold ${onRelays.length} live intent(s) for this method`);

console.log("clicking 'Look for offers' against the real public relays…");
await evaluate(`document.getElementById('load').click()`);
await sleep(11000);

const listText = await evaluate(`document.getElementById('list').innerText`);
const msg = await evaluate(`document.getElementById('listMsg').textContent`);
console.log("\nwhat the page shows:\n" + listText.split("\n").map((l) => "  " + l).join("\n"));
console.log("\nstatus line: " + msg);

ws.close(); chrome.kill(); server.close();
const foundSomething = /→/.test(listText) || /offer(s)? found/i.test(msg);
const honestlyEmpty = /Nothing on offer right now/i.test(listText);
let pass, verdict;
if (onRelays.length > 0) {
  pass = foundSomething;
  verdict = pass ? "FOUND live intents in the shipped page"
    : `FAILED: ${onRelays.length} intent(s) are on the relays and the page showed none`;
} else {
  pass = honestlyEmpty;
  verdict = pass ? "relays are genuinely empty and the page said so in plain words"
    : "FAILED: nothing on the relays, and the page did not say so";
}
console.log(`\n${verdict}`);
process.exit(pass ? 0 : 1);
