// The determinism check (#31): the same seed and the same input log must replay to the
// same state, and the replay runs with no DOM -- which is the point, since a server or
// a peer has none either. Run with `npm test`.
import assert from "node:assert";

import { Game, player } from "../src/game/game.js";
import { Objects } from "../src/game/objects.js";
import { Keyboard, CONTROL_SCHEMES } from "../src/game/keyboard.js";
import { AI } from "../src/game/ai.js";
import { Animation } from "../src/game/animation.js";
import { Movement } from "../src/game/movement.js";
import { make_rnd } from "../src/game/rnd.js";
import { env } from "../src/game/env.js";
import { default_ban_map } from "../src/asset_data/default_levelmap.js";
import { Renderer } from "../src/interaction/renderer.js";
import { Room } from "../src/net/room.js";
import { Loopback_Transport } from "../src/net/loopback_transport.js";

const TICKS = 3600; // one minute at 60 Hz -- long enough that bunnies collide

function fnv1a(hash, value) {
    value = value | 0;
    for (let byte = 0; byte < 4; byte++) {
        hash ^= (value >>> (byte * 8)) & 0xff;
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

// The whole simulation, hashed field by field: picking a subset would silently
// un-detect whatever was left out (#19).
function checksum(objects) {
    let hash = 2166136261;
    const fold = (...values) =>
        values.forEach((v) => (hash = fnv1a(hash, v === true ? 1 : v === false ? 0 : v)));
    for (const p of player) {
        fold(
            p.x.pos,
            p.y.pos,
            p.x.velocity,
            p.y.velocity,
            p.direction,
            p.enabled,
            p.dead_flag,
            p.jump_ready,
            p.jump_abort,
            p.in_water,
            p.anim,
            p.frame,
            p.frame_tick,
            p.bumps,
        );
        for (let i = 0; i < env.JNB_MAX_PLAYERS; i++) fold(p.bumped[i]);
    }
    for (const o of objects) {
        fold(o.used, o.type, o.anim, o.frame, o.ticks, o.image);
        if (o.used) fold(o.x.pos, o.y.pos, o.x.velocity, o.y.velocity);
    }
    return hash;
}

// Three bits per seat per tick -- one input frame -- from a PRNG of its own; drawing them
// from the simulation's `rnd` would change the stream it is being tested on.
function input_log(seed) {
    const draw = make_rnd(seed);
    const log = [];
    for (let tick = 0; tick < TICKS; tick++) {
        const frame = [];
        for (let seat = 0; seat < env.JNB_MAX_PLAYERS; seat++) {
            frame.push([draw(2) === 1, draw(2) === 1, draw(4) === 1]);
        }
        log.push(frame);
    }
    return log;
}

const no_renderer = { add_pob() {}, add_leftovers() {}, clear_pobs() {}, draw() {} };
const no_sfx = { jump() {}, death() {}, spring() {}, splash() {}, fly() {}, music() {} };

// `held` is the seats this client holds; control scheme n drives held[n] (#32). Input
// reaches the simulation only through the room, over a loopback transport -- the same path
// a networked room takes, with a different transport under it (#16, #33).
function start(seed, settings, held, transport = new Loopback_Transport()) {
    const keyboard = new Keyboard([]);
    const room = new Room(transport, (scheme) => keyboard.input_frame(scheme));
    room.start({ seed, settings, held });
    const rnd = make_rnd(room.seed);
    const objects = new Objects(rnd);
    const game = new Game(
        new Movement(no_sfx, objects, room.settings, rnd),
        new AI(),
        new Animation(no_renderer, {}, objects, rnd),
        no_renderer,
        objects,
        room,
        { ban_map: default_ban_map() },
        true,
        rnd,
    );
    return { game, keyboard, objects, room };
}

// Three seats on the keyboard and a fourth left to the AI, so the replay covers both
// drivers over 3600 ticks.
function replay(seed, log, settings = { no_gore: false }) {
    const held = [0, 1, 2];
    const { game, keyboard, objects } = start(seed, settings, held);

    for (const frame of log) {
        held.forEach((seat, scheme) => {
            frame[seat].forEach((down, key) => {
                const event = { keyCode: CONTROL_SCHEMES[scheme][key] };
                down ? keyboard.onKeyDown(event) : keyboard.onKeyUp(event);
            });
        });
        game.step();
    }
    return checksum(objects.objects);
}

const log = input_log(99);
assert.equal(replay(1234, log), replay(1234, log), "same seed and inputs must replay identically");
assert.notEqual(
    replay(1234, log),
    replay(4321, log),
    "a different seed must reach a different state",
);
assert.notEqual(
    replay(1234, log),
    replay(1234, log, { no_gore: true }),
    "no_gore changes the state, which is why settings are shared and not per-client",
);

// Schemes belong to the client and bind to its seats in join order, sticky until the seat
// is released: a client holding global seats 2 and 3 drives them with schemes 0 and 1, and
// four humans on one keyboard is nothing more than one client holding four seats (#32).
function drive_right(held) {
    const { game, keyboard } = start(1234, { no_gore: false }, held);
    held.forEach((seat, scheme) => keyboard.onKeyDown({ keyCode: CONTROL_SCHEMES[scheme][1] }));
    game.step();
    return { right: player.map((p) => p.action_right), ai: player.map((p) => p.ai) };
}

const four_up = drive_right([0, 1, 2, 3]);
assert.deepEqual(
    four_up.right,
    [true, true, true, true],
    "four humans on one keyboard, one scheme each",
);
assert.deepEqual(four_up.ai, [false, false, false, false], "a held seat is never AI-filled");

// Seats 0 and 1 are left to the AI here, so only the held ones can be asserted on.
const held_two = drive_right([2, 3]);
assert.deepEqual(
    held_two.right.slice(2),
    [true, true],
    "schemes bind in join order, not by seat index",
);
assert.deepEqual(
    held_two.ai,
    [true, true, false, false],
    "a seat nobody holds is driven by the AI",
);

// The local room over its loopback (#33). The stub stands in for the whole relay, so the
// seed and the settings arrive on `start`, seats are driven by stamped driver changes, and
// the final board comes back off a `match_end` the host sent.
const local = start(1234, { no_gore: true }, [0, 1, 2, 3]);
assert.equal(local.room.d, 0, "no jitter in the same tab, so no input delay on a loopback");
assert.equal(local.room.seed, 1234, "the seed rides on `start`");
assert.deepEqual(local.room.settings, { no_gore: true }, "settings ride only on `start`");

// Mid-match, not just at tick 0: a change stamped for a tick already stepped past would
// never be applied, since that tick does not come round again.
for (let tick = 0; tick < 5; tick++) local.game.step();
local.room.set_driver(2, "ai");
local.game.step();
assert.deepEqual(
    player.map((p) => p.ai),
    [false, false, true, false],
    "a driver change stamped at currentTick + 2d takes effect on the next tick, d being 0",
);

// Input delay: a client's own frames are stamped d ticks ahead, and the ticks before the
// first one lands are all keys released, never the AI (#6). d = 0 on a loopback, so this
// takes a transport that answers with one.
const delayed_transport = {
    receive(fn) {
        this.to_client = fn;
    },
    send(msg) {
        if (msg.type !== "start") return;
        this.to_client({
            type: "start",
            t: 0,
            d: 2,
            seed: 1,
            settings: {},
            held: [0],
            drivers: ["local"],
        });
    },
};
const delayed_room = new Room(delayed_transport, () => ({ left: false, right: true, up: false }));
delayed_room.start({ seed: 1, settings: {}, held: [0] });
assert.deepEqual(
    [0, 1, 2, 3].map(() => delayed_room.step()[0].right),
    [false, false, true, true],
    "a held seat is released for the first d ticks, then driven -- never handed to the AI",
);

let ended = null;
local.room.on_match_end = (msg) => (ended = msg);
local.room.end_match("host", [[7]]);
assert.deepEqual(
    ended,
    { type: "match_end", t: 6, reason: "host", matrix: [[7]] },
    "the host announces the end and the relay broadcasts it, final board included",
);

// The leftovers ring: bounded at 50, keeping the newest (#30). Renderer needs a 2d
// context and a window, and nothing else -- add_leftovers itself touches no DOM.
const drawn = [];
global.window = { innerWidth: 400, innerHeight: 256 };
const renderer = new Renderer(
    { getContext: () => ({ drawImage: (image) => drawn.push(image), scale() {} }) },
    {},
    { image: { width: 400, height: 256 }, mask: {} },
);
for (let i = 0; i < 60; i++) renderer.add_leftovers(0, 0, i, {});
renderer.draw();
const splats = drawn.filter((image) => typeof image === "number");
// Unsorted: the order is the assertion. The newest splat has to paint last, which the
// ring only does if it is walked from its oldest entry rather than from index 0.
assert.deepEqual(
    splats,
    [...Array(50).keys()].map((i) => i + 10),
    "the leftovers ring holds the newest 50 splats, oldest painted first",
);

// AI-fill off: a seat nobody holds is disabled, not handed to the CPU, and the match runs
// short-handed (#7, #37). Last, because building a Game replaces the `player` array.
const short_handed = start(1, {}, [0], {
    receive(fn) {
        this.to_client = fn;
    },
    send(msg) {
        if (msg.type !== "start") return;
        this.to_client({
            type: "start",
            t: 0,
            d: 0,
            seed: 1,
            settings: {},
            held: [0],
            drivers: ["local", "off", "off", "off"],
        });
    },
});
assert.deepEqual(
    player.map((p) => p.enabled),
    [true, false, false, false],
    "a disabled seat has no bunny in the match at all",
);
const short_frames = short_handed.room.step();
assert.deepEqual(
    Object.keys(short_frames),
    ["0"],
    "and no frame of its own: a disabled seat is not a driver with the keys released",
);

// The match ends by itself on a limit the room set, at the end of the tick the condition
// first holds -- the same tick on every client, because every client steps the same
// simulation from the same seed (#22, #39). Last, because building a Game replaces the
// `player` array.
const endless = start(1, { no_gore: false }, [0]);
assert.equal(endless.game.ticks_left(), null, "no limits is endless, which is the default");
endless.game.on_end = () => assert.fail("an endless match never ends by itself");
for (let tick = 0; tick < 10; tick++) endless.game.step();

const to_five = start(1, { bump_limit: 5 }, [0]);
const bump_ends = [];
to_five.game.on_end = (reason) => bump_ends.push(reason);
player[2].bumps = 4;
to_five.game.step();
assert.deepEqual(bump_ends, [], "four bumps of five is not the end of anything");
player[2].bumps = 5;
to_five.game.step();
assert.deepEqual(bump_ends, ["bumps"], "the fifth bump ends the match at the end of its tick");
to_five.game.step();
assert.deepEqual(bump_ends, ["bumps"], "and it is announced once, however often it is stepped");

// Ticks, fixed at match start: a minute is 3600 of them, and nothing here reads a clock.
const to_a_minute = start(1, { time_limit: 1 }, [0]);
const time_ends = [];
to_a_minute.game.on_end = (reason) => time_ends.push(reason);
for (let tick = 0; tick < env.TICKS_PER_MINUTE - 1; tick++) to_a_minute.game.step();
assert.equal(to_a_minute.game.ticks_left(), 1, "one tick of the minute left");
assert.deepEqual(time_ends, [], "and the match is still running on it");
to_a_minute.game.step();
assert.deepEqual(time_ends, ["time"], "the last tick of the time limit ends the match");
assert.equal(to_a_minute.game.ticks_left(), 0);

console.log(
    "OK replay is deterministic and headless, schemes bind in join order, and the leftovers ring is bounded",
);
