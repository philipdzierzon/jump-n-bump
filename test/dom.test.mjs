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

// The room settings panel (#38). Rows are found by their label, as a player finds them.
// `disabled` on the fieldset is what makes the whole panel read-only for everyone who is
// not the host, so that is the thing to assert rather than a binding per control.
const settings = () => all("fieldset", screen("room"))[0];
const password_panel = () => all("fieldset", screen("room"))[1];
const password_box = () => screen("room").querySelector('input[type="password"]');
const notice = () => text(screen("room").querySelector('p[data-bind*="text: notice"]'));
const banner = () => screen("room").querySelector("div.banner");
const level_select = () => screen("room").querySelector("select");
const level_options = () => all("option", level_select()).map((el) => el.value);
function config_row(label) {
    const row = all("label", screen("room")).find((el) => text(el) === label);
    assert.ok(row, `no settings row labelled "${label}"`);
    return row.querySelector('input[type="checkbox"]');
}
// Clicked rather than assigned: Knockout's `checked` binding listens for the click, so a
// checkbox whose property is set behind its back looks ticked and tells the view model
// nothing.
function tick(label, on = true) {
    const box = config_row(label);
    if (box.checked !== on) box.click();
}
function choose_level(name) {
    level_select().value = name;
    level_select().dispatchEvent(new window.Event("change", { bubbles: true }));
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

// --- room settings, offline: applied at once, because there is nobody to stage for -----

assert.ok(shown(settings()), "the lobby carries the room settings panel (#38)");
assert.equal(settings().disabled, false, "and offline you are the host, so it is yours");
assert.ok(!shown(banner()), "with nothing staged: a local room has nobody to keep waiting");
assert.ok(!shown(password_panel()), "and no password, which rooms have and tabs do not");
assert.equal(level_options()[0], "default", "the picker opens on the built-in map");
assert.ok(
    level_options().includes("caves") && !level_options().includes("a file of your own"),
    "and offers the levels shipped beside the page, but no file of your own until one is loaded",
);

tick("No gore");
click("Apply to the next match");
assert.ok(
    !shown(banner()),
    "a local room applies the change rather than staging it: no restart to wait for (#16, #38)",
);
tick("No gore", false);
click("Apply to the next match");

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

// A second match, left without ever opening the overlay: the board is counted when the
// match is left, not only while P is held up, or the lobby draws the empty matrix the
// session starts life with -- two rows of one cell under a five-column header (#13).
click("Start the match");
await on("play");
click("Back to the lobby");
await on("room");
const last = all("tr", screen("room").querySelector('div[data-bind*="visible: board"]')).map(
    (row) => all("th, td", row).map(text),
);
assert.deepEqual(
    last[0],
    ["", "Dott", "Jiffy", "Fizz", "Miji", "Total kills"],
    "the lobby's last-match board names every seat",
);
assert.equal(last.length, 6, "the header, four bunnies and the totals row");
assert.ok(
    last.slice(1).every((row) => row.length === last[0].length),
    "and every row of it is as wide as the header, with no cell missing",
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

// --- room settings, online: staged for the next match, and a write-only password (#38) -

assert.equal(settings().disabled, false, "the host owns the panel");
assert.ok(shown(password_panel()), "and online a room is a thing that can carry a password");
assert.ok(
    !level_options().includes("a file of your own"),
    "a level loaded from disk is never offered online: nobody else could fetch it",
);

assert.equal(text(ready), "Not ready", "this client is ready going in");
assert.ok(!shown(banner()), "and nothing is announced while nothing is staged");
choose_level("caves");
tick("No gore");
click("Apply to the next match");
await until("the staged change", () => shown(banner()));
assert.equal(
    text(banner()),
    "Host staged: Level \u2192 caves, No gore \u2192 on. Everyone\u2019s ready was cleared and " +
        "the countdown stopped. It applies when the next match starts.",
    "the banner names the diff and what it did: cleared checkboxes alone read as a bug (#10)",
);
assert.equal(text(ready), "Ready", "and everyone's ready really was cleared (#37)");
const staged_seen = guest_saw.filter((msg) => msg.type === "room" && msg.staged).pop();
assert.deepEqual(
    staged_seen.staged,
    { level: "caves", no_gore: true },
    "the diff is the room's, so the other client in it is told the same thing",
);
assert.equal(staged_seen.you_ready, false, "and its ready went with everyone else's");

click("Ready");
await until("the room to hear it", () => text(ready) === "Not ready");
choose_level("caves");
click("Apply to the next match");
await sleep(50);
assert.equal(text(ready), "Not ready", "re-staging what is already staged clears nobody's ready");

// Write-only: nothing ever sends it back, so this is a blind replacement (#8).
type_into(password_box(), "hunter2");
click("Set it now");
await until("the confirmation", () => notice());
assert.equal(notice(), "Password set.", "the host is told it took, never shown the password");
assert.equal(password_box().value, "", "and the box empties rather than sitting there holding it");

const barred_saw = [];
const barred = new WebSocket_Transport(
    origin.replace("http", "ws") + "/ws",
    { type: "join", id: "QMFTX" },
    (msg) => barred_saw.push(msg),
    (code) => barred_saw.push({ type: "error", code }),
);
await until("the refusal", () => barred_saw.some((msg) => msg.type === "error"));
assert.equal(
    barred_saw.find((msg) => msg.type === "error").code,
    "ROOM_UNAVAILABLE",
    "the password the host set guards the door from the moment it lands, not at the next match",
);
assert.ok(
    !JSON.stringify(guest_saw).includes("hunter2"),
    "and nothing any client in the room was ever sent carries it",
);

type_into(password_box(), "");
click("Set it now");
await until("the removal", () => notice() === "Password removed.");
const walk_in_saw = [];
const walk_in = new WebSocket_Transport(
    origin.replace("http", "ws") + "/ws",
    { type: "join", id: "QMFTX" },
    (msg) => walk_in_saw.push(msg),
    () => {},
);
await until("the walk-in", () => walk_in_saw.some((msg) => msg.type === "joined"));
walk_in.close();

guest.close();
click("Leave");
await on("landing");
assert.ok(!shown(screen("room")), "and the room goes with it");

// --- the same lobby, from a client that does not host it (#10, #38) -------------------
// Everything above ran as the host, because the page created the room. Here somebody else
// holds it, which is the half of the panel a host can never see for itself: read-only, and
// a banner that arrives rather than one this client caused.

const chief_saw = [];
const chief = new WebSocket_Transport(
    origin.replace("http", "ws") + "/ws",
    { type: "create", id: "KFTVW" },
    (msg) => chief_saw.push(msg),
    () => {},
);
await until("the room", () => chief_saw.some((msg) => msg.type === "joined"));
chief.send({ type: "seats", names: ["Chief"] });
await until("the host to sit down", () => chief_saw.some((msg) => msg.type === "room" && msg.host));

click("Join with a room code");
await on("join");
type_into(screen("join").querySelector("input"), "KFTVW");
click("Continue");
await on("names");
press(38);
await until("the participant", () => seats().length === 1);
click("Take the seats");
await on("room");

assert.ok(
    !shown(screen("room").querySelector('button[data-bind*="start_match"]')),
    "a guest is not offered the match to start",
);
assert.equal(settings().disabled, true, "and the settings panel is the host's to change");
assert.equal(
    password_panel().disabled,
    true,
    "the password with it: it is set blind by whoever holds the room, not by whoever joined",
);
assert.equal(
    level_select().value,
    "default",
    "the panel still reads the room's config, which is the point of showing it at all",
);

chief.send({ type: "config", config: { level: "green", ai_fill: false } });
await until("the host's staged change", () => text(banner()).startsWith("Host staged"));
assert.equal(
    text(banner()),
    "Host staged: Level \u2192 green, AI on the empty seats \u2192 off. Everyone\u2019s ready " +
        "was cleared and the countdown stopped. It applies when the next match starts.",
    "everyone in the room is told what the host staged, not the host alone (#10)",
);
assert.equal(
    level_select().value,
    "green",
    "and the read-only panel follows it, so the banner and the rows never disagree",
);

chief.close();
click("Leave");
await on("landing");

server.close();
console.log("OK the kiosk flow renders, the couch fills from the keyboard and the relay seats it");
process.exit(0);
