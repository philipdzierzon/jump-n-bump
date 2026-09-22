// The kiosk flow against a real browser (#35, #36, #37): the page is the built client, the
// bindings are Knockout's own, and Chromium renders it -- so the markup, the flow and the
// layout are under test together, which is the trio that opening the page was the only way
// to check.
//
// This replaces the jsdom walk it was ported from. jsdom had no 2d context, no media
// playback and no layout, and papered over the first two. Four differences from that port,
// each one something jsdom got wrong or could not do:
//
//   - The room settings live in a collapsed `<details>`. jsdom does not collapse one, so the
//     old walk asserted on controls a player cannot reach at all; here the panel is opened
//     by clicking its summary, as a player has to.
//   - Every click is also a layout assertion. Playwright refuses an element that is
//     invisible, zero-sized, covered, still moving or disabled, which is most of what a
//     rendered page gets wrong and none of what jsdom could tell you.
//   - The play screen is two divs, the top bar and the canvas, so `screen()` takes the
//     first of them exactly as `document.querySelector` did.
//   - A match that ends by itself runs on a fake clock, on a page of its own. The bundle
//     exposes no module to reach into, so the old walk's `player[1].bumps = 3` from node has
//     no browser equivalent; the one-minute time limit is fast-forwarded instead, in no real
//     time at all, which drives the same ending through the real UI. That the simulation
//     reaches a limit at all is `replay.test.mjs`'s, and the wording of the line above the
//     board is `router.test.mjs`'s.
//
// And three things a browser gives that only a person could check before (#66): two pages
// in one room, agreeing on it; the sound, decoded and played and recorded event by event,
// on the mp3 path jsdom's empty `canPlayType` could never take; and the page at phone
// width, with nothing running off the side of it.
//
// Run by `npm test`, which builds the client first because a browser needs the built one.
// With `JNB_BASE_URL` set the walk runs against that origin instead of booting a server,
// which is how CI points it at the running container. A failure leaves a trace behind.
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { start_server } from "../server/index.js";
import { WebSocket_Transport } from "../src/net/websocket_transport.js";
import { generate_room_id } from "../src/net/room_id.js";
import { FLOW_TEXT } from "../src/interaction/router.js";
import { SNAPSHOT_INTS, decode_snapshot, encode_snapshot } from "../src/game/snapshot.js";

// Boots its own server unless CI handed us one, exactly as `server/smoke.mjs` does.
const given = process.env.JNB_BASE_URL;
const server = given ? null : await start_server(0);
const origin = given ? given.replace(/\/$/, "") : "http://localhost:" + server.address().port;
// Generated rather than fixed, so the walk can be run twice against one long-lived
// container without the second run colliding with the first run's rooms.
const taken_room_ids = {};
const new_room_id = () => {
    const id = generate_room_id(taken_room_ids);
    taken_room_ids[id] = true;
    return id;
};
const room_a = new_room_id();
const room_b = new_room_id();
const room_c = new_room_id();
const room_d = new_room_id();
const room_e = new_room_id();
const room_f = new_room_id();
const room_g = new_room_id();
const room_h = new_room_id();
const room_i = new_room_id();
const room_j = new_room_id();
const room_k = new_room_id();
const room_l = new_room_id();
const room_m = new_room_id();
const room_n = new_room_id();
const room_o = new_room_id();

// No launch flags: Chromium needs no `--no-sandbox` here, and headless Chrome autoplays
// without being asked to, so a flag would only move the test further from a real browser.
const browser = await chromium.launch();

// Every <audio> the page plays, in the order it played them, and whether it is still
// playing. Sound_Player creates them and keeps them to itself -- they are never in the
// document -- so patching the prototype is the only way to see them from out here. A session
// builds one Sound_Player, so a match being played sounds one looping track and a match
// that is over sounds none; two loops at once was a session left running behind the one on
// screen, which is how it was heard (#28, #40). The ordered list is the other half: a set
// says a sound was played at some point, and an order says which event played it (#66).
function record_audio() {
    window.__audio = new Set();
    window.__sounds = [];
    // Counted as they are made rather than as they are played: a leaked <audio> is one that
    // nothing plays again, and Sound_Player keeps them out of the document, so there is
    // nothing to querySelectorAll for (#91).
    // ponytail: this counts elements made, not elements still alive -- it proves a repair
    // makes none, which is the fix, rather than that a made one was freed. upgrade path: a
    // heap snapshot through CDP if a leak ever survives this.
    window.__audio_made = 0;
    const create = document.createElement.bind(document);
    document.createElement = function (tag) {
        if (String(tag).toLowerCase() === "audio") window.__audio_made++;
        return create.apply(null, arguments);
    };
    window.__sounding = () =>
        [...window.__audio]
            .filter((audio) => !audio.paused)
            .map((audio) => audio.src.split("/").pop() + (audio.loop ? " (loop)" : ""));
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        window.__audio.add(this);
        window.__sounds.push(this.src.split("/").pop());
        return play.apply(this, arguments);
    };
}

// A context is a browser of its own, storage included, which is what makes two of them two
// players rather than two tabs of one (#66). Each one is traced, and a failure writes out
// every trace there is: the page that broke is not always the page being walked.
const contexts = [];
async function make_context(name, options) {
    const made = await browser.newContext(options);
    await made.tracing.start({ screenshots: true, snapshots: true });
    await made.addInitScript(record_audio);
    // Every route the page took, recorded in the page because the flow is a hash router: a
    // screen that never appeared is nearly always a route that was taken and then taken back.
    await made.addInitScript(() => {
        window.__routes = [];
        // See the `hashes` helper below for why this exists beside `__routes`.
        window.__hashes = [];
        window.addEventListener("hashchange", () => window.__hashes.push(location.hash));
        window.addEventListener("hashchange", () =>
            setTimeout(
                () =>
                    window.__routes.push(
                        location.hash +
                            " shown=" +
                            [...document.querySelectorAll('div[data-bind*="screen() ==="]')]
                                .filter((el) => el.offsetParent !== null)
                                .map((el) => el.getAttribute("data-bind").match(/'(\w+)'/)[1])
                                .join(",") +
                            " participants=" +
                            document.querySelectorAll("div[data-bind*=\"screen() === 'names'\"] li")
                                .length,
                    ),
                0,
            ),
        );
    });
    // A real mouse click reports `detail >= 1`; a button activated by Enter or Space reports
    // 0. This is what keeps the keyboard-only walk a keyboard walk after somebody edits it
    // (#90).
    await made.addInitScript(() => {
        window.__mouse = 0;
        addEventListener("click", (event) => event.detail > 0 && window.__mouse++, true);
    });
    contexts.push([name, made]);
    return made;
}

const context = await make_context("flow");
const page = await context.newPage();
const page_errors = [];
page.on("pageerror", (error) => page_errors.push(error.message));
// AC4 (#92): the tick a resumed snapshot was packed on, against the tick it arrived with.
const console_lines = [];
page.on("console", (msg) => console_lines.push(msg.text()));
// What the relay told this page, kept for a failure to print. A flow driven by a socket is
// unreadable from the DOM alone: the screen it ended on says what happened, and this says
// which message did it.
const frames = [];
let sockets = 0;
page.on("websocket", (ws) => {
    const n = ++sockets;
    ws.on("framereceived", ({ payload }) =>
        frames.push(`s${n} <- ` + String(payload).slice(0, 200)),
    );
    ws.on("framesent", ({ payload }) => frames.push(`s${n} -> ` + String(payload).slice(0, 200)));
    ws.on("close", () => frames.push(`s${n} closed`));
});

// --- helpers ---------------------------------------------------------------------------

const escape_re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exact = (label) => new RegExp("^\\s*" + escape_re(label) + "\\s*$");
const squash = (s) => s.replace(/\s+/g, " ").trim();
const text = async (loc) => squash((await loc.textContent()) || "");

// Screens are told apart by the binding that shows them, which is also how the markup names
// them. `.first()` mirrors `document.querySelector`: only 'play' is two divs.
const screen = (name, root = page) =>
    root.locator(`div[data-bind*="screen() === '${name}'"]`).first();
// Buttons are found by their label, as a player finds them: a hidden screen's button is not
// a button you can press, and three screens share the label "Create a room".
const button = (label, root = page) =>
    root
        .locator("button:visible")
        .filter({ hasText: exact(label) })
        .first();
const click = (label, root = page) => button(label, root).click();

// Hash navigation, socket round trips and Knockout's own updates all settle a turn or two
// later, so every step waits for what it asked for rather than for a fixed delay.
async function until(what, ready) {
    for (let i = 0; i < 200; i++) {
        if (await ready()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail("timed out waiting for " + what);
}
// The one place a fixed wait is the right tool: proving that something did *not* happen.
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function on(name, root = page) {
    await screen(name, root).waitFor({ state: "visible" });
    await root.waitForFunction((n) => window.location.hash === "#" + n, name);
}

const hash = (root = page) => root.evaluate(() => window.location.hash);
// Synchronous, unlike `__routes`: `apply_route` can replace the hash again before
// `__routes`'s `setTimeout` push runs (a bounce), so that push always reads the hash
// *after* the bounce, for both entries. This one lands in the same task as the
// `hashchange` that caused it, which is what a bounce-count gate needs (#87).
const hashes = (root = page) => root.evaluate(() => window.__hashes || []);
const routes = (root = page) => root.evaluate(() => window.__routes || []);
// The most recent `room` message a socket has seen, which is the relay's own answer to
// "what does the room look like now" -- read instead of the DOM wherever the claim is about
// the room rather than about what got painted.
const last_room = (seen) => seen.filter((msg) => msg.type === "room").pop();

const sounding = (root = page) => root.evaluate(() => window.__sounding());
// Every sound played since the list was last forgotten, in the order it was played (#66).
const sounds = (root = page) => root.evaluate(() => window.__sounds);
const forget_sounds = (root = page) => root.evaluate(() => (window.__sounds.length = 0));
// Every <audio> this page has made, leaked ones included: six per Sound_Player plus the one
// `canPlayType` is probed on (#91).
const audio_made = (root = page) => root.evaluate(() => window.__audio_made);
// The music as the element itself. Playing a file is one thing; decoding 54.8 seconds of
// mp3 and moving through them is the thing a recorder cannot see (#66).
const music = (root = page) =>
    root.evaluate(() => {
        const audio = [...window.__audio].find((a) => /bump\.\w+$/.test(a.src));
        // An empty object rather than nothing for a track that has never played: every
        // caller reads a field off this, and a `TypeError` thrown out of a poll would
        // replace the timeout that says which wait it was.
        return audio
            ? {
                  paused: audio.paused,
                  loop: audio.loop,
                  t: audio.currentTime,
                  seconds: audio.duration,
              }
            : {};
    });

// How far into the track this session is. `music` takes the first element it finds, which
// on a page that has walked through several sessions is an old one, paused where its match
// left it; the one playing now is the newest. Zero for a track that never played, so a poll
// on this times out on its own wait rather than on a `TypeError` (#91).
const music_t = (root = page) =>
    root.evaluate(
        () => [...window.__audio].filter((a) => /bump\.\w+$/.test(a.src)).pop()?.currentTime ?? 0,
    );

// On a fake clock, waiting means winding the simulation on rather than sitting through it:
// a sound the AI causes lands on the tick it lands on, and which tick that is belongs to
// the seed (#66).
// ponytail: an event no seed produces inside the ceiling fails as a timeout rather than as
// itself. upgrade path: a seeded offline room, if the client is ever given one.
async function wind_until(root, what, ready, ms = 1000, limit = 90) {
    for (let i = 0; i < limit; i++) {
        if (await ready()) return;
        await root.clock.fastForward(ms);
    }
    // The last wind is worth a look of its own, or an event landing inside it is reported
    // as never having landed at all.
    if (await ready()) return;
    assert.fail("timed out winding for " + what);
}

const seats = (root = page) => screen("names", root).locator("li");
const overlay = (root = page) => root.locator("div.overlay");
const chrome = (root = page) =>
    screen("play", root)
        .locator("li")
        .evaluateAll((els) =>
            els.map((el) => el.textContent.replace(/\s+/g, " ").trim()).filter(Boolean),
        );

// What a lobby row actually reads: a seat's ready label is bound away offline, and text
// content alone would count it anyway.
const lobby_rows = (root = page) =>
    screen("room", root)
        .locator("li")
        .evaluateAll((rows) =>
            rows.map((row) =>
                [...row.querySelectorAll("span, small")]
                    .filter((el) => getComputedStyle(el).display !== "none")
                    .map((el) => el.textContent.replace(/\s+/g, " ").trim())
                    .join(" "),
            ),
        );

// What every client in a room can see of it: who is on which bunny, and whether they are
// ready. The scheme column is left out on purpose -- it is the one cell that is local,
// since a client is shown the keys for the seats it drives and for nobody else's (#66).
const room_view = (root = page) =>
    screen("room", root)
        .locator("li")
        .evaluateAll((rows) =>
            rows.map((row) => [
                row.querySelector("span.grow").textContent.trim(),
                ...[...row.querySelectorAll("small")]
                    .slice(0, 2)
                    .map((el) => el.textContent.trim()),
            ]),
        );

const grid = (root) =>
    root
        .locator("tr")
        .evaluateAll((rows) =>
            rows.map((row) =>
                [...row.querySelectorAll("th, td")].map((el) =>
                    el.textContent.replace(/\s+/g, " ").trim(),
                ),
            ),
        );
const head = (root) =>
    root
        .locator("tr")
        .first()
        .locator("th")
        .evaluateAll((els) => els.map((el) => el.getAttribute("title")));

// The room settings panel (#38). It is a `<details>`, so nothing in it is reachable until
// the summary is clicked -- which is the whole difference between a rendered page and a
// parsed one. Idempotent, because the room screen survives every screen change.
async function open_settings(root = page) {
    const details = screen("room", root).locator("details");
    if (!(await details.evaluate((el) => el.open)))
        await screen("room", root).locator("summary").click();
}
const settings = (root = page) => screen("room", root).locator("fieldset").first();
const password_panel = (root = page) => screen("room", root).locator("fieldset").nth(1);
const password_box = (root = page) => screen("room", root).locator('input[type="password"]');
const notice = (root = page) => text(screen("room", root).locator('p[data-bind*="text: notice"]'));
// The error line of whichever screen is being asked about. Every screen carries one now,
// and `text` squashes it, so this reads the same on all seven (#88).
const err_on = (name, root = page) => text(screen(name, root).locator("p.err"));
const banner = (root = page) => screen("room", root).locator("div.banner");
const board_panel = (root = page) =>
    screen("room", root).locator('div[data-bind*="visible: board"]');
const level_select = (root = page) => screen("room", root).locator("select");
const level_options = (root = page) =>
    level_select(root)
        .locator("option")
        .evaluateAll((els) => els.map((el) => el.value));
const disabled = (loc) => loc.evaluate((el) => el.disabled);

// Rows are found by their label, as a player finds them.
const config_row = (label, kind, root = page) =>
    screen("room", root)
        .locator("label")
        .filter({ hasText: exact(label) })
        .locator(`input[type="${kind}"]`);
// `setChecked` clicks only when the box is not already where it should be, and Knockout's
// `checked` binding listens for that click: a box whose property is set behind its back
// looks ticked and tells the view model nothing.
const tick = (label, on = true, root = page) => config_row(label, "checkbox", root).setChecked(on);

const relay_client = (entry, seen) =>
    new WebSocket_Transport(
        origin.replace(/^http/, "ws") + "/ws",
        entry,
        (msg) => seen.push(msg),
        (code) => seen.push({ type: "error", code }),
    );

// What the next key would go to. `BODY` is the bug (#90): a screen change that leaves focus
// on the document makes a keyboard player tab down from the top of the page again.
const focused = (root = page) =>
    root.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "BODY";
        const name = el.tagName + (el.className ? "." + el.className.split(" ")[0] : "");
        // A button by its label, an input by its type: what a player would call the thing
        // they are about to press or type into.
        if (el.tagName === "BUTTON" || el.tagName === "SUMMARY")
            return name + ":" + el.textContent.replace(/\s+/g, " ").trim();
        return el.tagName === "INPUT" ? name + ":" + el.type : name;
    });
