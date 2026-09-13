// Boots index.html in headless Chrome and exercises its own JavaScript.
// Proves the page loads, wires up, and refuses hostile offers — with no network.
import { spawn, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";

const PORT = 8793;
const types = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer((req, res) => {
  const p = join(".smoke", req.url === "/" ? "index.html" : req.url.split("?")[0]);
  let body;
  try { body = readFileSync(p); } catch { res.writeHead(404); return res.end("no"); }
  res.writeHead(200, { "content-type": types[extname(p)] ?? "text/plain" });
  res.end(body);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"].find((c) => { try { execSync(`test -x "${c}"`); return true; } catch { return false; } });
if (!CHROME) { console.log("SKIP: no Chrome found"); server.close(); process.exit(0); }

const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9223", "--no-first-run",
  "--user-data-dir=/tmp/nuri-p2p-smoke", "--disable-gpu", "about:blank"], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch("http://127.0.0.1:9223/json/list")).json()).find((t) => t.type === "page"); } catch {}
}
if (!target) { console.error("chrome never came up"); chrome.kill(); server.close(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) pending.get(d.id)(d); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "page threw");
  return r.result?.result?.value;
};

const errors = [];
await send("Runtime.enable");
await send("Log.enable");
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description ?? "exception");
  // A missing favicon is Chrome noise, not a page defect.
  if (d.method === "Log.entryAdded" && d.params.entry.level === "error"
      && !String(d.params.entry.url ?? "").endsWith("/favicon.ico")) errors.push(d.params.entry.text);
});

await send("Page.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
await sleep(2500);

const checks = [];
const ok = (name, cond, detail = "") => { checks.push({ name, pass: !!cond, detail }); console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail && !cond ? " — " + detail : ""}`); };

ok("page has its heading", (await evaluate(`document.querySelector('h1')?.textContent`))?.includes("Swap with a person"));
const missing = await evaluate(`JSON.stringify(['giveAmt','giveTok','wantAmt','wantTok','expiry','mk','cp','inOffer','chk','take','load','list'].filter(i=>!document.getElementById(i)))`);
ok("every control exists", missing === "[]", missing);
ok("the module booted (ethers is live)", await evaluate(`(async()=>{const m=await import('./ethers.js');return typeof m.ethers.getAddress==='function'})()`));
ok("buttons are wired", await evaluate(`!!document.getElementById('mk').onclick && !!document.getElementById('chk').onclick && !!document.getElementById('load').onclick`));
ok("nothing errored on load", errors.length === 0, errors.join(" | "));

// The page must refuse a hostile offer, and say so in words a person can read.
await evaluate(`document.getElementById('inOffer').value = 'not an offer at all'`);
await evaluate(`document.getElementById('chk').click()`);
await sleep(600);
const msg = await evaluate(`document.getElementById('takeMsg').textContent`);
ok("garbage offer is refused in plain words", /not a valid offer/i.test(msg), msg);
ok("accept stays disabled after a bad offer", await evaluate(`document.getElementById('take').disabled`));

const wrongChain = JSON.stringify({ v: "nuri-p2p/2", settle: "seaport-1.6",
  give: { chain: "eip155:1", asset: "0x0", amount: "1" }, want: { chain: "eip155:1", asset: "0x0", amount: "1" },
  terms: { contract: "0x0000000000000068F116a894984e2DB1123eB395", order: {} }, proof: "0x" });
await evaluate(`document.getElementById('inOffer').value = ${JSON.stringify(wrongChain)}`);
await evaluate(`document.getElementById('chk').click()`);
await sleep(600);
const msg2 = await evaluate(`document.getElementById('takeMsg').textContent`);
ok("an offer for another network is refused", /different network/i.test(msg2), msg2);

const otherMethod = JSON.stringify({ v: "nuri-p2p/2", settle: "htlc-v1",
  give: { chain: "bip122:000000000019d6689c085ae165831e93", asset: "btc", amount: "1000" },
  want: { chain: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000" },
  terms: {}, proof: "0x" });
await evaluate(`document.getElementById('inOffer').value = ${JSON.stringify(otherMethod)}`);
await evaluate(`document.getElementById('chk').click()`);
await sleep(600);
const msg3 = await evaluate(`document.getElementById('takeMsg').textContent`);
ok("a settlement method this page cannot do is refused, not attempted", /cannot do yet/i.test(msg3), msg3);

ws.close(); chrome.kill(); server.close();
const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} page checks passed`);
process.exit(failed.length ? 1 : 0);
