/* i18n completeness: every Ukrainian string the app shows a user must have an EN key.
 *
 * EN mode shipped half-translated for months — the HUD, the map tooltips and the
 * confirm() dialogs stayed Ukrainian — because nothing checked. Adding a message is
 * one line; adding its key is a second line nobody remembers. This test makes the
 * second line mandatory.
 *
 * Two mechanisms, two rules:
 *   setMsg(s)                      → setMsg() runs t() over the WHOLE string, so a
 *                                    key in i18n.js is enough; no wrapper needed.
 *   confirm(s) / bindTooltip(s)    → nothing translates these, so the literal must be
 *                                    wrapped in t() AND keyed.
 *
 * The subtle one: t() matches the key EXACTLY — no whitespace collapsing (unlike the
 * DOM walker for static HTML). A prefix concatenated with a value ("Сектор " + i)
 * therefore needs its key stored WITH the trailing space. Checked below.
 *
 * Run:  node test_i18n.mjs
 */
import fs from "fs";

let failed = 0;
const check = (name, cond) => { console.log((cond ? "  OK  " : " FAIL ") + name); if (!cond) failed++; };

const here = (p) => new URL(p, import.meta.url);
const appSrc = fs.readFileSync(here("./web-stable/app.js"), "utf8");

globalThis.window = {};
new Function(fs.readFileSync(here("./web-stable/i18n.js"), "utf8"))();
const TR = globalThis.window.FMP_TR;

const CYR = /[Ѐ-ӿ]/;
const STR = '("(?:[^"\\\\]|\\\\.)*")';

// t() verbatim from app.js — the exact-match lookup is the thing under test.
const t = (s) => (Object.prototype.hasOwnProperty.call(TR, s) ? TR[s] : s);

check("i18n.js loaded and non-trivial", !!TR && Object.keys(TR).length > 300);

// ---- 1. every literal handed to t() is keyed -------------------------------------
{
  const missing = [];
  for (const m of appSrc.matchAll(new RegExp("\\bt\\(\\s*" + STR + "\\s*\\)", "g"))) {
    const s = JSON.parse(m[1]);
    if (CYR.test(s) && !Object.prototype.hasOwnProperty.call(TR, s)) missing.push(s);
  }
  check(`every t("…") literal has a key (${missing.length} missing)`, missing.length === 0);
  missing.forEach((s) => console.log("        no key: " + JSON.stringify(s)));
}

// ---- 2. every whole-string setMsg() literal is keyed ------------------------------
{
  const missing = [];
  for (const m of appSrc.matchAll(new RegExp("setMsg\\(\\s*" + STR + "\\s*,", "g"))) {
    const s = JSON.parse(m[1]);
    if (CYR.test(s) && !Object.prototype.hasOwnProperty.call(TR, s)) missing.push(s);
  }
  check(`every setMsg("…") literal has a key (${missing.length} missing)`, missing.length === 0);
  missing.forEach((s) => console.log("        no key: " + JSON.stringify(s)));
}

// ---- 3. confirm() / bindTooltip() literals must be WRAPPED, not just keyed --------
// Neither call translates anything on its own, so a bare literal ships Ukrainian to an
// EN user even when the key exists.
{
  const bare = [];
  for (const m of appSrc.matchAll(new RegExp("(confirm|bindTooltip)\\(\\s*" + STR, "g"))) {
    const s = JSON.parse(m[2]);
    if (CYR.test(s)) bare.push(m[1] + "(): " + s);
  }
  check(`no unwrapped confirm()/bindTooltip() literals (${bare.length} bare)`, bare.length === 0);
  bare.forEach((s) => console.log("        not wrapped in t(): " + s));
}

// ---- 4. concatenated prefixes keep their trailing space ---------------------------
// "Сектор " + i must not be keyed as "Сектор": the lookup is exact, so the trimmed key
// would never match and the string would silently stay Ukrainian.
{
  const broken = [];
  for (const m of appSrc.matchAll(new RegExp("\\bt\\(\\s*" + STR + "\\s*\\)\\s*\\+", "g"))) {
    const s = JSON.parse(m[1]);
    if (!CYR.test(s)) continue;
    if (!Object.prototype.hasOwnProperty.call(TR, s)) { broken.push("unkeyed: " + JSON.stringify(s)); continue; }
    if (s !== s.trimEnd() && TR[s] === TR[s].trimEnd()) broken.push("EN lost the trailing space: " + JSON.stringify(s));
  }
  check(`concatenated prefixes keyed verbatim (${broken.length} broken)`, broken.length === 0);
  broken.forEach((s) => console.log("        " + s));
}

// ---- 5. the table itself is sane --------------------------------------------------
{
  // A "translation" still in Cyrillic means someone pasted the source string.
  const ALLOWED_BILINGUAL = new Set(["Мова / Language"]);
  const cyr = Object.entries(TR).filter(([k, v]) => CYR.test(v) && !ALLOWED_BILINGUAL.has(k));
  check(`no EN value left in Cyrillic (${cyr.length})`, cyr.length === 0);
  cyr.forEach(([k, v]) => console.log("        " + JSON.stringify(k) + " -> " + JSON.stringify(v)));

  const empty = Object.entries(TR).filter(([, v]) => typeof v !== "string" || v.trim() === "");
  check(`no empty translations (${empty.length})`, empty.length === 0);
}

// ---- 6. t() actually round-trips the tricky keys ----------------------------------
// Guards the exact-match rule end to end rather than trusting the table's shape.
{
  const samples = ["Сектор ", "Карта висот недоступна: ", "Старт", "Продовжити з місця зупинки?\n\nПройдено "];
  const unresolved = samples.filter((s) => t(s) === s);
  check(`t() resolves the awkward keys — trailing space, newlines (${unresolved.length} unresolved)`,
    unresolved.length === 0);
  unresolved.forEach((s) => console.log("        unresolved: " + JSON.stringify(s)));
}

console.log("\nRESULT: " + (failed ? failed + " FAILURE(S)" : "ALL CHECKS PASSED"));
process.exit(failed ? 1 : 0);