// Tab until the label has focus, which is the reach assertion itself: a control no number of
// Tabs arrives at is a control the flow cannot be driven to.
async function tab_to(label, root = page, key = "Tab") {
    for (let i = 0; i < 30; i++) {
        if ((await focused(root)).endsWith(label)) return;
        await root.keyboard.press(key);
    }
    assert.fail(key + " 30 times never reached " + label + ", stopped on " + (await focused(root)));
}

// Every hash a page reported to the relay, keyed by the tick it names (#41, #96). No client
// hook needed: `framesent` is a wire read, same technique as the frame recorder above --
// every socket the page opens, a reconnect included.
function record_checksums(root) {
    const hashes = new Map();
    root.on("websocket", (ws) =>
        ws.on("framesent", ({ payload }) => {
            const text = String(payload);
            if (!text.includes('"checksum"')) return;
            const msg = JSON.parse(text);
            // First hash wins: a second match in the same room counts from 0 again, so
            // tick 30 names two different states. Keeps the map to the first match.
            if (msg.type === "checksum" && !hashes.has(msg.t)) hashes.set(msg.t, msg.h);
        }),
    );
    return hashes;
}

// Paired by tick, never by wall clock -- two pages, two 60Hz clocks, never on the same tick
// at the same instant. `from` floor: pass 1 to drop tick 0, which both pages hash before any
// `game_iteration`, same seed, same level -- agrees for free, not a real sample.
const paired = (a, b, from = 0) =>
    [...a.keys()].filter((t) => t >= from && b.has(t)).sort((x, y) => x - y);
const disagreements = (a, b, from = 0) => paired(a, b, from).filter((t) => a.get(t) !== b.get(t));

// --- the walk --------------------------------------------------------------------------

