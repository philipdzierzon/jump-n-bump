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
// Run by `npm test`, which builds the client first because a browser needs the built one.
// With `JNB_BASE_URL` set the walk runs against that origin instead of booting a server,
// which is how CI points it at the running container. A failure leaves a trace behind.
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { start_server } from "../server/index.js";
import { WebSocket_Transport } from "../src/net/websocket_transport.js";
import { generate_room_id } from "../src/net/room_id.js";

// Boots its own server unless CI handed us one, exactly as `server/smoke.mjs` does.
const given = process.env.JNB_BASE_URL;
const server = given ? null : await start_server(0);
const origin = given ? given.replace(/\/$/, "") : "http://localhost:" + server.address().port;
// Generated rather than fixed, so the walk can be run twice against one long-lived
// container without the second run colliding with the first run's rooms.
const room_a = generate_room_id({});
const room_b = generate_room_id({ [room_a]: true });

// No launch flags: Chromium needs no `--no-sandbox` here, and headless Chrome autoplays
// without being asked to, so a flag would only move the test further from a real browser.
const browser = await chromium.launch();
const context = await browser.newContext();
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
const page_errors = [];
page.on("pageerror", (error) => page_errors.push(error.message));
// What the relay told this page, kept for a failure to print. A flow driven by a socket is
// unreadable from the DOM alone: the screen it ended on says what happened, and this says
// which message did it.
const frames = [];
page.on("websocket", (ws) =>
    ws.on("framereceived", ({ payload }) => frames.push(String(payload).slice(0, 220))),
);

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

    assert.deepEqual(page_errors, [], "and the page threw nothing on the way through");
}

// --- a match that ends by itself (#39) -------------------------------------------------
// Its own page, because a fake clock stops the simulation until it is wound on, which every
// step above would have to wind by hand. The one-minute time limit is reached in no real
// time at all; that the simulation stops on the tick the limit falls is `replay.test.mjs`'s.

async function self_ending_match() {
    const clock_page = await context.newPage();
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

    assert.deepEqual(errors, [], "with nothing thrown on the way");
    await clock_page.close();
}

// --- run -------------------------------------------------------------------------------

try {
    await walk();
    await self_ending_match();
    console.log(
        "OK the kiosk flow renders, the couch fills from the keyboard and the relay seats it",
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
        }))
        .catch(() => null);
    console.error("page was at:", JSON.stringify(where));
    console.error("last frames the page was sent:");
    for (const frame of frames.slice(-12)) console.error("  " + frame);
    // Only on failure: the trace is for reading a timing bug in CI, and a passing run has
    // nothing to read.
    await context.tracing.stop({ path: "trace-flow.zip" });
    if (page_errors.length) console.error("page errors:", page_errors);
    console.error("trace written to trace-flow.zip -- npx playwright show-trace trace-flow.zip");
    throw error;
} finally {
    await browser.close();
    server?.close();
}
process.exit(0);
