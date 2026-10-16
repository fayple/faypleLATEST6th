// Netlify build step: adds the "Download Games" section to index.html.
//
// The section's CSS / HTML / JS live in scripts/games-parts/. This script splices
// them into index.html at deploy time (index.html in the repo stays untouched).
// It is idempotent, and if an anchor can't be found it logs a warning and leaves
// index.html alone instead of failing the deploy.
//
// To make the change permanent, run `node scripts/inject-games.mjs` locally,
// commit the resulting index.html, and delete this script + the build command.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const part = (n) => readFileSync(join(root, "scripts", "games-parts", n), "utf8");
const file = join(root, "index.html");
let html = readFileSync(file, "utf8");

if (html.includes('id="gm-style"')) {
  console.log("[games] already injected, nothing to do");
  process.exit(0);
}

const warn = (m) => { console.warn(`[games] WARNING: ${m} — Download Games was NOT added`); process.exit(0); };

const CTA_ANCHOR = "  <!-- SOCIAL BUTTONS -->\n";
const NAV_ANCHOR = '    <a class="nav-link" href="#" onclick="openSupport();closeNav();return false">Support';
const FOOT_ANCHOR = "<!-- FOOTER -->\n<footer>";
const NAV_LINK =
  '    <a class="nav-link" href="#games" onclick="openGames();if(typeof closeNav===\'function\')closeNav();return false">Download Games<span class="new-badge">NEW</span></a>\n';

const head = html.indexOf("</head>");
const styleEnd = head < 0 ? -1 : html.lastIndexOf("</style>", head);
const bodyEnd = html.lastIndexOf("</body>");
if (styleEnd < 0 || bodyEnd < 0) warn("could not find </style> / </body>");
for (const [name, a] of [["social buttons", CTA_ANCHOR], ["support link", NAV_ANCHOR], ["footer", FOOT_ANCHOR]]) {
  if (html.split(a).length !== 2) warn(`anchor "${name}" not found exactly once in index.html`);
}

const cut = styleEnd + "</style>".length;
html = html.slice(0, cut) + "\n" + part("games.css") + html.slice(cut);
html = html.replace(CTA_ANCHOR, () => part("cta.html") + CTA_ANCHOR);
html = html.replace(NAV_ANCHOR, () => NAV_LINK + NAV_ANCHOR);
html = html.replace(FOOT_ANCHOR, () => part("view.html") + FOOT_ANCHOR);
const end = html.lastIndexOf("</body>");
html = html.slice(0, end) + part("games.js") + "\n" + html.slice(end);

writeFileSync(file, html);
console.log("[games] Download Games section injected into index.html");