async function walk() {
    await page.goto(origin + "/");

    // --- the landing screen -----------------------------------------------------------

    assert.ok(await screen("landing").isVisible(), "the page opens on the landing screen");
    assert.ok(!(await screen("names").isVisible()), "and on nothing else");
    assert.ok(!(await screen("room").isVisible()));
    assert.ok(!(await screen("play").isVisible()));

    // --- names: the keyboard is the form (#35) ----------------------------------------

    await click("Play offline");
    await on("names");
    assert.ok(!(await screen("landing").isVisible()), "one screen at a time");
    assert.equal(await seats().count(), 0, "nobody is on the couch yet");

    await page.keyboard.press("ArrowUp");
    await until("the first participant", async () => (await seats().count()) === 1);
    assert.equal(
        await seats().nth(0).locator("input").inputValue(),
        "Dott",
        "who is given the first free bunny",
    );
    assert.equal(
        await text(seats().nth(0).locator("small")),
        "Arrows",
        "under the scheme they pressed",
    );

    // A focused text field owns its keys: a W typed into a name is a W, not a second player
    // (#35). This is the guard `is_typing` exists for. In a real browser the W really does
    // land in the box, which is the half jsdom could not show: it dispatched a bare keydown.
    await seats().nth(0).locator("input").press("w");
    await settle();
    assert.equal(await seats().count(), 1, "a jump key typed into a name box adds nobody");
    assert.notEqual(
        await seats().nth(0).locator("input").inputValue(),
        "Dott",
        "it goes into the name, which is where it was typed",
    );
    await seats().nth(0).locator("input").fill("Dott");
    // Clicked away from before the next player joins, because the couch listens on the
    // document and a focused box keeps the keys. jsdom never needed this: it dispatched at
    // the document whatever had focus, so it could not tell the two cases apart.
    await seats().nth(0).locator("input").blur();

    await page.keyboard.press("w");
    await until("the second participant", async () => (await seats().count()) === 2);
    assert.equal(await seats().nth(1).locator("input").inputValue(), "Jiffy");
    assert.equal(await text(seats().nth(1).locator("small")), "A D W");

    await page.keyboard.press("w");
    await settle();
    assert.equal(await seats().count(), 2, "and a scheme already on the couch cannot join twice");

    await page.keyboard.press("i");
    await until("the third participant", async () => (await seats().count()) === 3);
    await seats().nth(2).locator("button").click();
    await until("the third participant to be dropped", async () => (await seats().count()) === 2);

    // --- the lobby, offline (#16) -----------------------------------------------------

    await click("Take the seats");
    await on("room");
    assert.equal(await text(screen("room").locator("h2")), "offline", "a local room has no code");
    assert.deepEqual(
        await lobby_rows(),
        ["Dott Dott Arrows", "Jiffy Jiffy A D W", "AI Fizz", "AI Miji"],
        "every seat in the room, the empty ones played by the AI (#36)",
    );
    assert.ok(
        !(await screen("room").locator('button[data-bind*="toggle_ready"]').isVisible()),
        "there is nobody offline to declare yourself ready to (#37)",
    );
    assert.ok(
        !(await screen("room").locator('div[data-bind*="visible: room_id"]').isVisible()),
        "and no link to share",
    );

    // --- room settings, offline: applied at once, because there is nobody to stage for --

    await open_settings();
    assert.ok(await settings().isVisible(), "the lobby carries the room settings panel (#38)");
    assert.equal(await disabled(settings()), false, "and offline you are the host, so it is yours");
    assert.ok(
        !(await banner().isVisible()),
        "with nothing staged: a local room has nobody to keep waiting",
    );
    assert.ok(
        !(await password_panel().isVisible()),
        "and no password, which rooms have and tabs do not",
    );
    assert.equal((await level_options())[0], "default", "the picker opens on the built-in map");
    const offline_levels = await level_options();
    assert.ok(
        offline_levels.includes("caves") && !offline_levels.includes("a file of your own"),
        "and offers the levels shipped beside the page, but no file of your own until one is loaded",
    );

    await tick("No gore");
    await click("Apply to the next match");
    assert.ok(
        !(await banner().isVisible()),
        "a local room applies the change rather than staging it: no restart to wait for (#16, #38)",
    );
    await tick("No gore", false);
    await click("Apply to the next match");

    // --- the match and the board ------------------------------------------------------

    await click("Start the match");
    await on("play");
    assert.ok(await screen("play").isVisible(), "the top bar comes up with the canvas");
    assert.ok(!(await screen("room").isVisible()), "and the lobby goes");
    assert.ok(!(await overlay().isVisible()), "with no board over it");

    await page.keyboard.press("p"); // P, which is a keyup in this game
    await until("the board", () => overlay().isVisible());
    assert.deepEqual(
        await head(overlay()),
        ["", "Dott", "Jiffy", "Fizz", "Miji", "Total kills"],
        "the board names every seat, taken or not (#13)",
    );
    assert.equal(
        await overlay().locator("tr").first().locator("span.swatch").count(),
        4,
        "and heads the four seat columns with the bunnies' colours rather than their names, " +
            "which is what fits six columns on a phone (#39)",
    );
    const board = await grid(overlay());
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

    await page.keyboard.press("p");
    await until("the board to go", async () => !(await overlay().isVisible()));

    await click("Back to the lobby");
    await on("room");
    assert.ok(
        await board_panel().isVisible(),
        "the board of the match you just left is the lobby's, not a screen of its own (#13, #35)",
    );

    // A second match, left without ever opening the overlay: the board is counted when the
    // match is left, not only while P is held up, or the lobby draws the empty matrix the
    // session starts life with -- two rows of one cell under a five-column header (#13).
    await click("Start the match");
    await on("play");
    await click("Back to the lobby");
    await on("room");
    const last = await grid(board_panel());
    assert.deepEqual(
        await head(board_panel()),
        ["", "Dott", "Jiffy", "Fizz", "Miji", "Total kills"],
        "the lobby's last-match board names every seat",
    );
    assert.equal(
        await text(board_panel().locator("p.banner")),
        "The host ended the match.",
        "with one line above it saying how it ended, and no end-of-match screen (#39)",
    );
    assert.equal(last.length, 6, "the header, four bunnies and the totals row");
    assert.ok(
        last.slice(1).every((row) => row.length === last[0].length),
        "and every row of it is as wide as the header, with no cell missing",
    );

    // --- the two match-end knobs in the top bar (#39) ---------------------------------
    // Both default to 0 -- endless, which is what every match above ran on and what the game
    // has always done. The ending itself is `self_ending_match()` below, on its own clock.
    await open_settings();
    assert.equal(
        await config_row("Bumps to win", "number").inputValue(),
        "0",
        "a room is endless until somebody says so",
    );
    assert.equal(await config_row("Minutes", "number").inputValue(), "0");
    await config_row("Bumps to win", "number").fill("3");
    await config_row("Minutes", "number").fill("1");
    await click("Apply to the next match");

    await click("Start the match");
    await on("play");
    await until("the clock", async () => (await chrome()).some((item) => /^\d+:\d\d$/.test(item)));
    assert.ok(
        (await chrome()).includes("3 to win"),
        "the clock and the target live in the top bar: no wire bytes and no canvas pixels (#39)",
    );

    await click("Back to the lobby");
    await on("room");
    await open_settings();
    await config_row("Bumps to win", "number").fill("0");
    await config_row("Minutes", "number").fill("0");
    await click("Apply to the next match");
    assert.ok(
        !(await chrome()).some((item) => /^\d+:\d\d$/.test(item)),
        "and the clock goes with the match it was counting",
    );

    await click("Leave");
    await on("landing");

    // --- the same walk, through a real relay (#34, #36) -------------------------------

    await click("Create a room");
    await on("create");
    await screen("create").locator("input.code").fill(room_a);
    await click("Create");
    // The relay answers with the room and no seats, so the flow asks who is playing.
    await on("names");

    await page.keyboard.press("ArrowUp");
    await until("the participant", async () => (await seats().count()) === 1);
    await click("Take the seats");
    // Seats are the relay's to grant, so the lobby is what the grant opens (#14).
    await on("room");

    assert.equal(await text(screen("room").locator("h2")), room_a, "the room wears its own code");
    assert.equal(
        await text(screen("room").locator("p.link")),
        origin + "/#" + room_a,
        "and the bare fragment is the only link it hands out (#8)",
    );
    assert.deepEqual(
        await lobby_rows(),
        ["Dott not ready Dott Arrows", "AI ready Jiffy", "AI ready Fizz", "AI ready Miji"],
        "the relay's seat table: nobody holds an AI seat, so it keeps nobody waiting (#36, #37)",
    );
    const ready = screen("room").locator('button[data-bind*="toggle_ready"]');
    assert.ok(await ready.isVisible(), "and online there is someone to be ready for");
    assert.equal(await text(ready), "Ready");

    await click("Ready");
    await until("the room to hear it", async () => (await text(ready)) === "Not ready");
    const first_row = (await lobby_rows())[0];
    assert.ok(
        first_row.includes("ready") && !first_row.includes("not ready"),
        "which is the room's answer about that seat, not this client's own",
    );

    // A second client on the same relay, with no page of its own: the countdown is what the
    // host's Start runs into when somebody in the room has not readied. A page each is #66's.
    const guest_saw = [];
    const guest = relay_client({ type: "join", id: room_a }, guest_saw);
    await until("the guest to join", () => guest_saw.some((msg) => msg.type === "joined"));
    guest.send({ type: "seats", names: ["Zip"] });
    await until("the guest's seat to reach this page", async () =>
        (await lobby_rows())[1].startsWith("Zip"),
    );
    assert.deepEqual(
        await lobby_rows(),
        ["Dott ready Dott Arrows", "Zip not ready Jiffy", "AI ready Fizz", "AI ready Miji"],
        "the lobby is the room's, so somebody else sitting down shows up here (#36)",
    );

    await click("Start the match");
    const countdown = screen("room").locator('p[data-bind*="visible: countdown"]');
    await until("the countdown", () => countdown.isVisible());
    assert.match(
        await text(countdown),
        /^Starting in \d+s\./,
        "a room with somebody not ready in it counts down instead of starting (#21, #37)",
    );
    assert.ok(!(await screen("play").isVisible()), "and nothing starts while it runs");

    await click("Cancel the countdown");
    await until("the countdown to go", async () => !(await countdown.isVisible()));
    assert.equal(
        await text(ready),
        "Not ready",
        "cancelling takes back the countdown and nothing else: ready resets on entering the " +
            "lobby and on a staged change, not on seat churn (#21, #38)",
    );
    assert.deepEqual(
        await lobby_rows(),
        ["Dott ready Dott Arrows", "Zip not ready Jiffy", "AI ready Fizz", "AI ready Miji"],
        "so the room reads exactly as it did before the countdown ran",
    );

    // --- room settings, online: staged for the next match, and a write-only password ---

    await open_settings();
    assert.equal(await disabled(settings()), false, "the host owns the panel");
    assert.ok(
        await password_panel().isVisible(),
        "and online a room is a thing that can carry a password",
    );
    assert.ok(
        !(await level_options()).includes("a file of your own"),
        "a level loaded from disk is never offered online: nobody else could fetch it",
    );

    assert.equal(await text(ready), "Not ready", "this client is ready going in");
    assert.ok(!(await banner().isVisible()), "and nothing is announced while nothing is staged");
    await level_select().selectOption("caves");
    await tick("No gore");
    await click("Apply to the next match");
    await until("the staged change", () => banner().isVisible());
    assert.equal(
        await text(banner()),
        "Host staged: Level → caves, No gore → on. Everyone’s ready was cleared and " +
            "the countdown stopped. It applies when the next match starts.",
        "the banner names the diff and what it did: cleared checkboxes alone read as a bug (#10)",
    );
    assert.equal(await text(ready), "Ready", "and everyone's ready really was cleared (#37)");
    const staged_seen = guest_saw.filter((msg) => msg.type === "room" && msg.staged).pop();
    assert.deepEqual(
        staged_seen.staged,
        { level: "caves", no_gore: true },
        "the diff is the room's, so the other client in it is told the same thing",
    );
    assert.equal(staged_seen.you_ready, false, "and its ready went with everyone else's");

    await click("Ready");
    await until("the room to hear it", async () => (await text(ready)) === "Not ready");
    await level_select().selectOption("caves");
    await click("Apply to the next match");
    await settle();
    assert.equal(
        await text(ready),
        "Not ready",
        "re-staging what is already staged clears nobody's ready",
    );

    // Write-only: nothing ever sends it back, so this is a blind replacement (#8).
    await password_box().fill("hunter2");
    await click("Set it now");
    await until("the confirmation", async () => (await notice()) !== "");
    assert.equal(
        await notice(),
        "Password set.",
        "the host is told it took, never shown the password",
    );
    assert.equal(
        await password_box().inputValue(),
        "",
        "and the box empties rather than sitting there holding it",
    );

    const barred_saw = [];
    relay_client({ type: "join", id: room_a }, barred_saw);
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

    await password_box().fill("");
    await click("Set it now");
    await until("the removal", async () => (await notice()) === "Password removed.");
    const walk_in_saw = [];
    const walk_in = relay_client({ type: "join", id: room_a }, walk_in_saw);
    await until("the walk-in", () => walk_in_saw.some((msg) => msg.type === "joined"));
    walk_in.close();

    guest.close();
    await click("Leave");
    await on("landing");
    assert.ok(!(await screen("room").isVisible()), "and the room goes with it");

    // --- the same lobby, from a client that does not host it (#10, #38) ----------------
    // Everything above ran as the host, because the page created the room. Here somebody else
    // holds it, which is the half of the panel a host can never see for itself: read-only, and
    // a banner that arrives rather than one this client caused.

    const chief_saw = [];
    const chief = relay_client({ type: "create", id: room_b }, chief_saw);
    await until("the room", () => chief_saw.some((msg) => msg.type === "joined"));
    chief.send({ type: "seats", names: ["Chief"] });
    await until("the host to sit down", () =>
        chief_saw.some((msg) => msg.type === "room" && msg.host),
    );

    await click("Join with a room code");
    await on("join");
    await screen("join").locator("input").fill(room_b);
    await click("Continue");
    await on("names");
    await page.keyboard.press("ArrowUp");
    await until("the participant", async () => (await seats().count()) === 1);
    await click("Take the seats");
    await on("room");

    assert.ok(
        !(await screen("room").locator('button[data-bind*="start_match"]').isVisible()),
        "a guest is not offered the match to start",
    );
    await open_settings();
    assert.equal(
        await disabled(settings()),
        true,
        "and the settings panel is the host's to change",
    );
    assert.equal(
        await disabled(password_panel()),
        true,
        "the password with it: it is set blind by whoever holds the room, not by whoever joined",
    );
    assert.equal(
        await level_select().inputValue(),
        "default",
        "the panel still reads the room's config, which is the point of showing it at all",
    );

    chief.send({ type: "config", config: { level: "green", ai_fill: false } });
    await until("the host's staged change", async () =>
        (await text(banner())).startsWith("Host staged"),
    );
    assert.equal(
        await text(banner()),
        "Host staged: Level → green, AI on the empty seats → off. Everyone’s ready " +
            "was cleared and the countdown stopped. It applies when the next match starts.",
        "everyone in the room is told what the host staged, not the host alone (#10)",
    );
    assert.equal(
        await level_select().inputValue(),
        "green",
        "and the read-only panel follows it, so the banner and the rows never disagree",
    );

    // The board of a match this client never simulated: it was in the lobby for all of it, so
    // the matrix it shows is the one the host counted and announced (#19, #39). It has to be
    // this room rather than the one above, because a `match_end` is the host's to send and
    // the relay drops one from anybody else -- which is the whole of #82.
    chief.send({
        type: "match_end",
        t: 900,
        reason: "time",
        matrix: [
            [0, 1, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
        ],
    });
    await until("the announced board", () => board_panel().isVisible());
    assert.equal(
        await text(board_panel().locator("p.banner")),
        "Chief wins with 1 bump.",
        "a client that never played the match still gets its board, because the host sent one",
    );
    assert.deepEqual(
        (await grid(board_panel())).slice(1),
        [
            ["Chief", "0", "1", "0", "0", "1"],
            ["Dott", "0", "0", "0", "0", "0"],
            ["Fizz", "0", "0", "0", "0", "0"],
            ["Miji", "0", "0", "0", "0", "0"],
            ["Total deaths", "0", "1", "0", "0", "1"],
        ],
        "seat-keyed and headed by the username on each seat, kills across and deaths down (#13)",
    );

    chief.close();
    await click("Leave");
    await on("landing");

    // --- the host is the reference state, and a client joins the match it runs (#40) ---
    // The page hosts and plays. Two seconds in it has packed its own simulation and handed
    // it to the relay, which is what the next client to ask is given: the state, the frames
    // since it, and the settings block that goes with them.

    await click("Create a room");
    await on("create");
    await screen("create").locator("input.code").fill(room_c);
    await click("Create");
    await on("names");
    await page.keyboard.press("ArrowUp");
    await until("the participant", async () => (await seats().count()) === 1);
    await click("Take the seats");
    await on("room");
    // Alone in the room, so there is nobody to be ready for and the match begins at once.
    await click("Start the match");
    await on("play");
    // Everything this page says and hears from here on, which is what the assertion below
    // is really about: a client handed the match by `start` must not also ask to be let in.
    const in_match = frames.length;

    // One looping track while a match is played. A browser that refused to autoplay sounds
    // none at all, which is why this counts rather than requires: what it is here to catch
    // is a second simulation playing its own music behind the one on screen.
    const loops = (await sounding()).filter((track) => track.includes("(loop)"));
    assert.ok(loops.length <= 1, "one match, one music: " + JSON.stringify(loops));

    const joiner_saw = [];
    const joiner = relay_client({ type: "join", id: room_c }, joiner_saw);
    await until("the joiner", () => joiner_saw.some((msg) => msg.type === "joined"));
    const resumed = [];
    joiner.receive((msg) => resumed.push(msg));
    joiner.send({ type: "seats", names: ["Zip"] });
    await until("the seat", () => joiner_saw.some((msg) => msg.type === "room" && msg.held.length));
    // The host snapshots on a wall clock, so this waits one out rather than a tick count. It
    // is the one assertion in this file that the page really is packing its own simulation,
    // and no fake clock can stand in for it: the relay is on the real one.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    joiner.send({ type: "resync" });
    await until("the match in progress", () => resumed.some((msg) => msg.type === "start"));

    const payload = resumed.find((msg) => msg.type === "start");
    assert.ok(
        decode_snapshot(payload.snapshot),
        "the body is a packed simulation of the size the serializer packs, not an opaque nothing",
    );
    assert.ok(payload.t > 0, "taken on a tick somewhere in the middle of the match");
    assert.ok(payload.until >= payload.t, "and replayed forward from it, never backwards");
    assert.ok(payload.inputs.length, "with the input frames the relay rang since it");
    assert.equal(
        payload.settings.level,
        "default",
        "and the settings block: a joiner with the wrong no_gore desyncs on the first kill (#22)",
    );
    // The relay remembers an ask it cannot answer yet and answers it with the host's first
    // snapshot. That had the host resyncing itself two seconds into every match: the
    // simulation rebuilt under the player, and a second copy of the looping music started
    // over the first (#28, #40).
    // The build stamped into the bundle travels on every handshake, which is what lets the
    // relay refuse a page left open across a rebuild (#40). "dev" would mean the stamp never
    // reached the bundle, which is the failure worth catching here.
    const handshakes = frames.filter((frame) => frame.includes('"build":'));
    assert.ok(handshakes.length, "every handshake says which build this page is");
    assert.ok(
        !handshakes.some((frame) => frame.includes('"build":"dev"')),
        "and it is the one webpack stamped in, not the source running from node",
    );

    // Over the whole walk, not just this match: every room this page has been in either had
    // no match running or handed it one, and neither is a room to ask about.
    assert.deepEqual(
        frames.filter((frame) => frame.includes('"type":"resync"')),
        [],
        "a client handed the match by `start` never asks to be let into it",
    );
    assert.deepEqual(
        frames.slice(in_match).filter((frame) => frame.includes('<- {"type":"start"')),
        [],
        "so it is handed the match once, and plays its own through its own snapshot",
    );

    joiner.close();
    // The host ends the match on the way out, so the room it leaves behind is a lobby again
    // rather than one the relay still thinks is playing (#22).
    await click("Back to the lobby");
    await on("room");
    // And none once it is over. The music is stopped by the match it belongs to being left,
    // so a simulation nothing stopped goes on playing in an empty lobby.
    assert.deepEqual(await sounding(), [], "a match that is over sounds nothing");
    await click("Leave");
    await on("landing");

    // --- leaving a match that is still running (#37, #40) -----------------------------
    // Somebody else hosts this one, so the match goes on without this page: a client that
    // walks back to the lobby keeps its seats and hands its bunnies to the AI, and the room
    // it left is still a room with a match running. Asking to be let into a match in
    // progress is what a client that just left must not do -- it walked out on purpose, and
    // the answer would walk it straight back in.

    const boss_saw = [];
    const boss = relay_client({ type: "create", id: room_d }, boss_saw);
    await until("the room", () => boss_saw.some((msg) => msg.type === "joined"));
    boss.send({ type: "seats", names: ["Boss"] });
    await until("the host to sit down", () =>
        boss_saw.some((msg) => msg.type === "room" && msg.host),
    );

    await click("Join with a room code");
    await on("join");
    await screen("join").locator("input").fill(room_d);
    await click("Continue");
    await on("names");
    await page.keyboard.press("ArrowUp");
    await until("the participant", async () => (await seats().count()) === 1);
    await click("Take the seats");
    await on("room");
    await click("Ready");

    boss.send({ type: "start", seed: 4321, settings: {}, held: [] });
    await on("play");
    // Said only to a client the relay has had to repair, or one whose loop has stopped
    // keeping up with the room's ticks. This one is neither (#41).
    assert.ok(
        !(await page.locator(".reconnecting").isVisible()),
        "a client in step with the room is told nothing over the match",
    );
    // A snapshot for the relay to answer with, because the thing under test is what this
    // page does when there *is* one to be handed: a room whose host never snapshots cannot
    // walk anybody back into anything. The relay never decodes a body, so an empty
    // simulation of the right size is as good as a played one -- and the page really does
    // unpack it, which is why it has to be the right size.
    boss.send({
        type: "snapshot",
        t: 0,
        matrix: new Array(16).fill(0),
        body: encode_snapshot(new Int32Array(SNAPSHOT_INTS)),
    });
    // #41 end to end, through the real relay: the host claims a hash for ticks this page
    // also hashes, they disagree, and the page is handed the host's state back. A hash the
    // page cannot check for itself is the whole point -- a client that is late looks fine
    // from the inside, because its own tick keeps up and its own inputs are its own. The
    // repair landing is the only local evidence there is, which is what the overlay says.
    // Eight ticks' worth, which is the window the relay keeps and four seconds of match.
    // A repair used to build a second Sound_Player and merely mute the first, leaving its
    // six decoded elements alive: a client repaired every two seconds orphaned ninety of
    // them a minute, on exactly the machine that was already short of everything (#91).
    // The track is four to eight milliseconds in when the repair lands, so `currentTime`
    // rises across it either way -- rewound to zero it is still ahead of where it was last
    // read. Wait for it to get going first, and then "it did not go backwards" is exactly
    // the difference between the session's own track picked up where it was paused and a
    // second start from the top. Half a second of real time, and the only check there is
    // on the rewind guard (#91).
    await until("the music to get going", async () => (await music_t()) > 0.4);
    const audio_before = await audio_made();
    const t_before = await music_t();
    for (let t = 30; t <= 240; t += 30) boss.send({ type: "checksum", t, h: 1 });
    await until("the repair to land", () => page.locator(".reconnecting").isVisible());
    assert.equal(
        await audio_made(),
        audio_before,
        "a repair makes no audio elements at all, so a run of them cannot pile up (#91)",
    );
    const t_after = await music_t();
    assert.ok(
        t_after >= t_before,
        `the repair rewound the music rather than resuming it: ${t_before} -> ${t_after} (#91)`,
    );
    // AC4's other half: packed at tick 0, sent on the wire as tick 0, and they agree -- so
    // pinning the message alone would pass an `if (true)` that logs on every repair. This is
    // the negative that catches it: nothing about this one's tick disagreement is unpacked.
    assert.ok(
        !console_lines.some((line) => line.startsWith("snapshot packed at tick %d arrived")),
        "AC4: ticks that agree are not reported as a disagreement (#92)",
    );
    await click("Back to the lobby");
    await on("room");
    // And it goes with the match, rather than standing over the lobby this page walked to --
    // which it would, since it is raised on a timer that outlives the repair by seconds.
    assert.ok(!(await page.locator(".reconnecting").isVisible()), "said over a match, or not");
    // Long enough for the ask to have been made, answered and acted on, which is what this
    // is here to prove did not happen.
    await settle();
    await settle();
    assert.equal(
        await page.evaluate(() => window.location.hash),
        "#room",
        "a client that left the match stays left, and is not walked back into it",
    );
    assert.deepEqual(await sounding(), [], "and the match it left sounds nothing");
    boss.close();
    await click("Leave");
    await on("landing");

    assert.deepEqual(page_errors, [], "and the page threw nothing on the way through");
}

// --- a match that ends by itself (#39) -------------------------------------------------
// Its own page, because a fake clock stops the simulation until it is wound on, which every
// step above would have to wind by hand. The one-minute time limit is reached in no real
// time at all; that the simulation stops on the tick the limit falls is `replay.test.mjs`'s.

async function self_ending_match() {
    // A context of its own, because `clock.install` is the *context's*: installed on a page
    // of the walk's context it would freeze the walk's own page along with it, and leave it
    // frozen for whatever came next.
    const clock_page = await (await make_context("clock")).newPage();
    const errors = [];
    clock_page.on("pageerror", (error) => errors.push(error.message));
    await clock_page.clock.install();
    await clock_page.goto(origin + "/");

    await click("Play offline", clock_page);
    await on("names", clock_page);
    await clock_page.keyboard.press("ArrowUp");
    await until("the participant", async () => (await seats(clock_page).count()) === 1);
    await click("Take the seats", clock_page);
    await on("room", clock_page);

    await open_settings(clock_page);
    await config_row("Minutes", "number", clock_page).fill("1");
    await click("Apply to the next match", clock_page);

    await click("Start the match", clock_page);
    await on("play", clock_page);
    assert.ok(
        (await chrome(clock_page)).includes("1:00"),
        "the minute the room was given is what the top bar counts down from",
    );

    // Exactly the limit, and not a millisecond of the hold that follows it.
    await clock_page.clock.fastForward("01:00");
    assert.ok(
        await screen("play", clock_page).isVisible(),
        "the last frame is held for a moment rather than cut away on the tick it was drawn (#39)",
    );

    await clock_page.clock.fastForward(2500);
    await on("room", clock_page);
    // Who wins is the seed's business -- it is `Date.now()` -- and the wording of this line
    // is `router.test.mjs`'s. What a browser is here to prove is that the match ended on its
    // own and the lobby said how.
    assert.match(
        await text(board_panel(clock_page).locator("p.banner")),
        /^(Nobody scored\.|.+ (wins with \d+ bumps?|draw at \d+ bumps)\.)$/,
        "the time limit ends the match by itself, and the line above the board says how",
    );
    assert.ok(
        !(await chrome(clock_page)).some((item) => /^\d+:\d\d$/.test(item)),
        "and the clock goes with the match it was counting",
    );

    // Leaving during the hold, which is the bug this suite found on its first run: the hold
    // is a two-second `go("room")`, and nothing used to cancel it on the way out of a room.
    // A player who left in those two seconds was routed back by a match that was already
    // over -- and onto the names screen, because leaving clears the couch and forgets the
    // room id, which is what the lobby route falls back from. Deterministic here because a
    // fake clock decides when the two seconds pass (#39).
    await click("Start the match", clock_page);
    await on("play", clock_page);
    await clock_page.clock.fastForward("01:00");
    await click("Back to the lobby", clock_page);
    await on("room", clock_page);
    await click("Leave", clock_page);
    await on("landing", clock_page);
    await clock_page.clock.fastForward(3000);
    await settle();
    assert.equal(
        await clock_page.evaluate(() => window.location.hash),
        "#landing",
        "a hold from the match just left does not route a client that has walked away",
    );
    assert.ok(await screen("landing", clock_page).isVisible(), "the landing screen stays up");

    assert.deepEqual(errors, [], "with nothing thrown on the way");
    await clock_page.close();
}

// --- two real pages in one room (#66) --------------------------------------------------
// jsdom bound Knockout once per module import, so one process was one page: every second
// client in the walk above is a raw socket with no page of its own. Two browser contexts
// are two players -- storage is per context, so the two pages never fight over one room
// token -- and what is asserted is that they *agree*. The room is one thing, seen twice.
//
// Now also tick-by-tick (#41, #96): each page hashes its own sim every 30 ticks and sends
// the number to the relay -- already on the wire, no client hook added. Sampled three times:
// mid-match, with one hash deliberately wrong, and again after a mid-match repair. Paired by
// tick, never by wall clock.

async function two_pages() {
    const host = await (await make_context("host")).newPage();
    const guest_context = await make_context("guest");
    // A hash that's wrong on purpose, so the assertion below is shown capable of failing
    // (#96). One lie, not two: each one the relay sees triggers desync() -> a `start`
    // carrying a snapshot -> refetch + catch_up replay (game_session.js:157-160) -- one lie
    // proves disagreements() catches it and halves that churn.
    //
    // ponytail: diverges the number on the wire, not the state behind it. State-to-hash link
    // is replay.test.mjs:512-518's. upgrade path: drop an inbound `input` frame with a key
    // held, if real state divergence is ever needed here too.
    await guest_context.addInitScript(() => {
        window.__lie = false;
        window.__lied_tick = null;
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
            if (window.__lie && typeof data === "string" && data.includes('"checksum"')) {
                const msg = JSON.parse(data);
                if (msg.type === "checksum") {
                    window.__lie = false;
                    window.__lied_tick = msg.t;
                    data = JSON.stringify({ type: "checksum", t: msg.t, h: (msg.h ^ 1) | 0 });
                }
            }
            return send.call(this, data);
        };
    });
    const guest = await guest_context.newPage();
    const errors = [];
    host.on("pageerror", (error) => errors.push("host: " + error.message));
    guest.on("pageerror", (error) => errors.push("guest: " + error.message));

    // Before either `goto`, or the handshake socket opens before anything is listening.
    const host_hashes = record_checksums(host);
    const guest_hashes = record_checksums(guest);

    await host.goto(origin + "/");
    await click("Create a room", host);
    await on("create", host);
    await screen("create", host).locator("input.code").fill(room_e);
    // Ticked on the way in, which is the only time it can be: listing is not host config
    // and does not change while the room is live (#43).
    await screen("create", host).locator("input[type=checkbox]").check();
    await click("Create", host);
    await on("names", host);
    await host.keyboard.press("ArrowUp");
    await until("the host's participant", async () => (await seats(host).count()) === 1);
    await click("Take the seats", host);
    await on("room", host);

    // The guest arrives by the public list rather than by the code, which is the same
    // join underneath: Browse fetches once on entry, and the row is the way in. A room
    // holding only its host is listed -- that is the whole point of it (#43).
    await guest.goto(origin + "/");
    await click("Browse rooms", guest);
    await on("browse", guest);
    const row = screen("browse", guest).locator("li");
    await until("the host's room in the public list", async () => (await row.count()) === 1);
    // `:visible`, because an unrendered element's `innerText` is its text content and the
    // lock a listed room does not have would read as one.
    const fields = await row.locator("span:visible, small:visible").allInnerTexts();
    assert.deepEqual(
        fields,
        ["Dott", room_e, "1/4", "in the lobby"],
        "the host's username, the code, the occupancy and the phase, and no fifth field " +
            "until it is locked",
    );
    await click("Join", guest);
    await on("names", guest);
    await guest.keyboard.press("ArrowUp");
    await until("the guest's participant", async () => (await seats(guest).count()) === 1);
    // Renamed, because both couches name their own first bunny Dott and two rows reading
    // the same thing is not an agreement worth asserting.
    await seats(guest).nth(0).locator("input").fill("Zip");
    await seats(guest).nth(0).locator("input").blur();
    await click("Take the seats", guest);
    await on("room", guest);

    await until(
        "the guest's seat to reach the host",
        async () => (await room_view(host))[1][0] === "Zip",
    );
    assert.deepEqual(
        await room_view(host),
        [
            ["Dott", "not ready", "Dott"],
            ["Zip", "not ready", "Jiffy"],
            ["AI", "ready", "Fizz"],
            ["AI", "ready", "Miji"],
        ],
        "the relay seats the second page beside the first, and AI-fills what is left (#36)",
    );
    assert.deepEqual(
        await room_view(guest),
        await room_view(host),
        "and the two pages read one room: the same seats, the same names, the same ready flags",
    );

    // Who the lobby is waiting on, by name. The client's own `host` flag names nobody, so
    // this is the relay's `host_seat` arriving, being kept, and being turned into a sentence
    // -- three links that used to be asserted nowhere (#88).
    assert.equal(
        await text(screen("room", guest).locator('p[data-bind*="waiting_text"]')),
        "Waiting for Dott to start.",
        "the lobby identifies the host among the seated players, by the name the room knows " +
            "it under rather than by its bunny (#88)",
    );

    // The host readies by starting and the guest has not readied at all, so what Start runs
    // into is the countdown -- on both pages, since the deadline is the relay's (#21, #37).
    const countdown = (root) => screen("room", root).locator('p[data-bind*="visible: countdown"]');
    await click("Start the match", host);
    await until("the countdown on the host", () => countdown(host).isVisible());
    await until("the countdown on the guest", () => countdown(guest).isVisible());
    assert.match(
        await text(countdown(guest)),
        /^Starting in \d+s\./,
        "a client that never asked for the match is told it is coming anyway",
    );
    assert.ok(!(await screen("play", guest).isVisible()), "and nothing starts while it runs");

    // Readying the last straggler collapses the countdown to an instant start, so both
    // pages are handed the same `start` and walk themselves into the match.
    await click("Ready", guest);
    await on("play", host);
    await on("play", guest);
    assert.ok(!(await screen("room", host).isVisible()), "the lobby goes on both");
    assert.ok(!(await screen("room", guest).isVisible()));

    // --- the two simulations, tick by tick (#41, #96) -----------------------------------
    // Not the final board, which travels with the announcement and would agree even across
    // two different matches: each page's own hash of its own state, same tick, off the wire
    // it ships on. Floor 1, not 0 -- three real samples (30, 60, 90), not tick 0's free one.
    await until(
        "three ticks both pages have hashed",
        () => paired(host_hashes, guest_hashes, 1).length >= 3,
    );
    assert.deepEqual(
        disagreements(host_hashes, guest_hashes, 1),
        [],
        "the two pages hash the same state for the same tick: one match, simulated twice (#41)",
    );

    // And the assertion can fail: one hash the guest gets wrong on purpose.
    await guest.evaluate(() => (window.__lie = true));
    await until("the lied tick to reach the host too", async () => {
        const t = await guest.evaluate(() => window.__lied_tick);
        return t !== null && host_hashes.has(t);
    });
    const lied_tick = await guest.evaluate(() => window.__lied_tick);
    assert.deepEqual(
        disagreements(host_hashes, guest_hashes),
        [lied_tick],
        "a client reporting a hash that is not the host's fails this assertion, and nothing else does",
    );

    // --- leaving the match and taking an AI seat back into it (#42) --------------------
    // One host, one client, two AI bunnies, and the client walks out and sits back down --
    // first on the seat it already held, then on one of the bunnies nobody was driving. Two
    // real pages, because a second simulation on its own 60 Hz clock is what makes the seats
    // change hands at all: a seatless socket never moves the room's tick on.
    //
    // What is asserted is that the relay hands each seat back to the client, which it does
    // on the `resume` and before the client has even landed. That a client which lands
    // *behind* then closes the gap rather than playing every frame late is not asserted
    // here: making that happen needs the page throttled, and how far behind an 8x-throttled
    // rebuild lands is the runner's business rather than the code's -- a slow enough machine
    // really does lose the seat to the AI, which is what #42 asks for. `replay.test.mjs`
    // proves the loop instead, by landing a client 38 ticks behind and counting.
    const watcher_saw = [];
    const watcher = relay_client({ type: "join", id: room_e }, watcher_saw);
    await until("the watcher in the room", () => watcher_saw.some((msg) => msg.type === "joined"));

    // Out of the match and straight back into the seat it already holds. A client that
    // walks out keeps its seats and hands its bunnies to the AI, and this is what it says
    // to take them back -- leaving the room and following the link again was the only way
    // in before, which is no way at all (#42).
    await click("Back to the lobby", guest);
    await on("room", guest);
    await click("Rejoin the match", guest);
    await on("play", guest);
    await until("the seat to come back off the AI", () => {
        const room = watcher_saw.filter((msg) => msg.type === "room").pop();
        return room && room.labels[1] === "Zip";
    });

    // And out again, onto a bunny the AI is driving: the seat grows this client past the one
    // participant it named at the names screen, and it is handed the match with both seats
    // in it.
    await click("Back to the lobby", guest);
    await on("room", guest);
    await click("Take seat (A D W)", guest);
    // Up to a couple of seconds: the relay can only hand back a match it has a state for,
    // and the host snapshots every two (#40).
    await on("play", guest);
    await until("both seats to be the client's", () => {
        const room = watcher_saw.filter((msg) => msg.type === "room").pop();
        return room && room.labels[1] === "Zip" && room.labels[2] === "Jiffy";
    });
    assert.equal(
        await guest.evaluate(() => window.location.hash),
        "#play",
        "and it is still in the match it took the seat to get back into",
    );

    // --- and they agree again after the repair (#40, #41, #96) --------------------------
    // Guest just took the host's packed state twice and replayed the gap (catch_up,
    // game_session.js:157-160). A resync landing it in a near-right state looks fine on
    // screen and hashes different -- the whole reason the hash exists. Floor is the host's
    // latest sample so far, not the repair instant -- conservative, not exact: a guest
    // sample from just before the repair could in principle land inside it too, if the
    // guest crossed a 30-tick boundary the host had not yet.
    const after_repair = Math.max(...host_hashes.keys()) + 1;
    await until(
        "three ticks both pages have hashed since the repair",
        () => paired(host_hashes, guest_hashes, after_repair).length >= 3,
    );
    assert.deepEqual(
        disagreements(host_hashes, guest_hashes, after_repair),
        [],
        "a client resumed from the host's snapshot hashes to the host's, tick for tick (#40)",
    );
    watcher.close();

    await click("Back to the lobby", host);
    await on("room", host);
    // The guest is not leaving: it is being told the match is over, and it walks itself back
    // after the moment the last frame is held for (#39).
    await on("room", guest);
    await until("the guest's board", () => board_panel(guest).isVisible());

    // A seat's label picks up "(AI)" the moment the client on it hands its bunny back, and
    // the two pages hear that a broadcast apart -- so the labels are read without it. The
    // counts under them are the match, and they are what has to agree.
    const named = (rows) => rows.map((row) => row.map((cell) => cell.replace(" (AI)", "")));
    // The host's board is anchored first, or two empty panels would agree with each other
    // and the comparison below would pass by saying nothing at all.
    const host_board = named(await grid(board_panel(host)));
    assert.deepEqual(
        host_board.slice(1).map((row) => row[0]),
        ["Dott", "Zip", "Jiffy", "Miji", "Total deaths"],
        "a row per seat, named by the username on it, and the totals under them (#13)",
    );
    assert.deepEqual(
        named(await grid(board_panel(guest))),
        host_board,
        "the host counted the board and it travelled with the announcement, so the two " +
            "pages end on one board, row for row (#19, #22)",
    );
    for (const [who, root] of [
        ["host", host],
        ["guest", guest],
    ])
        assert.equal(
            await text(board_panel(root).locator("p.banner")),
            "The host ended the match.",
            "and on one account of how it ended, the " + who + "'s included",
        );
    assert.deepEqual(await room_view(guest), await room_view(host), "in one lobby, still");

    // Ready clears for the whole room when a match ends, and cleared checkboxes on their own
    // read as a bug rather than as the rule they are (#10, #38, #88).
    assert.equal(await notice(guest), FLOW_TEXT.ready_cleared);
    await click("Ready", guest);
    await until("the instruction to retire", async () => (await notice(guest)) === "");

    // And the other half of #88's item B: the countdown running out on a client that never
    // readied takes its seats back, and says so on the screen it lands on (#17, #37).
    await click("Not ready", guest);
    await until(
        "the room to read the guest as not ready",
        async () => (await room_view(guest))[1][1] === "not ready",
    );
    // Shortens the wait to under half a second when the walk booted the relay itself. In
    // CI the relay is in a container this process's env cannot reach, so the write is
    // inert there and the walk sits out the real ten seconds instead -- the assertion
    // below is the same one either way, and the countdown is the relay's to run.
    process.env.COUNTDOWN_MS = "400";
    await click("Start the match", host);
    await on("names", guest);
    assert.equal(
        await err_on("names", guest),
        FLOW_TEXT.vacated,
        "a player whose seats the countdown took is told so, where it lands (#17, #37, #88)",
    );
    delete process.env.COUNTDOWN_MS;

    assert.deepEqual(errors, [], "and neither page threw on the way through");
}

