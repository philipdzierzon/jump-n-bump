// The deep loss run (#136 §3): two real pages play one match through the real relay, each on
// its own lossy link (test/lossy_proxy.mjs), holding random keys, so a frame the relay has to
// substitute is a frame that differed. It reports the bug tier from what the relay logs and
// what the pages show:
//
// - a desync the relay had to repair, and a client it dropped for needing too many
// - a seat handed to the AI while its player was still connected
// - a `Connection lost` overlay, or a page that left the match
//
// Not part of `npm test`: it takes minutes, and it reports rather than asserts. Build first.
//
//   node test/loss.deep.mjs
//   CONDITIONS=20/1,50/1,50/3 SECONDS=60 SEED=1 node test/loss.deep.mjs
//
// CONDITIONS is a list of one-way-ms/loss-% pairs. IDLE=1 holds no keys, which is the control:
// a released frame then matches the real one, so a late frame cannot desync anything.
// VERBOSE=1 prints the relay's lines for each room. CHROMIUM points at a browser binary when
// the installed Playwright's own build is missing.
import { format } from "node:util";

import { chromium } from "playwright";

import { start_server } from "../server/index.js";
import { make_rnd } from "../src/game/rnd.js";
import { lossy_proxy } from "./lossy_proxy.mjs";

const CONDITIONS = (process.env.CONDITIONS || "20/1,50/1,50/3")
    .split(",")
    .map((c) => c.split("/").map(Number));
const SECONDS = Number(process.env.SECONDS) || 60;
const SEED = Number(process.env.SEED) || 1;
const KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp"];

// The relay logs every repair, drop and hand-over, so the log is the record: kept here and
// sliced per condition, rather than a hook the relay would grow for this.
const log = [];
const print = console.log;
console.log = (...args) => log.push(format(...args));

const server = await start_server(0, 0);
const browser = await chromium.launch(
    process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
const rnd = make_rnd(SEED);
const room_id = () => Array.from({ length: 5 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[rnd(24)]).join("");

const screen = (page, name) => page.locator(`div[data-bind*="screen() === '${name}'"]`).first();
const click = (page, label) =>
    page
        .locator("button:visible")
        .filter({ hasText: new RegExp("^\\s*" + label + "\\s*$") })
        .first()
        .click();
const on = (page, name) =>
    page
        .waitForFunction((n) => window.location.hash === "#" + n, name, { timeout: 30000 })
        .catch(async (error) => {
            const at = await page.evaluate(() => location.hash);
            const err = await page.locator("p.err:visible").allInnerTexts();
            throw new Error(`waiting for #${name}, page is on ${at} ${err.join(" ")}`, {
                cause: error,
            });
        });

async function seat(page, origin, join) {
    await page.goto(origin + "/");
    if (join) {
        await click(page, "Join with a room code");
        await screen(page, "join").locator("input").fill(join);
        await click(page, "Continue");
    } else {
        await click(page, "Create a room");
        await screen(page, "create").locator("input.code").fill(page.room);
        await click(page, "Create");
    }
    await on(page, "names");
    await page.keyboard.press("ArrowUp");
    const participant = screen(page, "names").locator("li input").first();
    // Both couches name their first bunny the same, and a room refuses a second one.
    if (join) await participant.fill("Zip");
    await participant.blur();
    await click(page, "Take the seats");
    await on(page, "room");
}

// Random keys, held for 100-400 ms each, so a bunny is almost always doing something a
// released frame would not.
async function play(page, until) {
    let held = null;
    while (Date.now() < until) {
        if (held) await page.keyboard.up(held);
        held = KEYS[rnd(KEYS.length)];
        await page.keyboard.down(held);
        await page.waitForTimeout(100 + rnd(300));
    }
    if (held) await page.keyboard.up(held);
}

const rows = [];
for (const [one_way, loss_pct] of CONDITIONS) {
    const proxies = [];
    const pages = [];
    for (let i = 0; i < 2; i++) {
        const proxy = await lossy_proxy(server.address().port, {
            one_way,
            loss: loss_pct / 100,
            seed: SEED * 100 + i,
        });
        proxies.push(proxy);
        const page = await (await browser.newContext()).newPage();
        page.origin = "http://127.0.0.1:" + proxy.port;
        page.errors = [];
        page.on("pageerror", (error) => page.errors.push(error.message));
        // The relay never echoes a client's own frames back to it, so a frame for its own seat
        // is one the relay released for it: the frame that missed its deadline (#42). Not the
        // first ten ticks, which every seat misses by definition.
        page.substituted = 0;
        page.on("websocket", (ws) =>
            ws.on("framereceived", ({ payload }) => {
                const text = String(payload);
                if (!text.startsWith('{"type":"input"')) return;
                const msg = JSON.parse(text);
                if (msg.t > 10 && msg.seats && String(i) in msg.seats) page.substituted++;
            }),
        );
        pages.push(page);
    }
    const [host, guest] = pages;
    host.room = room_id();
    const from = log.length;

    await seat(host, host.origin);
    await seat(guest, guest.origin, host.room);
    await click(host, "Start the match");
    await click(guest, "Ready");
    await Promise.all(pages.map((page) => on(page, "play")));

    // Sampled once a second, because an overlay that came and went is a finding too.
    let overlay = 0;
    let left = 0;
    const until = Date.now() + SECONDS * 1000;
    const watch = (async () => {
        while (Date.now() < until) {
            for (const page of pages) {
                if (await page.locator("div.overlay").isVisible()) overlay++;
                if (!(await screen(page, "play").isVisible())) left++;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    })();
    await Promise.all([
        ...pages.map((page) => (process.env.IDLE ? null : play(page, until))),
        watch,
    ]);

    const lines = log.slice(from).filter((line) => line.includes(host.room));
    const count = (re) => lines.filter((line) => re.test(line)).length;
    rows.push({
        one_way,
        loss_pct,
        losses: proxies.reduce((sum, proxy) => sum + proxy.losses(), 0),
        desyncs: count(/ desync \d+ /),
        repairs: count(/repair \d+ of/),
        dropped: count(/dropped after/),
        to_ai: count(/to the AI/),
        overlay_s: overlay,
        left_s: left,
        errors: pages.flatMap((page) => page.errors).length,
        substituted: pages.map((page) => page.substituted).join("+"),
    });
    print(JSON.stringify(rows.at(-1)));
    if (process.env.VERBOSE) for (const line of lines) print("  " + line);
    for (const page of pages) await page.context().close();
    for (const proxy of proxies) await proxy.close();
}

print(`\n${SECONDS} s per condition, seed ${SEED}. Per-second samples for overlay and left.\n`);
print(
    "| one-way ms | loss % | losses | own frames released (host+guest) | desyncs | repairs | dropped | " +
        "seat to AI | overlay s | left s | page errors |",
);
print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows)
    print(
        `| ${r.one_way} | ${r.loss_pct} | ${r.losses} | ${r.substituted} | ${r.desyncs} | ${r.repairs} | ${r.dropped} | ` +
            `${r.to_ai} | ${r.overlay_s} | ${r.left_s} | ${r.errors} |`,
    );
await browser.close();
server.close();
process.exit(0);
