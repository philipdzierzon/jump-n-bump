// The kiosk flow against a real DOM (#35, #36, #37): the page is `src/jnb.html` itself,
// the bindings are Knockout's own, and the view model is the one the browser gets -- so
// what is under test is the markup and the flow together, which is the pair that opening
// the page was the only way to check.
//
// jsdom is the whole of it: node has no DOM, and a hand-written stub would be the thing
// under test instead. Two holes in it are papered over rather than filled -- there is no
// 2d context (the canvas package is a native build nobody needs for this) and no media
// playback -- and neither is what these assertions are about: the simulation is
// `replay.test.mjs`'s and the pixels are still nobody's.
//
// One page for the whole file, because that is what a browser gives you: `viewmodels.js`
// binds on import and there is exactly one of it. The assertions below walk it the way a
// player does -- landing, names, lobby, match, board, lobby, out -- and then do the same
// walk again through a real relay on a real socket.
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

import { start_server } from "../server/index.js";
import { WebSocket_Transport } from "../src/net/websocket_transport.js";

// The relay is started first because the page's origin is what it is served from: the
// client derives `ws://<host>/ws` from `window.location`, so the origin has to be the real
// one for the online half of this walk to connect to anything (#34).
const server = await start_server(0);
const origin = "http://localhost:" + server.address().port;

const html = fs.readFileSync(new URL("../src/jnb.html", import.meta.url), "utf8");
const dom = new JSDOM(html, {
    url: origin + "/",
    // Page logging still comes through; the two "not implemented" complaints do not.
    virtualConsole: new VirtualConsole().forwardTo(console, { jsdomErrors: "none" }),
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.sessionStorage = dom.window.sessionStorage;
// A context that swallows everything: the renderer is exercised for the calls it makes,
// not for what they paint. Without it `getContext` is null and the first frame throws.
dom.window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {} });