// --- sound (#66) -----------------------------------------------------------------------
// jsdom has no media playback, so this was always a hand check -- and worse than absent:
// its `canPlayType` returns empty, so the only path it ever took was the ogg one. Chrome
// takes the mp3s, which until now nothing but a person had ever played.
//
// On a fake clock, so a sound the AI causes is waited for by winding the simulation on
// rather than by sitting through it. Media is not on that clock: the element really is
// decoding the file and really is moving through it, which is the half no recorder can show.
//
// Still not covered, and cannot be: whether any of it is audible, or at the right volume,
// and a real autoplay block -- headless Chrome autoplays with no flag asked for, so there
// is no block here to reproduce one with.

async function sound() {
    const sound_page = await (await make_context("sound")).newPage();
    const errors = [];
    sound_page.on("pageerror", (error) => errors.push(error.message));
    // A local room seeds itself from `Date.now() | 0`, so a pinned clock is a pinned match.
    // It has to be pinned: whether four bunnies bump each other inside a few seconds is the
    // seed's business, and a third of all seeds never do it at all. `1748051689473 | 0` is
    // 1, a seed that kills ten times over the first few seconds -- and it being the same
    // match every run is what makes a failure here a bug rather than a rerun.
    //
    // `install` alone leaves the clock ticking along with the real one, so it is `pauseAt`
    // that pins the time -- and from there only a `fastForward` moves it. It is installed a
    // minute early because `pauseAt` winds forward and refuses to wind back: installing at
    // the target and pausing at it is a race with however long the two calls take, which on
    // a loaded machine is not zero. There is no page yet, so the minute wound through here
    // has no timers in it to run.
    const SEEDED = 1748051689473;
    await sound_page.clock.install({ time: SEEDED - 60000 });
    await sound_page.clock.pauseAt(SEEDED);
    await sound_page.goto(origin + "/");

    await click("Play offline", sound_page);
    await on("names", sound_page);
    await sound_page.keyboard.press("ArrowUp");
    await until("the participant", async () => (await seats(sound_page).count()) === 1);
    await click("Take the seats", sound_page);
    await on("room", sound_page);
    await click("Start the match", sound_page);
    await on("play", sound_page);

    await until("the music", async () => (await sounds(sound_page)).length > 0);
    assert.equal(
        (await sounds(sound_page))[0],
        "bump.mp3",
        "a match opens on its music -- and on the mp3, which is the file a browser picks " +
            "and the one jsdom's empty `canPlayType` could never reach",
    );
    // Playing and decoded, which arrive separately: `duration` is NaN until the metadata
    // lands, and a one-shot read of it is a race with the network rather than an assertion.
    await until("the music to start", async () => {
        const track = await music(sound_page);
        return track.paused === false && isFinite(track.seconds);
    });
    const started = await music(sound_page);
    assert.ok(started.loop, "played as a loop, because a match outlasts the track");
    assert.ok(
        Math.abs(started.seconds - 54.8) < 0.5,
        "decoded rather than merely fetched: " + started.seconds + "s of it",
    );
    // In real milliseconds: the page's clock is fake, and the media pipeline is not on it.
    await until(
        "the music to move through the file",
        async () => (await music(sound_page)).t > started.t,
    );

    // A bump, which is one bunny landing on another: the AI's to cause, and the reason the
    // seed above is pinned rather than left to the clock.
    await forget_sounds(sound_page);
    await wind_until(sound_page, "a death", async () =>
        (await sounds(sound_page)).includes("death.mp3"),
    );

    // --- and the same match with the room to itself ----------------------------------
    // `sfx.jump()` is played for whichever bunny jumped and says nothing about which, so
    // with three AI bunnies bouncing about, a jump sound proves only that somebody jumped
    // -- the key held below could be doing nothing at all and it would still land. Emptying
    // the seats leaves one bunny that can make a sound, so both halves below are about it:
    // the jump is this client's key reaching the simulation, and the silence after it is
    // silence rather than a lull.
    await click("Back to the lobby", sound_page);
    await on("room", sound_page);
    await open_settings(sound_page);
    await tick("AI on the empty seats", false, sound_page);
    await click("Apply to the next match", sound_page);
    // A tap in the lobby, before "Start the match" -- the negative to the held-jump
    // control right below it: no tick has run yet for it to land on, so it must not ride
    // a latch onto the match's first one (#86).
    await sound_page.keyboard.down("ArrowUp");
    await sound_page.keyboard.up("ArrowUp");
    await forget_sounds(sound_page);
    await click("Start the match", sound_page);
    await on("play", sound_page);
    await sound_page.clock.fastForward(200);
    assert.ok(
        !(await sounds(sound_page)).includes("jump.mp3"),
        "a key tapped in the lobby does not survive onto the match it starts (#86)",
    );

    // Held down rather than pressed: no tick passes between a keydown and the keyup that
    // follows it on a fake clock, so a press is a key the simulation never sees.
    await forget_sounds(sound_page);
    await sound_page.keyboard.down("ArrowUp");
    await wind_until(
        sound_page,
        "a jump",
        async () => (await sounds(sound_page)).includes("jump.mp3"),
        500,
        20,
    );

    // --- alt-tab with the key still down (#85) ---------------------------------------
    // The key is held and the browser is about to stop telling this page about it: no
    // keyup is ever delivered for it, and the map used to go on reporting it pressed --
    // which `Room.step` re-reads and re-stamps 60 times a second, so the latch was the
    // whole room's picture and not this page's.
    // The event rather than a real tab switch: which window has focus is the window
    // manager's business and headless has no window manager, so a second tab brought to
    // the front is a different test on every machine. What is under test is what the page
    // does when the event lands.
    // ponytail: proves the handler, not that Chrome fires blur on alt-tab. upgrade path:
    // a second page and `bringToFront()`, if headless focus ever becomes something a suite
    // with no retries can lean on.
    await sound_page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await forget_sounds(sound_page);
    await sound_page.clock.fastForward(500);

    // A keydown on a key that is already down, which is what the OS repeats into a window
    // that regains focus still holding it -- and here, the only thing that can jump again.
    // `jump_ready` comes back on a tick that saw the key *up* (`movement.js:92`), so a
    // bunny whose keyup never arrived jumps once and then never again: a jump after the
    // blur is proof the simulation was told to let go. Asserting silence instead would
    // prove nothing, because a latched key is just as silent.
    await sound_page.keyboard.down("ArrowUp");
    await wind_until(
        sound_page,
        "the jump the blur made possible again",
        async () => (await sounds(sound_page)).includes("jump.mp3"),
        500,
        20,
    );

    // M, which is a keyup in this game. The key stays down over it, so what is being
    // silenced is a bunny that was sounding a moment ago.
    //
    // ponytail: this one is weaker than it reads -- a held jump fires once and is silent
    // after (`jump_ready`, movement.js:92), so silence here does not prove the mute.
    // upgrade path: re-press ArrowUp while muted, as the blur block above does.
    await sound_page.keyboard.press("m");
    await until("the music to stop", async () => (await music(sound_page)).paused === true);
    await forget_sounds(sound_page);
    await sound_page.clock.fastForward(5000);
    await sound_page.keyboard.up("ArrowUp");
    assert.deepEqual(
        await sounds(sound_page),
        [],
        "muted is silent, not quiet: five seconds of held jump, and not one element played",
    );

    await click("Back to the lobby", sound_page);
    await on("room", sound_page);
    assert.deepEqual(await sounding(sound_page), [], "a match that is over sounds nothing");
    assert.deepEqual(errors, [], "with nothing thrown on the way");
    await sound_page.close();
}

