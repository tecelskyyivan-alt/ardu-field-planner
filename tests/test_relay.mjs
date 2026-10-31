// openRelay (web-stable/mav/transport.js): one popup per click, relay-page candidates tried
// in order in that same window; the one whose page answers "ready" is the link.
import fs from "node:fs";
import vm from "node:vm";

let failed = 0;
function check(name, ok) { console.log((ok ? "  OK  " : " FAIL ") + name); if (!ok) failed++; }

// A fake browser: window.open/location navigations are recorded; a relay page "loads" only on
// hosts in `alive` and then answers hello with ready (and announces "here" like the real page).
function makeWorld(alive, delay = 5) {
  const listeners = [];
  const opens = [], navs = [];
  const win = {
    closed: false, url: null,
    get location() { const w = this; return { set href(u) { navs.push(u); w.url = u; } }; },
    postMessage(msg, origin) {
      const page = this.url && new URL(this.url);
      if (!page || page.origin !== origin || !alive.includes(page.hostname)) return;
      if (msg.fmp === "hello") setTimeout(() => emit({ origin: page.origin, source: win, data: { fmp: "ready" } }), delay);
    },
  };
  function emit(ev) { for (const l of [...listeners]) l(ev); }
  const sandbox = {
    screen: { availWidth: 400, availHeight: 800 },
    setTimeout, clearTimeout, setInterval, clearInterval, URL,
    addEventListener: (t, f) => { if (t === "message") listeners.push(f); },
    removeEventListener: (t, f) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
    open: (u) => { opens.push(u); win.url = u; return win; },
    focus() {},
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync("web-stable/mav/transport.js", "utf8"), sandbox, { filename: "transport.js" });
  return { T: sandbox.MAV_TRANSPORT, opens, navs, win };
}

const C = ["http://192.0.2.50/fmp-relay.html", "http://elrs_txbp.local/fmp-relay.html", "http://10.0.0.1/fmp-relay.html"];

// 1) Only the access-point address answers: one popup, navigated on twice, link = the third.
{
  const w = makeWorld(["10.0.0.1"]);
  const t = await w.T.openRelay(C, 200);
  check("one popup for all candidates", w.opens.length === 1 && w.opens[0] === C[0]);
  check("same window navigated through the rest in order", w.navs.join() === [C[1], C[2]].join());
  check("transport.url = the candidate that answered", t.url === C[2]);
}
// 2) First candidate answers: no navigation at all.
{
  const w = makeWorld(["192.0.2.50"]);
  const t = await w.T.openRelay(C, 200);
  check("first answers -> no further navigation", w.navs.length === 0 && t.url === C[0]);
}
// 3) Nobody answers: one error naming every candidate, still a single popup.
{
  const w = makeWorld([]);
  let msg = "";
  try { await w.T.openRelay(C, 100); } catch (e) { msg = String(e.message); }
  check("none -> error lists all candidates", C.every((u) => msg.includes(u)));
  check("none -> still one popup", w.opens.length === 1);
}
// 4) A single URL (computer bridge) keeps the old contract.
{
  const w = makeWorld(["127.0.0.1"]);
  const t = await w.T.openRelay("http://127.0.0.1:14550/relay.html", 200);
  check("single string still works", t.url === "http://127.0.0.1:14550/relay.html" && w.opens.length === 1);
}

// 5) Per-candidate timeouts (short ones for the iPhone hotspot sweep): the slow one still answers.
{
  const w = makeWorld(["10.0.0.1"], 120);   // its page answers in 120 ms: more than 50, less than 300
  const t0 = Date.now();
  const t = await w.T.openRelay(C, [50, 50, 300]);
  check("per-candidate timeouts: array accepted, answering one found", t.url === C[2] && Date.now() - t0 < 1450);   // 1200 ms findRelay + 50 + 50 + 120
}

console.log("\nRESULT: " + (failed ? failed + " FAILURE(S)" : "ALL CHECKS PASSED"));
process.exit(failed ? 1 : 0);