// Binds on import, which is the app starting.
await import("../src/interaction/viewmodels.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Hash navigation, socket round trips and Knockout's own updates all settle a turn or two
// later, so every step waits for what it asked for rather than for a fixed delay.
async function until(what, ready) {
    for (var i = 0; i < 500; i++) {
        if (ready()) return;
        await sleep(10);
    }
    assert.fail("timed out waiting for " + what);
}

const all = (sel, root = document) => [...root.querySelectorAll(sel)];
const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
const shown = (el) => !!el && el.style.display !== "none";
// Screens are told apart by the binding that shows them, which is also how the markup
// names them.
const screen = (name) => document.querySelector(`div[data-bind*="screen() === '${name}'"]`);
const on = async (name) =>
    until(name + " screen", () => window.location.hash === "#" + name && shown(screen(name)));

// Buttons are found by their label, as a player finds them: a hidden screen's button is
// not a button you can press, and three screens share the label "Create a room".
function click(label) {
    const button = all("button").find((el) => text(el) === label && shown(el));
    assert.ok(button, `no visible button labelled "${label}"`);
    button.click();
}
const press = (keyCode, type = "keydown", target = document) =>
    target.dispatchEvent(new window.KeyboardEvent(type, { keyCode, bubbles: true }));
// `value` set from a script updates no observable on its own; the binding listens for the
// event a keystroke would have raised.
function type_into(input, value) {
    input.value = value;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

// --- the landing screen -------------------------------------------------------------

assert.ok(shown(screen("landing")), "the page opens on the landing screen");
assert.ok(!shown(screen("names")), "and on nothing else");
assert.ok(!shown(screen("room")));
assert.ok(!shown(screen("play")));

// --- names: the keyboard is the form (#35) ------------------------------------------

click("Play offline");
await on("names");
assert.ok(!shown(screen("landing")), "one screen at a time");
const seats = () => all("li", screen("names"));
assert.equal(seats().length, 0, "nobody is on the couch yet");

press(38); // up arrow
await until("the first participant", () => seats().length === 1);
assert.equal(seats()[0].querySelector("input").value, "Dott", "who is given the first free bunny");
assert.equal(text(seats()[0].querySelector("small")), "Arrows", "under the scheme they pressed");

// A focused text field owns its keys: a W typed into a name is a W, not a second player
// (#35). This is the guard `is_typing` exists for, and only a real DOM has a target.
press(87, "keydown", seats()[0].querySelector("input"));
await sleep(20);
assert.equal(seats().length, 1, "a jump key typed into a name box adds nobody");

press(87); // W
await until("the second participant", () => seats().length === 2);
assert.equal(seats()[1].querySelector("input").value, "Jiffy");
assert.equal(text(seats()[1].querySelector("small")), "A D W");

press(87);
await sleep(20);
assert.equal(seats().length, 2, "and a scheme already on the couch cannot join twice");

press(73); // I
await until("the third participant", () => seats().length === 3);
seats()[2].querySelector("button").click();
await until("the third participant to be dropped", () => seats().length === 2);

// --- the lobby, offline (#16) --------------------------------------------------------

click("Take the seats");
await on("room");
assert.equal(text(screen("room").querySelector("h2")), "offline", "a local room has no code");
// What the row actually reads: a seat's ready label is bound away offline, and text
// content alone would count it anyway.
const lobby_rows = () =>
    all("li", screen("room")).map((row) =>
        all("span, small", row).filter(shown).map(text).join(" "),
    );
assert.deepEqual(
    lobby_rows(),
    ["Dott Dott Arrows", "Jiffy Jiffy A D W", "AI Fizz", "AI Miji"],
    "every seat in the room, the empty ones played by the AI (#36)",
);
assert.ok(
    !shown(screen("room").querySelector('button[data-bind*="toggle_ready"]')),
    "there is nobody offline to declare yourself ready to (#37)",
);
assert.ok(
    !shown(screen("room").querySelector('div[data-bind*="visible: room_id"]')),
    "and no link to share",
);

// --- the match and the board ---------------------------------------------------------

click("Start the match");
await on("play");
assert.ok(shown(screen("play")), "the top bar comes up with the canvas");
assert.ok(!shown(screen("room")), "and the lobby goes");
const overlay = document.querySelector("div.overlay");
assert.ok(!shown(overlay), "with no board over it");

press(80, "keyup"); // P, which is a keyup in this game
await until("the board", () => shown(overlay));
const board = all("tr", overlay).map((row) => all("th, td", row).map(text));
assert.deepEqual(
    board[0],
    ["", "Dott", "Jiffy", "Fizz", "Miji", "Total kills"],
    "the board names every seat, taken or not (#13)",
);
const board_rows = board.slice(1);
assert.equal(board_rows.length, 5, "four bunnies and the total");
assert.equal(board_rows[4][0], "Total deaths");
assert.ok(
    board_rows.every((row) => row.slice(1).every((cell) => /^\d+$/.test(cell))),
    "and every cell of it is a number",
);
// A row one cell short of the header is a hole in the table with no border around it,
// which is a rendered fault rather than an arithmetic one: `router.test.mjs` checks the
// view model's shape, and this checks that the cells are really there (#37).
assert.ok(
    board_rows.every((row) => row.length === board[0].length),
    "every row is as wide as the header, the totals row included",
);

press(80, "keyup");
await until("the board to go", () => !shown(overlay));

click("Back to the lobby");
await on("room");
assert.ok(
    shown(screen("room").querySelector('div[data-bind*="visible: board"]')),
    "the board of the match you just left is the lobby's, not a screen of its own (#13, #35)",
);

click("Leave");
await on("landing");

// --- the same walk, through a real relay (#34, #36) ----------------------------------

click("Create a room");
await on("create");
type_into(screen("create").querySelector("input"), "QMFTX");
click("Create");
// The relay answers with the room and no seats, so the flow asks who is playing.
await on("names");

press(38);
await until("the participant", () => seats().length === 1);
click("Take the seats");
// Seats are the relay's to grant, so the lobby is what the grant opens (#14).
await on("room");

assert.equal(text(screen("room").querySelector("h2")), "QMFTX", "the room wears its own code");
assert.equal(
    text(screen("room").querySelector("p.link")),
    origin + "/#QMFTX",
    "and the bare fragment is the only link it hands out (#8)",
);
assert.deepEqual(
    lobby_rows(),
    ["Dott not ready Dott Arrows", "AI ready Jiffy", "AI ready Fizz", "AI ready Miji"],
    "the relay's seat table: nobody holds an AI seat, so it keeps nobody waiting (#36, #37)",
);
const ready = screen("room").querySelector('button[data-bind*="toggle_ready"]');
assert.ok(shown(ready), "and online there is someone to be ready for");
assert.equal(text(ready), "Ready");

click("Ready");
await until("the room to hear it", () => text(ready) === "Not ready");
assert.ok(
    lobby_rows()[0].includes("ready") && !lobby_rows()[0].includes("not ready"),
    "which is the room's answer about that seat, not this client's own",
);

// A second client on the same relay, with no page of its own: the countdown is what the
// host's Start runs into when somebody in the room has not readied, and one browser cannot
// be two clients (#37).
const guest_saw = [];
const guest = new WebSocket_Transport(
    origin.replace("http", "ws") + "/ws",
    { type: "join", id: "QMFTX" },
    (msg) => guest_saw.push(msg),
    () => {},
);
await until("the guest to join", () => guest_saw.some((msg) => msg.type === "joined"));
guest.send({ type: "seats", names: ["Zip"] });
await until("the guest's seat to reach this page", () => lobby_rows()[1].startsWith("Zip"));
assert.deepEqual(
    lobby_rows(),
    ["Dott ready Dott Arrows", "Zip not ready Jiffy", "AI ready Fizz", "AI ready Miji"],
    "the lobby is the room's, so somebody else sitting down shows up here (#36)",
);

click("Start the match");
const countdown = screen("room").querySelector('p[data-bind*="visible: countdown"]');
await until("the countdown", () => shown(countdown));
assert.match(
    text(countdown),
    /^Starting in \d+s\./,
    "a room with somebody not ready in it counts down instead of starting (#21, #37)",
);
assert.ok(!shown(screen("play")), "and nothing starts while it runs");

click("Cancel the countdown");
await until("the countdown to go", () => !shown(countdown));
assert.equal(
    text(ready),
    "Not ready",
    "cancelling takes back the countdown and nothing else: ready resets on entering the lobby and on a staged change, not on seat churn (#21, #38)",
);
assert.deepEqual(
    lobby_rows(),
    ["Dott ready Dott Arrows", "Zip not ready Jiffy", "AI ready Fizz", "AI ready Miji"],
    "so the room reads exactly as it did before the countdown ran",
);

guest.close();
click("Leave");
await on("landing");
assert.ok(!shown(screen("room")), "and the room goes with it");

server.close();
console.log("OK the kiosk flow renders, the couch fills from the keyboard and the relay seats it");
process.exit(0);