// --- a phone (#66) ---------------------------------------------------------------------
// 390x844, which is a phone held upright. The walk is short on purpose: the landing screen
// through to the lobby, where every click along the way is already a layout assertion --
// visible, non-zero, not covered, not moving. What a click cannot say is whether the page
// fits, so that is what is asserted here, rather than geometry numbers that would need
// revisiting every time the design shifts. Touch controls are #45, and this is the viewport
// they will be walked at.

// The list is a snapshot, and the only thing that keeps a snapshot honest is that asking
// again really asks again. Both of these were shipped broken: a `max-age=10` response and a
// default `fetch` left a dead room in the list for ten seconds, and the refusal message
// outlived the screen it was about (#43).
async function browse() {
    const browse_page = await (await make_context("browse")).newPage();
    const errors = [];
    browse_page.on("pageerror", (error) => errors.push(error.message));
    // This walk's own room, by its code: an earlier walk's room is still up and still
    // listed, which is the list working rather than a row to count around.
    const rows = () => screen("browse", browse_page).locator("li").filter({ hasText: room_g });
    const message = () => err_on("browse", browse_page);

    const seen = [];
    const doomed = relay_client({ type: "create", id: room_g, listed: true }, seen);
    await until("a listed room", async () => seen.some((msg) => msg.type === "joined"));
    doomed.send({ type: "seats", names: ["Ghost"] });
    await until("its host on a seat", async () =>
        seen.some((msg) => msg.type === "room" && msg.held.length),
    );

    await browse_page.goto(origin + "/");
    await click("Browse rooms", browse_page);
    await on("browse", browse_page);
    await until("the listed room in the list", async () => (await rows().count()) === 1);
    assert.ok(
        (await screen("browse", browse_page).locator("li").count()) > 1,
        "and it is listed alongside the room the walk before this one left up",
    );

    // A room dies with its last client, so the row on screen is now a row for a room that
    // is not there -- which is exactly the click the list cannot protect anyone from, and
    // does not try to: the join is what is authoritative.
    doomed.close();
    await rows().locator("button").click();
    await on("browse", browse_page);
    await until("the dead room gone from the list", async () => (await rows().count()) === 0);
    assert.match(await message(), /not available/, "and a word about why it bounced back");

    // The way out of that message is the way a player takes: out to the menu and back.
    await click("Back", browse_page);
    await on("landing", browse_page);
    await click("Browse rooms", browse_page);
    await on("browse", browse_page);
    assert.equal(await message(), "", "the refusal does not outlive the screen it was about");

    // And the button asks the relay, not the browser's cache: this room was created well
    // inside the ten seconds the last answer was good for.
    const again = [];
    const revived = relay_client({ type: "create", id: room_g, listed: true }, again);
    await until("the room again", async () => again.some((msg) => msg.type === "joined"));
    revived.send({ type: "seats", names: ["Ghost"] });
    await until("its host on a seat again", async () =>
        again.some((msg) => msg.type === "room" && msg.held.length),
    );
    await click("Refresh", browse_page);
    await until("the new room on a manual refresh", async () => (await rows().count()) === 1);
    revived.close();

    // A relay that is down and a Saturday with nothing on are the same empty array to
    // `fetch`, and used to be the same sentence on screen (#88). Aborting the request is
    // the failure a player gets, rather than a stubbed rejection inside the view model.
    await browse_page.route("**/api/rooms*", (route) => route.abort());
    await click("Refresh", browse_page);
    await until("the failure", async () => (await err_on("browse", browse_page)) !== "");
    assert.equal(await err_on("browse", browse_page), FLOW_TEXT.rooms_failed);
    assert.ok(
        !(await screen("browse", browse_page)
            .locator("p.muted")
            .filter({ hasText: "Nothing public" })
            .isVisible()),
        "and the quiet-Saturday line is not what a dead relay says",
    );
    await browse_page.unroute("**/api/rooms*");
    await click("Refresh", browse_page);
    await until("the list back", async () => (await err_on("browse", browse_page)) === "");

    // The refusal a player gets for a code that was never a room: said on the *first*
    // attempt, on the screen it lands on, rather than only after a password is typed at a
    // room that may never have existed (#8, #88).
    const never_made = new_room_id();
    await click("Back", browse_page);
    await on("landing", browse_page);
    await click("Join with a room code", browse_page);
    await on("join", browse_page);
    await screen("join", browse_page).locator("input").fill(never_made);
    await click("Continue", browse_page);
    await on("password", browse_page);
    await until("the refusal", async () => (await err_on("password", browse_page)) !== "");
    assert.equal(await err_on("password", browse_page), FLOW_TEXT.not_accepted);

    // The locked-room twin: a room that exists and is locked reads the same "not accepted"
    // sentence on the first attempt, not a claim that the room is gone -- this is the
    // assertion that would have caught that false claim (review MUST FIX 1 of #88).
    const locked_seen = [];
    const locked_id = new_room_id();
    const locked = relay_client({ type: "create", id: locked_id }, locked_seen);
    await until("the locked room", () => locked_seen.some((msg) => msg.type === "joined"));
    // A seat first: `ensure_host` only ever runs for a client holding one, and only the
    // host may set a password (#38).
    locked.send({ type: "seats", names: ["Lockman"] });
    await until("its host on a seat", () =>
        locked_seen.some((msg) => msg.type === "room" && msg.held.length && msg.host),
    );
    const before_lock = locked_seen.length;
    locked.send({ type: "config", password: "hunter2" });
    await until("the room to be locked", () => locked_seen.length > before_lock);
    await click("Start over", browse_page);
    await on("landing", browse_page);
    await click("Join with a room code", browse_page);
    await on("join", browse_page);
    await screen("join", browse_page).locator("input").fill(locked_id);
    await click("Continue", browse_page);
    await on("password", browse_page);
    await until("the refusal", async () => (await err_on("password", browse_page)) !== "");
    assert.equal(
        await err_on("password", browse_page),
        FLOW_TEXT.not_accepted,
        "a room that exists and is locked reads the same sentence as a mistyped code: not " +
            "accepted, not claimed gone, before any password has been typed",
    );
    locked.close();

    assert.deepEqual(errors, [], "and the browse screen threw nothing");
}

// Quick Join and the queue, from the two sides a player sees them from: one client asks to
// be put somewhere and is, in the tightest room that fits it, and the next one to ask for a
// seat in that now-full room waits for one instead of being turned away (#44).
async function queueing() {
    const quick_page = await (await make_context("quick")).newPage();
    const waiting_page = await (await make_context("waiting")).newPage();
    const errors = [];
    quick_page.on("pageerror", (error) => errors.push("quick: " + error.message));
    waiting_page.on("pageerror", (error) => errors.push("waiting: " + error.message));
    const lobby_of = (root) => screen("room", root);
    const named = (root) => lobby_of(root).locator("ul.seats li span.grow").allInnerTexts();
    const waiting_line = () =>
        lobby_of(waiting_page).locator("p.muted").filter({ hasText: "waiting for one" });

    // Two listed rooms with room for a couch of two: one with exactly two seats free and one
    // with three. The tighter of them is the one Quick Join is supposed to pick, and a couch
    // is what tells the two apart -- a single player would fit the one free seat an earlier
    // walk left open in a room older than either of these, and would rightly be sent there.
    const fill = async (id, names) => {
        const seen = [];
        const client = relay_client({ type: "create", id: id, listed: true }, seen);
        await until("the room " + id, async () => seen.some((msg) => msg.type === "joined"));
        client.send({ type: "seats", names: names });
        await until("its " + names.length + " seats", async () =>
            seen.some((msg) => msg.type === "room" && msg.held.length === names.length),
        );
        return client;
    };
    const tight = await fill(room_h, ["Ann", "Ben"]);
    const roomy = await fill(room_i, ["Cid"]);

    await quick_page.goto(origin + "/");
    await click("Quick Join", quick_page);
    // Names first: the relay cannot pick a room that fits this client without knowing how
    // many seats it needs.
    await on("names", quick_page);
    await quick_page.keyboard.press("ArrowUp");
    await quick_page.keyboard.press("w");
    await until("a couch of two to join with", async () => (await seats(quick_page).count()) === 2);
    await seats(quick_page).nth(0).locator("input").fill("Dot");
    await seats(quick_page).nth(0).locator("input").blur();
    await seats(quick_page).nth(1).locator("input").fill("Fay");
    await seats(quick_page).nth(1).locator("input").blur();
    await click("Take the seats", quick_page);
    await on("room", quick_page);
    await until("the room it was put in", async () =>
        (await lobby_of(quick_page).locator("h2").innerText()).includes(room_h),
    );
    assert.deepEqual(
        await named(quick_page),
        ["Ann", "Ben", "Dot", "Fay"],
        "the two free seats in the tightest room that fits the whole couch, taken on the way in",
    );

    // That room is full now, so the next client to ask for a seat in it waits.
    await waiting_page.goto(origin + "/");
    await click("Join with a room code", waiting_page);
    await on("join", waiting_page);
    await screen("join", waiting_page).locator("input").fill(room_h);
    await click("Continue", waiting_page);
    await on("names", waiting_page);
    await waiting_page.keyboard.press("ArrowUp");
    await until(
        "a participant to wait with",
        async () => (await seats(waiting_page).count()) === 1,
    );
    await seats(waiting_page).nth(0).locator("input").fill("Eve");
    await seats(waiting_page).nth(0).locator("input").blur();
    await click("Take the seats", waiting_page);
    // The lobby, not the names screen: the asking is done and the answer was "not yet".
    await on("room", waiting_page);
    await until("the line that says it is waiting", async () => await waiting_line().isVisible());
    assert.deepEqual(
        await named(waiting_page),
        ["Ann", "Ben", "Dot", "Fay"],
        "and it is in the room, watching it, holding none of it",
    );

    // A seat comes free, and the client waiting for it is seated with the names it gave --
    // no second ask, and nothing to press.
    await click("Leave", quick_page);
    await on("landing", quick_page);
    await until("the seat it was waiting for", async () =>
        (await named(waiting_page)).includes("Eve"),
    );
    assert.equal(
        await waiting_line().isVisible(),
        false,
        "and the line about waiting goes with the waiting",
    );

    tight.close();
    roomy.close();
    assert.deepEqual(errors, [], "and neither page threw");
}

