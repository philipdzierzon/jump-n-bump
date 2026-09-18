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
import { SNAPSHOT_INTS, decode_snapshot, encode_snapshot } from "../src/game/snapshot.js";

// Boots its own server unless CI handed us one, exactly as `server/smoke.mjs` does.
const given = process.env.JNB_BASE_URL;
const server = given ? null : await start_server(0);
const origin = given ? given.replace(/\/$/, "") : "http://localhost:" + server.address().port;
// Generated rather than fixed, so the walk can be run twice against one long-lived
// container without the second run colliding with the first run's rooms.
const room_a = generate_room_id({});
const room_b = generate_room_id({ [room_a]: true });
const room_c = generate_room_id({ [room_a]: true, [room_b]: true });
const room_d = generate_room_id({ [room_a]: true, [room_b]: true, [room_c]: true });
const room_e = generate_room_id({ [room_a]: true, [room_b]: true, [room_c]: true, [room_d]: true });
const room_f = generate_room_id({
    [room_a]: true,
    [room_b]: true,
    [room_c]: true,
    [room_d]: true,
    [room_e]: true,
});

// No launch flags: Chromium needs no `--no-sandbox` here, and headless Chrome autoplays
// without being asked to, so a flag would only move the test further from a real browser.
const browser = await chromium.launch();

// Every <audio> the page plays, in the order it played them, and whether it is still
// playing. Sound_Player creates them and keeps them to itself -- they are never in the
// document -- so patching the prototype is the only way to see them from out here. A match
// builds one Sound_Player, so a match being played sounds one looping track and a match
// that is over sounds none; two loops at once was a session left running behind the one on
// screen, which is how it was heard (#28, #40). The ordered list is the other half: a set
// says a sound was played at some point, and an order says which event played it (#66).
function record_audio() {
    window.__audio = new Set();
    window.__sounds = [];
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
    contexts.push([name, made]);
    return made;
}

const context = await make_context("flow");
const page = await context.newPage();
const page_errors = [];
page.on("pageerror", (error) => page_errors.push(error.message));
// What the relay told this page, kept for a failure to print. A flow driven by a socket is
// unreadable from the DOM alone: the screen it ended on says what happened, and this says
// which message did it.
const frames = [];
// Every route the page took, recorded in the page because the flow is a hash router: a
// screen that never appeared is nearly always a route that was taken and then taken back.
await page.addInitScript(() => {
    window.__routes = [];
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

const sounding = (root = page) => root.evaluate(() => window.__sounding());
// Every sound played since the list was last forgotten, in the order it was played (#66).
const sounds = (root = page) => root.evaluate(() => window.__sounds);
const forget_sounds = (root = page) => root.evaluate(() => (window.__sounds.length = 0));
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
    await screen("create").locator("input").fill(room_a);
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

    // The board of a match this client never simulated: it was in the lobby for all of it, so
    // the matrix it shows is the one the host counted and announced (#19, #39).
    guest.send({
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
        "Dott wins with 1 bump.",
        "a client that never played the match still gets its board, because the host sent one",
    );
    assert.deepEqual(
        (await grid(board_panel())).slice(1),
        [
            ["Dott", "0", "1", "0", "0", "1"],
            ["Zip", "0", "0", "0", "0", "0"],
            ["Fizz", "0", "0", "0", "0", "0"],
            ["Miji", "0", "0", "0", "0", "0"],
            ["Total deaths", "0", "1", "0", "0", "1"],
        ],
        "seat-keyed and headed by the username on each seat, kills across and deaths down (#13)",
    );

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

    chief.close();
    await click("Leave");
    await on("landing");

    // --- the host is the reference state, and a client joins the match it runs (#40) ---
    // The page hosts and plays. Two seconds in it has packed its own simulation and handed
    // it to the relay, which is what the next client to ask is given: the state, the frames
    // since it, and the settings block that goes with them.

    await click("Create a room");
    await on("create");
    await screen("create").locator("input").fill(room_c);
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
    for (let t = 30; t <= 240; t += 30) boss.send({ type: "checksum", t, h: 1 });
    await until("the repair to land", () => page.locator(".reconnecting").isVisible());
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
// Tick-by-tick agreement of the two simulations is not here. That needs a checksum the
// client does not expose, which is #41; building a feature in order to test it is the wrong
// order round.

async function two_pages() {
    const host = await (await make_context("host")).newPage();
    const guest = await (await make_context("guest")).newPage();
    const errors = [];
    host.on("pageerror", (error) => errors.push("host: " + error.message));
    guest.on("pageerror", (error) => errors.push("guest: " + error.message));

    await host.goto(origin + "/");
    await click("Create a room", host);
    await on("create", host);
    await screen("create", host).locator("input").fill(room_e);
    await click("Create", host);
    await on("names", host);
    await host.keyboard.press("ArrowUp");
    await until("the host's participant", async () => (await seats(host).count()) === 1);
    await click("Take the seats", host);
    await on("room", host);

    await guest.goto(origin + "/");
    await click("Join with a room code", guest);
    await on("join", guest);
    await screen("join", guest).locator("input").fill(room_e);
    await click("Continue", guest);
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
    // Long enough for both simulations to have stepped a good many ticks of one match.
    await settle();
    await settle();

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
    await click("Start the match", sound_page);
    await on("play", sound_page);

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

    // M, which is a keyup in this game. The key stays down over it, so what is being
    // silenced is a bunny that was sounding a moment ago and goes on jumping throughout.
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
    host.send({
        type: "snapshot",
        t: 0,
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

// --- run -------------------------------------------------------------------------------

try {
    await walk();
    await self_ending_match();
    await two_pages();
    await reconnect();
    await sound();
    await phone();
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
            error: document.querySelector("p.err")?.textContent.trim() || "",
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