// One click, one room (#89). The connect path had no in-flight state and the button no
// enable binding, so a second click opened a second socket -- and the abandoned one went
// on answering the relay's pings, holding a room up in the public list with a host that
// would never leave.
async function double_click_create() {
    // AC1's own claim, independent of the guard below: the button disables itself on the
    // click that opens the socket, not on however long the answer takes -- Knockout's
    // `enable` binding writes `disabled` synchronously inside the click handler's own turn.
    // Its own page: a single click here is a real room, left up rather than raced with the
    // double-click below.
    //
    // The relay is in-process and local, so an unslowed round trip can answer before this
    // test ever gets to look -- proving nothing about whether the button waited for it or
    // was never disabled at all. Delaying every message the relay sends this page opens a
    // window wide enough to look inside.
    const solo = await (await make_context("solo-create")).newPage();
    await solo.routeWebSocket(/\/ws/, (ws) => {
        const relay = ws.connectToServer();
        relay.onMessage((frame) => setTimeout(() => ws.send(frame), 300));
    });
    await solo.goto(origin + "/");
    await click("Create a room", solo);
    await on("create", solo);
    await click("Create", solo);
    assert.equal(
        await disabled(button("Create", solo)),
        true,
        "the button disables on the click itself, not on the relay's answer (#89)",
    );
    await on("names", solo);

    const dbl = await (await make_context("double")).newPage();
    const listed = async () =>
        (await fetch(origin + "/api/rooms").then((res) => res.json())).map((room) => room.id);
    await dbl.goto(origin + "/");
    const before = await listed();
    await click("Create a room", dbl);
    await on("create", dbl);
    // Listed, because the public list is where the orphan showed up. And no code typed: the
    // relay generates one per create, so two clicks with a code of their own would collide
    // on the second rather than make a second room.
    await screen("create", dbl).locator('input[type="checkbox"]').check();
    // Not two clicks: the second would fail Playwright's own enabled check and report a
    // timeout instead of the thing under test. A double-click is what a player does, and it
    // is dispatched without re-checking in between -- so the button really is asked twice,
    // and what refuses the second one is the page.
    await button("Create", dbl).dblclick();
    await on("names", dbl);
    // Proving something did not happen, which is the one place a fixed wait is right.
    await settle();
    const after = await listed();
    assert.equal(
        after.filter((id) => before.indexOf(id) < 0).length,
        1,
        "two clicks on Create, one room in the public list",
    );
}

// AC2 on its own, with no second click for AC1's binding to intercept: a hash route
// supersedes through the same `connect()` a button does, so this is `pending.close()`
// itself under test, not the binding backstopping a double click (#89).
async function superseded_create_closes() {
    const sup = await (await make_context("superseded")).newPage();
    await sup.routeWebSocket(/\/ws/, (ws) => {
        const relay = ws.connectToServer();
        relay.onMessage((frame) => setTimeout(() => ws.send(frame), 300));
    });
    const listed = async () =>
        (await fetch(origin + "/api/rooms").then((res) => res.json())).map((room) => room.id);
    await sup.goto(origin + "/");
    const before = await listed();
    await click("Create a room", sup);
    await on("create", sup);
    await screen("create", sup).locator('input[type="checkbox"]').check();
    await click("Create", sup);
    // Walked away before the create ever answered -- a room code hash, not a second click.
    await sup.evaluate(() => (window.location.hash = "#ZZZZZ"));
    // Both delayed answers land inside this: the abandoned create's, and the new join's.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await listed();
    assert.deepEqual(
        after.filter((id) => before.indexOf(id) < 0),
        [],
        "a superseded create leaves no room in the public list (#89)",
    );
}

// Rejoining a match that will not have you (#89). The ask set a flag cleared on three paths,
// and a `start` that never became a match was none of them -- so a failed rejoin left the
// button silently doing nothing for the rest of the match.
//
// Three failures, each arranged so it can only be reached by one production code path, and
// a fourth press that recovers:
//   1. the level fetch itself rejecting -- on the level the host's match is actually
//      running, blocked from before this guest ever loads the room, because `get_level`
//      caches a *successful* fetch for the page's lifetime and this is the only window in
//      which one has not happened yet (AC5);
//   2. a state `decode_snapshot` answers null for -- the early return out of `build`, above
//      `on_match_start`, once the level above is let through (AC3/AC4);
//   3. an ask the relay never hears -- nothing answers it and nothing fails it, so the only
//      thing that ends it is the bound the client puts on it (AC4).
async function rejoin_fails() {
    const host = await (await make_context("rejoin-host")).newPage();
    await host.goto(origin + "/");
    await click("Create a room", host);
    await on("create", host);
    await screen("create", host).locator("input.code").fill(room_n);
    await click("Create", host);
    await on("names", host);
    await host.keyboard.press("ArrowUp");
    await until("the host's participant", async () => (await seats(host).count()) === 1);
    await click("Take the seats", host);
    await on("room", host);
    // Caves, so failure 1 below has a level of its own to block the fetch of -- the same
    // level the rest of the suite already exercises.
    await open_settings(host);
    await level_select(host).selectOption("caves");
    await click("Apply to the next match", host);
    await click("Start the match", host);
    await on("play", host);

    const guest = await (await make_context("rejoin-guest")).newPage();
    // Failure 1, armed from before the guest ever loads the page: `get_level` never caches
    // a rejected fetch (its catch deletes the entry), so every attempt while this is on
    // fails afresh, and turning it off recovers rather than replaying a cached failure.
    // Starts on: the lobby's own `preload` fetches this level the moment the room's config
    // arrives, well before any of the failures below, and a fetch that succeeds once stays
    // cached for the rest of the page's life -- this is the only window this failure is
    // reachable in at all.
    let block_level = true;
    await guest.route("**/levels/caves/caves.dat", (route) =>
        block_level ? route.abort() : route.continue(),
    );
    // Failure 2: corrupt every `start` carrying a snapshot, until told to stop. A counter
    // rather than this flag would corrupt every attempt forever, including the one meant to
    // recover (#89). Off at first: failure 1 above must be the only way the first ask fails.
    let break_start = false;
    // Failure 3: the ask nothing ever answers and nothing ever fails.
    let deaf = false;
    let broken = 0;
    // Every `resync` this guest ever sends, counted regardless of `deaf`: proves the latch
    // (#89 MUST FIX 3) below rather than just the visible error text, which a stray re-ask
    // would show identically.
    let resync_count = 0;
    await guest.routeWebSocket(/\/ws/, (ws) => {
        const relay = ws.connectToServer();
        ws.onMessage((frame) => {
            if (String(frame).includes('"resync"')) resync_count++;
            if (deaf && String(frame).includes('"resync"')) return;
            relay.send(frame);
        });
        relay.onMessage((frame) => {
            const msg = JSON.parse(String(frame));
            // A state `decode_snapshot` answers null for, which is the return out of
            // `build` that happens above `on_match_start`.
            if (break_start && msg.type === "start" && msg.snapshot) {
                msg.snapshot = "not a snapshot";
                broken++;
            }
            ws.send(JSON.stringify(msg));
        });
    });
    const said = () => text(screen("room", guest).locator("p.err"));

    await guest.goto(origin + "/#" + room_n);
    await on("names", guest);
    await guest.keyboard.press("ArrowUp");
    await until("the guest's participant", async () => (await seats(guest).count()) === 1);
    // Renamed: both couches default their first bunny to Dott, and the host already holds
    // it, so taking the seat unrenamed is a collision (NAME_TAKEN) rather than the mid-match
    // join this walk is about.
    await seats(guest).nth(0).locator("input").fill("Zip");
    await seats(guest).nth(0).locator("input").blur();
    await click("Take the seats", guest);
    await on("room", guest);
    // Seated into a match already running, so the page asks to be let into it by itself,
    // straight into the level fetch blocked above (AC5).
    let t0 = Date.now();
    // `get_level`'s own message, not `resume_failed`'s generic one: more specific, and
    // "try again" would be wrong advice on a level that will not load.
    await until("the failure on screen", async () => /would not load/.test(await said()));
    // Under the 5s `RESUME_MS` bound with room to spare -- 2000-2900ms is the honest worst
    // case (fast local setup, a late host snapshot) against this budget. Without
    // `get_level`'s own rejection reaching `start_failed`, nothing shows this until that
    // timeout backstops it, and the text alone would read the generic message either way --
    // only the clock (and now the wording) tells the two apart.
    assert.ok(
        Date.now() - t0 < 4000,
        "the level fetch's own rejection said so, not the 5s timeout (#89)",
    );
    assert.equal(resync_count, 1, "one ask, one failure, before anything re-arms it");

    // MUST FIX 3 (#89): a room broadcast (a bystander taking a seat) must not retry the
    // latched failure on its own -- only `rejoin_match` may.
    const bystander_seen = [];
    const bystander = relay_client({ type: "join", id: room_n }, bystander_seen);
    await until("the bystander into the room", () =>
        bystander_seen.some((msg) => msg.type === "joined"),
    );
    bystander.send({ type: "take", seat: 2, name: "Bystander" });
    await until("the room to see the bystander seated", () =>
        bystander_seen.some((msg) => msg.type === "room" && msg.seats[2] === "Bystander"),
    );
    assert.equal(resync_count, 1, "a room broadcast alone must not retry a failed ask (#89)");
    bystander.close();

    // Failure 2 (AC3): the level is let through now, so a fresh press succeeds at fetching
    // it and fails only on the corrupted snapshot underneath.
    block_level = false;
    break_start = true;
    t0 = Date.now();
    await click("Rejoin the match", guest);
    assert.equal(await said(), "", "pressing it again clears the last answer");
    await until("the relay's answer, broken on the way in", () => broken > 0);
    await until("the failure on screen", async () => /did not work/.test(await said()));
    assert.ok(
        Date.now() - t0 < 3000,
        "the corrupted snapshot's own early return said so, not the 5s timeout (#89)",
    );

    // Failure 3 (AC4): the ask the relay never hears. Nothing answers it and nothing fails
    // it, so the only thing that can end it is the bound the client puts on it -- this one
    // is supposed to take the full timeout, unlike the two above.
    deaf = true;
    await click("Rejoin the match", guest);
    await until("the ask to time out", async () => /did not work/.test(await said()));

    // None of the three failures latched it: the fourth press is the one that works.
    deaf = false;
    break_start = false;
    await click("Rejoin the match", guest);
    await on("play", guest);
}

async function phone() {
    const phone_context = await make_context("phone", { viewport: { width: 390, height: 844 } });
    const phone_page = await phone_context.newPage();
    const errors = [];
    phone_page.on("pageerror", (error) => errors.push(error.message));
    const fits = async (where) =>
        assert.ok(
            await phone_page.evaluate(
                () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
            ),
            "nothing runs off the side of " + where,
        );

    await phone_page.goto(origin + "/");
    await fits("the landing screen");

    await click("Play offline", phone_page);
    await on("names", phone_page);
    await phone_page.keyboard.press("ArrowUp");
    await until("the participant", async () => (await seats(phone_page).count()) === 1);
    await fits("the couch");

    await click("Take the seats", phone_page);
    await on("room", phone_page);
    await fits("the lobby");
    await open_settings(phone_page);
    await fits("the lobby with the room settings open");

    assert.deepEqual(errors, [], "and the page threw nothing at phone width");
}

// --- the socket dies under a live match (#42) ------------------------------------------
// Its own context, because the drop is done by closing the page's real socket: every
// `WebSocket` the page opens is kept, and the last one is the transport the room is on. That
// is a real close, seen by the relay as a real disconnect -- which is the whole point, since
// what is under test is the seat being held and handed back.

async function reconnect() {
    const context = await make_context("reconnect");
    await context.addInitScript(() => {
        const Native = window.WebSocket;
        window.__sockets = [];
        window.WebSocket = function (...args) {
            const socket = new Native(...args);
            window.__sockets.push(socket);
            return socket;
        };
        window.WebSocket.prototype = Native.prototype;
        Object.assign(window.WebSocket, Native);
    });
    const dropped = await context.newPage();
    const errors = [];
    dropped.on("pageerror", (error) => errors.push(error.message));
    // AC4 (#92): the tick a resumed snapshot was packed on, against the tick it arrived
    // with. Nothing else in this page reaches the console, so a match here is unambiguous.
    const console_lines = [];
    dropped.on("console", (msg) => console_lines.push(msg.text()));

    // Somebody else hosts, so the match this page drops out of goes on being played: a host
    // that leaves takes the match with it, and there would be nothing to come back to.
    const host_saw = [];
    const host = relay_client({ type: "create", id: room_f }, host_saw);
    await until("the room", () => host_saw.some((msg) => msg.type === "joined"));
    host.send({ type: "seats", names: ["Host"] });
    await until("the host to sit down", () =>
        host_saw.some((msg) => msg.type === "room" && msg.host),
    );

    await dropped.goto(origin + "/");
    await click("Join with a room code", dropped);
    await on("join", dropped);
    await screen("join", dropped).locator("input").fill(room_f);
    await click("Continue", dropped);
    await on("names", dropped);
    await dropped.keyboard.press("ArrowUp");
    await until("the participant", async () => (await seats(dropped).count()) === 1);
    await click("Take the seats", dropped);
    await on("room", dropped);
    await click("Ready", dropped);
    host.send({ type: "start", seed: 4321, settings: {}, held: [] });
    await on("play", dropped);
    // The state the relay hands back on the way in, which is what a client rejoining a match
    // in progress is given (#40): without one there is a seat to reclaim but no match to
    // play from. The relay never decodes a body, so an empty simulation of the right size is
    // as good as a played one.
    // t: 5 on the wire, against an all-zero packed body -- `unpack_snapshot` reads its tick
    // out of the body itself, so this one is packed at 0 and arrives claiming 5, which is
    // exactly the disagreement AC4 exists to report (#92).
    host.send({
        type: "snapshot",
        t: 5,
        matrix: new Array(16).fill(0),
        body: encode_snapshot(new Int32Array(SNAPSHOT_INTS)),
    });

    await dropped.evaluate(() => window.__sockets[window.__sockets.length - 1].close());
    await until("the page to say the connection went", async () =>
        (await text(dropped.locator(".reconnecting"))).includes("Connection lost"),
    );
    assert.equal(
        await dropped.evaluate(() => window.location.hash),
        "#play",
        "the match freezes where it was rather than walking the player out of the room (#42)",
    );

    // The first retry is a second away, and the seat was reserved for this page's token for
    // the whole of it: it comes back to the same seat, in the same match, by asking to be
    // let into it exactly as a mid-match joiner does (#40).
    await until("the page to get back in", async () => {
        const said = await text(dropped.locator(".reconnecting"));
        return !said.includes("Connection lost");
    });
    await on("play", dropped);
    // Playwright's ConsoleMessage.text() does not do the browser's own %d substitution --
    // it hands back the literal format string with the arguments appended, space-separated
    // (`console.log`'s own template, then `0 5`, not "tick 0 arrived as tick 5").
    assert.ok(
        console_lines.some(
            (line) =>
                line.startsWith("snapshot packed at tick %d arrived as tick %d") &&
                line.endsWith("0 5"),
        ),
        "AC4: the packed tick and the tick it arrived with disagree, and it says so (#92)",
    );
    assert.deepEqual(
        host_saw.filter((msg) => msg.type === "room").pop().seats,
        ["Host", "Dott", null, null],
        "and the room never lost the seat it was holding for it",
    );
    // Take seat, from the page rather than from the protocol: this one walks back to the
    // lobby with the match still running, and sits down on a bunny the AI is driving. That
    // grows the couch past the one participant it named at the names screen, on a control
    // scheme nobody here is using -- and hands it the match back with both seats in it,
    // because the seat it just took is the AI's until the relay says otherwise (#42).
    await click("Back to the lobby", dropped);
    await on("room", dropped);
    await click("Take seat (A D W)", dropped);
    await until("the room to seat it twice", () => {
        const room = host_saw.filter((msg) => msg.type === "room").pop();
        return room && room.seats[2] === "Jiffy";
    });
    await on("play", dropped);
    await click("Back to the lobby", dropped);
    await on("room", dropped);
    assert.deepEqual(
        await room_view(dropped),
        [
            ["Host", "ready", "Dott"],
            ["Dott", "not ready", "Jiffy"],
            ["Jiffy", "not ready", "Fizz"],
            ["AI", "ready", "Miji"],
        ],
        "one client, two seats, named after the first two bunnies nobody in the room was",
    );
    assert.deepEqual(errors, [], "and the page threw nothing while it was away");
    host.close();
}

// --- Back, Forward and reload (#87) -----------------------------------------------------
// `goBack`/`goForward` across two hashes of one document are same-document navigations: no
// reload, the Knockout instance survives, and the only thing that runs is the `hashchange`
// listener at `apply_route` -- exactly where all three holes were. `reload()` is the other
// animal: the document is destroyed and `apply_route` runs once from the constructor, with
// only the hash and `sessionStorage` surviving; the socket does not, so the relay sees a
// real disconnect and this is #42's reconnect path underneath.

// Point A (host half) and C's Forward: the page hosts a room with a node-side second seat,
// so the room outlives the page and "the match ended for everyone" is read off the relay's
// own messages instead of the DOM.
async function history_host_back() {
    const context = await make_context("history_host_back");
    const hpage = await context.newPage();
    const errors = [];
    hpage.on("pageerror", (error) => errors.push(error.message));

    await hpage.goto(origin + "/");
    await click("Create a room", hpage);
    await on("create", hpage);
    await screen("create", hpage).locator("input.code").fill(room_j);
    await click("Create", hpage);
    await on("names", hpage);
    await hpage.keyboard.press("ArrowUp");
    await until("the participant", async () => (await seats(hpage).count()) === 1);
    await click("Take the seats", hpage);
    await on("room", hpage);

    // Hole C's own reproduction, before anything has started: a session exists from the
    // lobby on (`apply_route`'s `room` branch), so "there is a game" never meant "a match
    // is running" -- reaching for `#play` here must bounce, not draw chrome over a blank
    // canvas (#87).
    await hpage.evaluate(() => (window.location.hash = "play"));
    await until(
        "the lobby's own session not to make the match screen reachable (#87)",
        async () => (await hash(hpage)) === "#room",
    );

    // A second, node-side seat, joined once the room exists, so the room outlives the page
    // and so "the match ended for everyone" is read off the relay's own messages instead of
    // the DOM.
    const seen = [];
    const mate = relay_client({ type: "join", id: room_j }, seen);
    // The constructor's callback only ever sees `joined`/`room`/`error` (that is what
    // `on_room` is); `start` and `match_end` are everything else, and reach `seen` only
    // through this.
    mate.receive((msg) => seen.push(msg));
    await until("the mate to join", () => seen.some((msg) => msg.type === "joined"));
    mate.send({ type: "seats", names: ["Ghost"] });
    await until("the mate to sit down", () =>
        seen.some((msg) => msg.type === "room" && (msg.seats || []).includes("Ghost")),
    );
    // Readied before the host's own Start, so the host's `start` message finds the room
    // already `all_ready()` and begins at once, no countdown to wait out
    // (server/index.js:1057-1061).
    mate.send({ type: "ready", ready: true });

    await click("Start the match", hpage);
    await on("play", hpage);
    await until("the relay to run the match", () => seen.some((msg) => msg.type === "start"));

    await hpage.goBack(); // #play -> #room
    await on("room", hpage);
    await until("the room to hear the match end", () =>
        seen.some((msg) => msg.type === "match_end" && msg.reason === "lobby"),
    );
    assert.equal(
        last_room(seen).started,
        false,
        "browser Back out of a live match ends it for the room, exactly as the button does (#87)",
    );

    // Forward is hole C proving itself: the match is over, so `#play` must bounce straight
    // back.
    const before = (await hashes(hpage)).length;
    await hpage.goForward(); // #room -> #play -> (bounce) -> #room
    await until(
        "the match screen to bounce back to the lobby",
        async () => (await hashes(hpage)).length >= before + 2,
    );
    const walked = (await hashes(hpage)).slice(before);
    assert.equal(walked[0], "#play", "Forward really re-entered the match route");
    assert.equal(
        await hash(hpage),
        "#room",
        "and a match that is over is not a match screen you can reach (#87)",
    );

    // Back once more, which guards the bounce's `replace`: both history entries now read
    // "#room", so this Back fires no `hashchange` at all -- gated on the count, not the
    // hash, or a regression bouncing a second time would read "#room" anyway (#87).
    const n = (await hashes(hpage)).length;
    await hpage.goBack();
    await settle();
    assert.equal(
        (await hashes(hpage)).length,
        n,
        "the bounce replaced rather than pushed, so Back does not walk into it again (#87)",
    );

    // Reload, at #room, no match running -- the cheap half of the reload story.
    const room_before = await room_view(hpage);
    await hpage.reload();
    await on("room", hpage);
    assert.deepEqual(
        await room_view(hpage),
        room_before,
        "a reload reclaims the seats from the token in sessionStorage and nothing else (#7)",
    );

    assert.deepEqual(errors, [], "and the page threw nothing");
    mate.close();
}

// Point A (non-host half) and the reload out from under a live match: a node host runs the
// room so it survives the page's reload, which is a real disconnect to the relay (#42).
async function history_reload_in_match() {
    const context = await make_context("history_reload_in_match");
    const page2 = await context.newPage();
    const errors = [];
    page2.on("pageerror", (error) => errors.push(error.message));
    // The wire itself, not just the room's reaction to it: `host &&` in `end_match`'s guard
    // is backstopped by the relay's own `if (!client.host) return` on `match_end`, so a
    // missing client-side term is invisible in `boss_saw` either way -- this is what
    // actually kills that mutant (#87).
    const sent = [];
    page2.on("websocket", (ws) => ws.on("framesent", ({ payload }) => sent.push(String(payload))));

    const boss_saw = [];
    const boss = relay_client({ type: "create", id: room_k }, boss_saw);
    // `match_end` and `driver` are not `joined`/`room`/`error`, so they only ever reach
    // `boss_saw` through this.
    boss.receive((msg) => boss_saw.push(msg));
    await until("the room", () => boss_saw.some((msg) => msg.type === "joined"));
    boss.send({ type: "seats", names: ["Boss"] });
    await until("the boss to sit down", () =>
        boss_saw.some((msg) => msg.type === "room" && msg.host),
    );

    await page2.goto(origin + "/");
    await click("Join with a room code", page2);
    await on("join", page2);
    await screen("join", page2).locator("input").fill(room_k);
    await click("Continue", page2);
    await on("names", page2);
    await page2.keyboard.press("ArrowUp");
    await until("the participant", async () => (await seats(page2).count()) === 1);
    await click("Take the seats", page2);
    await on("room", page2);
    await click("Ready", page2);
    boss.send({ type: "start", seed: 4321, settings: {}, held: [] });
    await on("play", page2);

    // Snapshotted on a loop rather than once, because a reload's `resync` is answered by
    // the relay's *next* snapshot when it lands before one exists (server/index.js:757-760):
    // the loop is what makes "the page gets back into the match" a fact rather than a race
    // between two sockets.
    const snapshots = setInterval(
        () =>
            boss.send({
                type: "snapshot",
                t: 0,
                matrix: new Array(16).fill(0),
                body: encode_snapshot(new Int32Array(SNAPSHOT_INTS)),
            }),
        200,
    );

    await page2.reload();
    // Both terms are load-bearing, not redundant: a reload preserves the hash, so
    // `hash === "#play"` alone is already true the instant the page comes back, before
    // `apply_route` has done anything -- and `on("play")` would pass just as vacuously, on
    // the brief `#play` chrome `apply_route` paints before routing back through `#room` and
    // out to the match again. `routes` (deferred, reset by the reload like everything but
    // the hash and `sessionStorage`) is what pins down that the page actually walked
    // through both screens rather than sitting on the one it reloaded with.
    await until("the page back into the match it reloaded out of", async () => {
        const walked = await routes(page2);
        return walked.length >= 2 && (await hash(page2)) === "#play";
    });
    await on("play", page2);
    assert.equal(
        last_room(boss_saw).seats[1],
        "Dott",
        "a reload is a disconnect, and the seat was reserved for the token it came back with (#42)",
    );
    assert.ok(
        !boss_saw.some((msg) => msg.type === "match_end"),
        "and nothing ended the match on the room's behalf",
    );

    // The non-host half of AC1: Back out of a match this page does not host.
    const seats_before = boss_saw.length;
    await page2.goBack(); // #play -> #room
    await on("room", page2);
    // The negative made deterministic by ordering, not a timer: `release_seats()`'s
    // `driver:"ai"` stamp is sent in the same `end_match` call an announce would have been,
    // and it is waited for first -- an announce would already be in `boss_saw` by the time
    // the driver stamp is.
    await until("the seat handed to the AI", () =>
        boss_saw.slice(seats_before).some((msg) => msg.type === "driver" && msg.driver === "ai"),
    );
    assert.ok(
        !boss_saw.some((msg) => msg.type === "match_end"),
        "a non-host leaving the match does not end it for everybody else (#22, #87)",
    );
    assert.equal(last_room(boss_saw).started, true, "the room is still playing it");
    assert.ok(
        !sent.some((f) => f.includes('"match_end"')),
        "a non-host does not even say it (#22, #87)",
    );

    // Forward must bounce -- the page left the match, so its new lobby session has
    // `in_match === false`.
    const n = (await hashes(page2)).length;
    await page2.goForward();
    await until("the bounce", async () => (await hashes(page2)).length >= n + 2);
    assert.equal(
        await hash(page2),
        "#room",
        "Forward does not walk a client back into a match it left (#37, #87)",
    );

    clearInterval(snapshots);
    assert.deepEqual(errors, [], "and the page threw nothing");
    boss.close();
}

// Point B: a room link followed while seated must leave the room being left at once, not
// on reservation expiry.
async function history_link_while_seated() {
    const context = await make_context("history_link_while_seated");
    const page3 = await context.newPage();
    const errors = [];
    page3.on("pageerror", (error) => errors.push(error.message));

    // The room being left, held open by a node client so it outlives the page and so its
    // `room` messages are still readable once the page has gone.
    const left_saw = [];
    const left_client = relay_client({ type: "create", id: room_l }, left_saw);
    await until("the room", () => left_saw.some((msg) => msg.type === "joined"));
    // The room being followed into, which has to actually exist on the relay or the join
    // is refused and lands on the password screen rather than the names screen.
    const other_saw = [];
    const other_client = relay_client({ type: "create", id: room_m }, other_saw);
    await until("the other room", () => other_saw.some((msg) => msg.type === "joined"));

    await page3.goto(origin + "/");
    await click("Join with a room code", page3);
    await on("join", page3);
    await screen("join", page3).locator("input").fill(room_l);
    await click("Continue", page3);
    await on("names", page3);
    await page3.keyboard.press("ArrowUp");
    await until("the participant", async () => (await seats(page3).count()) === 1);
    await click("Take the seats", page3);
    await on("room", page3);
    await until("the room to seat the page", () =>
        (last_room(left_saw)?.seats || []).includes("Dott"),
    );

    // The link to another room, as a player follows one: a fragment navigation in the page
    // it is already on, not a fresh load -- a fresh load is the reload case below (#87).
    await page3.evaluate((id) => (window.location.hash = id), room_m);

    // The whole of AC2, and its deterministic form of "immediately rather than on
    // reservation expiry": this loop's ceiling is a small fraction of `reserve_ms()`'s 60s
    // default, so a pass means the `{type:"leave"}` really was sent and a regression times
    // out rather than sitting through the window.
    await until("the abandoned room to free the seat at once", () =>
        last_room(left_saw).seats.every((name) => name !== "Dott"),
    );

    await on("names", page3); // the new room grants nothing yet
    await page3.keyboard.press("ArrowUp");
    await until("the participant", async () => (await seats(page3).count()) === 1);
    await click("Take the seats", page3);
    await on("room", page3); // history: #room(l), #join/#names, #room(m)
    const view_before = await room_view(page3);

    await page3.goBack();
    await on("names", page3); // a couch with participants renders as itself
    await page3.goForward();
    await on("room", page3);
    assert.deepEqual(
        await room_view(page3),
        view_before,
        "and Forward comes back to the same room",
    );

    await page3.reload();
    await on("room", page3);
    assert.equal(await hash(page3), "#room");
    assert.deepEqual(
        await room_view(page3),
        view_before,
        "a reload reclaims the new room's seat from its own token (#7)",
    );
    assert.ok(
        last_room(left_saw).seats.every((name) => name !== "Dott"),
        "and the room that was left never gets it back (#87)",
    );

    assert.deepEqual(errors, [], "and the page threw nothing");
    left_client.close();
    other_client.close();
}

// --- a reload into a room that is not there (#88) ---------------------------------------
// The third of the three paths that end on the landing screen, and the cheapest to provoke:
// a reload reads the room id out of `sessionStorage`, so seeding one that was never created
// is the same arrival as a room that ended while the tab was shut. The landing screen had no
// error line at all before #88, so this is also what proves the new one is bound.
async function reload_into_a_dead_room() {
    const gone = await (await make_context("reload_into_a_dead_room")).newPage();
    const errors = [];
    gone.on("pageerror", (error) => errors.push(error.message));
    const dead = new_room_id();

    // MF3 (#90 review): `room_gone` is one of six FLOW_TEXT messages set a route before the
    // pane they land in is revealed -- the reveal-case AC3's live regions cannot announce on
    // their own. Cheapest live-region observation point in the suite: a real reload, not the
    // #42 socket-drop rig. `addInitScript` because the reload below is a fresh document, so
    // anything attached after it would be gone before the mutation it is here to see.
    await gone.addInitScript(() => {
        window.__when = [];
        const sel = "div[data-bind*=\"screen() === 'landing'\"] p.err";
        // A bootstrap observer just to catch the node existing (it is static markup, present
        // before Knockout binds anything), then the real one is scoped to that node alone --
        // watching the whole document would also fire on an unrelated mutation elsewhere
        // once the pane happens to be visible, which proves nothing about this node.
        const attach = () => {
            const p = document.querySelector(sel);
            if (!p) return false;
            new MutationObserver(() =>
                window.__when.push([p.textContent, !!p.offsetParent]),
            ).observe(p, { childList: true, characterData: true, subtree: true });
            return true;
        };
        if (!attach()) {
            const bootstrap = new MutationObserver(() => attach() && bootstrap.disconnect());
            bootstrap.observe(document, { childList: true, subtree: true });
        }
    });

    await gone.goto(origin + "/");
    await gone.evaluate(
        (id) => sessionStorage.setItem("jnb:room", JSON.stringify({ id: id })),
        dead,
    );
    await gone.goto(origin + "/#room");

    await until("the landing screen", async () => (await hash(gone)) === "#landing");
    assert.equal(
        await err_on("landing", gone),
        FLOW_TEXT.room_gone,
        "a reload into a room that will not have it back says so, rather than dropping the " +
            "player on a silent title screen (#88)",
    );
    const when = await gone.evaluate(() => window.__when);
    assert.ok(
        when.some(([shown, visible]) => visible && shown.includes("would not")),
        "the message is re-touched once its pane is visible, not left silent behind the " +
            "screen it was set on one route earlier (#90): " +
            JSON.stringify(when),
    );
    assert.deepEqual(errors, [], "and the page threw nothing on the way out");
    await gone.close();
}

// --- the reservation window runs out (#42, #88) -----------------------------------------
// The first of the three paths that end on the landing screen, and the one that has a
// sentence of its own: the retries did not get back in before the seats stopped being this
// client's, so what it lost is the seats. Its own page, on a fake clock: giving up is the
// *page's* decision, taken against the window the relay named on the way in, so winding
// that page's clock past the window runs it out. Writing `RESERVE_MS` here instead would
// be a no-op in CI, where the relay is in a container and this process's env reaches
// nothing -- which is how this walk came to pass locally and time out there.
async function reconnect_gives_up() {
    const context = await make_context("reconnect_gives_up");
    // The same socket recorder `reconnect()` installs: the last socket the page opened is
    // the transport the room is on, and closing it is a real disconnect the relay sees.
    await context.addInitScript(() => {
        const Native = window.WebSocket;
        window.__sockets = [];
        window.WebSocket = function (...args) {
            const socket = new Native(...args);
            window.__sockets.push(socket);
            return socket;
        };
        window.WebSocket.prototype = Native.prototype;
        Object.assign(window.WebSocket, Native);
    });
    const abandoned = await context.newPage();
    const errors = [];
    abandoned.on("pageerror", (error) => errors.push(error.message));

    // Somebody else hosts, so the room outlives the page that walks out of it.
    const room_id = new_room_id();
    const host_saw = [];
    const host = relay_client({ type: "create", id: room_id }, host_saw);
    await until("the room", () => host_saw.some((msg) => msg.type === "joined"));
    host.send({ type: "seats", names: ["Hosty"] });
    await until("the host on a seat", () =>
        host_saw.some((msg) => msg.type === "room" && msg.held.length),
    );

    // Installed before the first navigation, as `self_ending_match()` does it, and on a
    // page of its own because the clock is the context's.
    await abandoned.clock.install();
    await abandoned.goto(origin + "/#" + room_id);
    await on("names", abandoned);
    await abandoned.keyboard.press("ArrowUp");
    await until("the participant", async () => (await seats(abandoned).count()) === 1);
    await click("Take the seats", abandoned);
    await on("room", abandoned);

    await abandoned.evaluate(() => window.__sockets[window.__sockets.length - 1].close());
    // Wound only once the page has taken the drop: `reconnect_until` is set when the socket
    // dies, so a wind before that would be wound off a clock the deadline is then measured
    // from. The overlay is hidden on the lobby screen -- `textContent` reads it anyway, and
    // that it is bound at all is `reconnect()`'s.
    await until("the page to say the connection went", async () =>
        (await text(abandoned.locator(".reconnecting"))).includes("Connection lost"),
    );
    // Two minutes in no real time, which has to outrun whatever `reserve` the relay named
    // (sixty seconds by default). A jump fires the armed retry once, at the far end of the
    // jump, where it is already past the deadline: this is `give_up`, not the reconnect
    // `reconnect()` proves. A relay whose window ever outgrows this fails here as a
    // timeout rather than quietly reconnecting instead.
    await abandoned.clock.fastForward("02:00");
    await until("the landing screen", async () => (await hash(abandoned)) === "#landing");
    assert.equal(
        await err_on("landing", abandoned),
        FLOW_TEXT.gave_up,
        "the title screen a spent reconnect gives up onto says what was lost, not just that " +
            "a socket went (#42, #88)",
    );
    assert.deepEqual(errors, [], "and the page threw nothing while it was away");
    host.close();
    await abandoned.close();
}

// --- keyboard only, and announced (#90) -------------------------------------------------
// Driven by keys and nothing else: every screen change asserts where focus landed, every
// text box is submitted with Enter, and a mouse click anywhere in it fails the last
// assertion. The role sweep at the end is markup-presence, not audibility -- it proves every
// live-region node the flow reports through carries the attribute, not that a screen reader
// speaks it (no AT runs in CI).
async function keyboard_only() {
    const kb = await (await make_context("keyboard")).newPage();
    const errors = [];
    kb.on("pageerror", (error) => errors.push(error.message));
    // Playwright's role engine skips hidden elements, so this resolves only while the
    // region really is in the page and carrying the text -- a `visible:`-toggled paragraph
    // and a paragraph with no `role` both match nothing.
    const said = (name, root = kb) => screen(name, root).getByRole("alert").allInnerTexts();

    // 1. Load: focus on a cold load, through the `queueMicrotask` ordering. Not `on()` -- a
    // cold load never writes the hash, so it stays "" rather than becoming "#landing".
    await kb.goto(origin + "/");
    await screen("landing", kb).waitFor({ state: "visible" });
    assert.equal(await focused(kb), "BUTTON.pri:Quick Join", "focus on a cold load");
    await kb.evaluate(() => (window.__same_page = true));

    // 2. Landing -> create by key.
    await tab_to("Create a room", kb);
    await kb.keyboard.press("Enter");
    await on("create", kb);
    assert.equal(await focused(kb), "INPUT.code:text");

    // 3. AC1 in place, AC3 in place. The empty-region assertion runs *before* the Enter --
    // Knockout's `text` binding writes synchronously, so asserting it after would only prove
    // the refusal landed, not that the region was there to hear it in.
    assert.deepEqual(
        await said("create", kb),
        [""],
        "the alert region is in the page, empty, before anything is typed into it",
    );
    await kb.keyboard.type("ABC");
    await kb.keyboard.press("Enter");
    await until("the refusal", async () =>
        (await said("create", kb)).some((line) => line.includes("5 letters")),
    );

    // 4. Create for real.
    await kb.keyboard.press("Control+A");
    await kb.keyboard.type(room_o);
    await kb.keyboard.press("Enter");
    await on("names", kb);

    // 5. The names exception: focus lands on the pane, not a control, or the couch keys
    // below would be swallowed by a focused text box (`is_typing`, game_session.js).
    assert.equal(await focused(kb), "DIV.kiosk");
    await kb.keyboard.press("ArrowUp");
    await until("the first participant", async () => (await seats(kb).count()) === 1);

    // 6. AC1 on the names form.
    await kb.keyboard.press("Tab");
    assert.equal(await focused(kb), "INPUT.grow:text");
    await kb.keyboard.press("Enter");
    await on("room", kb);

    // 7. Lobby focus.
    assert.equal(await focused(kb), "BUTTON.sm:Copy join link");

    // 8. A keeper client so the room outlives this walk's own `Leave` at step 12. No seats,
    // so it neither readies nor blocks a start.
    const keeper_saw = [];
    const keeper = relay_client({ type: "join", id: room_o }, keeper_saw);
    await until("the keeper in the room", () => keeper_saw.some((msg) => msg.type === "joined"));

    // 9. AC1 on the settings form, AC3 on the staged banner. "Bumps to win" gets a value
    // past its `max="99"` on purpose (review MUST FIX 3): a blank number box is valid and
    // submits, so only an out-of-range one makes the `novalidate` mutation fail. "Minutes"
    // carries a real, in-range change so the staged banner has something to stage even
    // though the relay's own `config_diff` drops the out-of-range field silently.
    await tab_to("Room settings", kb);
    await kb.keyboard.press("Enter"); // native <details>
    await tab_to(":number", kb);
    await kb.keyboard.press("Control+A");
    await kb.keyboard.type("999");
    await kb.keyboard.press("Tab");
    await kb.keyboard.press("Control+A");
    await kb.keyboard.type("3");
    await kb.keyboard.press("Enter");
    await until(
        "the staged change",
        async () =>
            (await screen("room", kb)
                .getByRole("status")
                .filter({ hasText: "Host staged" })
                .count()) > 0,
    );

    // 10. AC1 on the password form, AC3 on the notice -- #88's review item. The `isVisible()`
    // before the Enter is the whole point: false the moment anybody restores `visible:
    // notice`, and false if the `.notice` min-height rule is dropped.
    await tab_to(":password", kb);
    await kb.keyboard.type("hunter2");
    const live = screen("room", kb).locator('p[data-bind*="text: notice"]');
    assert.equal(await text(live), "", "nothing said yet");
    assert.ok(
        await live.isVisible(),
        "and the region is already in the page: a live region is announced on a change while " +
            "it is there, never on being revealed with the message already inside it (#88, #90)",
    );
    await kb.keyboard.press("Enter");
    await until("password set", async () => (await notice(kb)) === "Password set.");
    assert.equal(
        await screen("room", kb).getByRole("status").filter({ hasText: "Password set." }).count(),
        1,
        "said through a live region, not just rendered",
    );

    // Review MUST FIX 4: a route onto the screen already showing must not steal focus from a
    // box somebody is typing in. Deleting the `activeElement` early return in `focus_screen`
    // turns this red -- focus would jump to `Copy join link` instead.
    await kb.evaluate(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
    assert.equal(
        await focused(kb),
        "INPUT:password",
        "a route onto the screen already showing does not steal the box",
    );

    // 11. AC4 to a match. Ready is *above* the settings in document order, so backwards --
    // and it reads "Ready", not "Not ready", because step 9's staged change just cleared
    // everyone's ready flag, this client's included.
    await tab_to("Ready", kb, "Shift+Tab");
    await kb.keyboard.press("Enter");
    const ready_button = screen("room", kb).locator('button[data-bind*="toggle_ready"]');
    await until("ready", async () => (await text(ready_button)) === "Not ready");
    await tab_to("Start the match", kb);
    await kb.keyboard.press("Enter");
    await on("play", kb);

    // 12. AC2's deliberate no-op, and out again.
    assert.equal(await focused(kb), "BODY", "the match screen focuses nothing of its own");
    await tab_to("Back to the lobby", kb);
    await kb.keyboard.press("Enter");
    await on("room", kb);
    await tab_to("Leave", kb);
    await kb.keyboard.press("Enter");
    await on("landing", kb);
    assert.equal(await focused(kb), "BUTTON.pri:Quick Join");

    // 13. AC1 on the join and password screens -- the room now has a password, so the relay
    // refuses and the flow lands on the password screen rather than straight into names.
    await tab_to("Join with a room code", kb);
    await kb.keyboard.press("Enter");
    await on("join", kb);
    assert.equal(await focused(kb), "INPUT.code:text");
    await kb.keyboard.type(room_o);
    await kb.keyboard.press("Enter");
    await on("password", kb);
    assert.equal(await focused(kb), "INPUT:password");
    // Reveal-case, not a second in-place refusal like step 3's: `not_accepted` is set on the
    // join screen (viewmodels.js:952) one route before `go("password", true)` shows the
    // pane it lands in, so this only proves the text arrives -- it is not peer evidence for
    // AC3's announce-case, which step 3's create refusal is the walk's one instance of.
    await until("the refusal", async () =>
        (await said("password", kb)).some((line) => line.includes("not accepted")),
    );
    await kb.keyboard.type("hunter2");
    await kb.keyboard.press("Enter");
    await on("names", kb);

    // 14. The two sweeps, because AC3 is an "every" criterion.
    const unroled = await kb.evaluate(
        () =>
            [...document.querySelectorAll('div[data-bind*="screen() ==="] p.err')].filter(
                (el) => el.getAttribute("role") !== "alert",
            ).length,
    );
    assert.equal(unroled, 0, "every screen's error line is an alert region (#90)");

    // The paragraphs the flow reports an outcome through, each found by its own binding.
    // Presence, not audibility: a change-detector on the markup shape (edit this list when a
    // line's data-bind changes), not an invariant on behaviour -- two of these ten roles are
    // checked in place above too (staged_text at step 9, notice at step 10); this is what
    // covers the other eight.
    const LIVE = [
        "text: connection_text", // the match's reconnect line
        "visible: pending_id", // Connecting...
        "visible: match_running", // the names screen's
        "visible: disconnected", // connection lost
        "visible: staged_text", // the host staged a change
        "visible: match_running() &&", // the lobby's
        "visible: queued", // the queue
        "text: waiting_text", // who the room waits on
        "text: notice", // ready cleared, password set
        "text: result_text", // how the last match ended
    ];
    const roles = await kb.evaluate(
        (binds) =>
            binds.map((bind) => {
                const el = document.querySelector('[data-bind*="' + bind + '"]');
                return el ? el.getAttribute("role") : "missing";
            }),
        LIVE,
    );
    assert.deepEqual(
        roles,
        [
            "status",
            "status",
            "status",
            "alert",
            "status",
            "status",
            "status",
            "status",
            "status",
            "status",
        ],
        "every line the flow reports an outcome through is a live region (#90)",
    );

    // 15. The two guards.
    assert.ok(await kb.evaluate(() => window.__same_page === true), "no form ever navigated");
    assert.equal(await kb.evaluate(() => window.__mouse), 0, "and no step used the mouse");
    assert.deepEqual(errors, [], "and the page threw nothing");

    // 16. Browse: names' first control is already pinned exactly by step 5's `focused`
    // assertion, but browse's is whatever rooms the rest of the suite left up, so this is
    // "somewhere in the pane" rather than a named target. Also closes §4.3's unwalked-path
    // gap: AC4's walk otherwise never sets a keyboard foot on the browse screen.
    await tab_to("Start over", kb);
    await kb.keyboard.press("Enter");
    await on("landing", kb);
    await tab_to("Browse rooms", kb);
    await kb.keyboard.press("Enter");
    await on("browse", kb);
    assert.ok(
        await screen("browse", kb).evaluate(
            (pane) =>
                pane.contains(document.activeElement) && document.activeElement !== document.body,
        ),
        "focus landed somewhere inside the browse pane",
    );

    keeper.close();
}

// --- run -------------------------------------------------------------------------------

try {
    await walk();
    await self_ending_match();
    await two_pages();
    await reconnect();
    await reconnect_gives_up();
    await history_host_back();
    await history_reload_in_match();
    await history_link_while_seated();
    await reload_into_a_dead_room();
    await sound();
    await browse();
    await queueing();
    await double_click_create();
    await superseded_create_closes();
    await rejoin_fails();
    await phone();
    await keyboard_only();
    console.log(
        "OK the kiosk flow renders, the couch fills from the keyboard and the relay seats it; " +
            "two pages agree on one room, the mp3s really play, and the page fits a phone",
    );
} catch (error) {
    // Where the page actually was, which a locator timeout never says: "not visible" reads
    // the same whether the flow went nowhere or went somewhere else entirely.
    const where = await page
        .evaluate(() => ({
            hash: window.location.hash,
            showing: [...document.querySelectorAll('div[data-bind*="screen() ==="]')]
                .filter((el) => el.offsetParent !== null)
                .map((el) => el.getAttribute("data-bind").match(/screen\(\) === '(\w+)'/)[1]),
            // Every `p.err`, not just the first in document order, now that every screen has
            // one: an empty one contributes nothing, so this is never longer than it needs
            // to be for whichever screen the page was actually on.
            error: [...document.querySelectorAll("p.err")]
                .map((el) => el.textContent.trim())
                .filter(Boolean)
                .join(" | "),
            // The participant rows are the `participants` array, and an empty one is what
            // bounces the lobby back to the names screen.
            participants: document.querySelectorAll("div[data-bind*=\"screen() === 'names'\"] li")
                .length,
        }))
        .catch(() => null);
    // The main page, which is not the failing one when the fake-clock section is what broke.
    console.error("main page was at:", JSON.stringify(where));
    const routes = await page.evaluate(() => window.__routes || []).catch(() => []);
    console.error("routes the page took (last 20):");
    for (const route of routes.slice(-20)) console.error("  " + route);
    console.error("last frames the page was sent:");
    for (const frame of frames.slice(-25)) console.error("  " + frame);
    // Only on failure: the trace is for reading a timing bug in CI, and a passing run has
    // nothing to read.
    // Every context, not just the one being walked: the failure may be a second page's.
    for (const [name, made] of contexts)
        await made.tracing.stop({ path: "trace-" + name + ".zip" }).catch(() => {});
    if (page_errors.length) console.error("page errors:", page_errors);
    console.error(
        "traces written: " +
            contexts.map(([name]) => "trace-" + name + ".zip").join(", ") +
            " -- npx playwright show-trace <file>",
    );
    throw error;
} finally {
    await browser.close();
    server?.close();
}
process.exit(0);
