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
import { default_ban_map, LEVEL_WIDTH } from "../src/asset_data/default_levelmap.js";
import { BAN_ICE } from "../src/game/level.js";
import { Renderer } from "../src/interaction/renderer.js";
import { Room } from "../src/net/room.js";
import { MAX_CATCH_UP } from "../src/net/room_config.js";
import { Loopback_Transport } from "../src/net/loopback_transport.js";
import {
    checksum_ban_map,
    checksum_snapshot,
    decode_snapshot,
    encode_snapshot,
    pack_snapshot,
    unpack_snapshot,
} from "../src/game/snapshot.js";

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
function start(
    seed,
    settings,
    held,
    transport = new Loopback_Transport(),
    renderer = no_renderer,
    ban_map = default_ban_map(),
) {
    const keyboard = new Keyboard([]);
    const room = new Room(transport, (scheme) => keyboard.input_frame(scheme));
    room.start({ seed, settings, held });
    const rnd = make_rnd(room.seed);
    const objects = new Objects(rnd);
    const game = new Game(
        new Movement(no_sfx, objects, room.settings, rnd),
        new AI(),
        new Animation(no_renderer, {}, objects, rnd),
        renderer,
        objects,
        room,
        { ban_map },
        true,
        rnd,
    );
    return { game, keyboard, objects, room, rnd };
}

// What `game_session.js` hands a networked room, by hand: the ring it rewinds to and hashes
// from (#41, #141). A local room leaves it null and does neither.
function keep_history(client) {
    client.room.history = {
        save: () => ({
            state: pack_snapshot(client.rnd, client.objects, client.room.now()),
            ended: client.game.ended(),
        }),
        load: (saved) => {
            unpack_snapshot(saved.state, client.rnd, client.objects);
            client.game.ended(saved.ended);
        },
        hash: (saved) => checksum_snapshot(saved.state),
        step: () => {
            client.game.step();
            return !client.game.ended();
        },
    };
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
            drivers: ["local", "local"],
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
// Seat 1 is somebody else's and no frame for it ever arrives, so every tick substitutes for
// it -- but only the ticks from d on are counted, since before that there is nothing to be
// late (#70). Seat 0 is this client's own and is never short a frame.
assert.deepEqual(
    delayed_room.stats(),
    { substituted: 2, arrived: 0, late: 0, worst_margin: 2, late_by: {}, holes: 0 },
    "a missing frame is counted, and the first d ticks are not counted against it",
);
// A frame for a tick this room stepped three ticks ago: it arrived, it was too late to be
// used, and the slack it landed with is the measurement (#70).
delayed_transport.to_client({ type: "input", t: 1, seats: { 1: { left: true } } });
assert.deepEqual(
    delayed_room.stats(),
    { substituted: 2, arrived: 1, late: 1, worst_margin: -3, late_by: { "-3": 1 }, holes: 0 },
    "a frame arriving after the tick it was stamped for is counted, with its slack",
);
// And one for a tick this room could not reach if it replayed for a whole minute: refused
// rather than scheduled, and counted all the same. `arrived` is what the wire delivered, so
// it is counted above that guard rather than after it -- the relay counts its own refusal of
// the same frame (`room.forged++`), and a client silent about what the relay is loud about
// is the blind spot #118 closed one layer up (#126).
const before_ceiling = delayed_room.gap();
delayed_transport.to_client({ type: "input", t: MAX_CATCH_UP + 10, seats: { 1: { left: true } } });
assert.deepEqual(
    delayed_room.stats(),
    { substituted: 2, arrived: 2, late: 1, worst_margin: -3, late_by: { "-3": 1 }, holes: 0 },
    "a frame past the catch-up ceiling is counted as arrived, and measured as nothing else",
);
assert.equal(
    delayed_room.gap(),
    before_ceiling,
    "and it is refused rather than scheduled: the room's position does not move with it",
);

// Input edge latch: a tap that begins and ends between two loop wakeups, and a key really
// held across the same batch (#86). The pump steps a whole catch-up batch synchronously, so
// no key event can land inside one -- which is exactly N back-to-back `room.step()` calls
// with no key event between them, and needs no fake clock.
const batch_transport = (d, held, drivers) => ({
    receive(fn) {
        this.to_client = fn;
    },
    send(msg) {
        if (msg.type !== "start") return;
        this.to_client({ type: "start", t: 0, d, seed: 1, settings: {}, held, drivers });
    },
});

function batch_frames(d, ticks) {
    const keyboard = new Keyboard([]);
    const room = new Room(batch_transport(d, [0], ["local", "ai", "ai", "ai"]), (scheme) =>
        keyboard.input_frame(scheme),
    );
    room.start({ seed: 1, settings: {}, held: [0] });
    keyboard.onKeyDown({ keyCode: CONTROL_SCHEMES[0][1] }); // right, held across the batch
    keyboard.onKeyDown({ keyCode: CONTROL_SCHEMES[0][2] }); // up, tapped and released inside
    keyboard.onKeyUp({ keyCode: CONTROL_SCHEMES[0][2] }); //   the gap between two wakeups
    return [...Array(ticks)].map(() => room.step()[0]);
}

const batch = batch_frames(0, 4);
assert.deepEqual(
    batch.map((f) => f.up),
    [true, false, false, false],
    "a tap between two wakeups reaches exactly one tick of the batch, rather than none",
);
assert.deepEqual(
    batch.map((f) => f.right),
    [true, true, true, true],
    "and a key really held is delivered once per tick -- one tick is one 60th of the wall clock the batch owes",
);

// The same key timeline through a transport with an input delay: the same one-tick pulse,
// translated by d and nothing else. Local and networked are one code path with two
// transports under it, and the latch sits below the room, so it cannot tell them apart
// (#16, #33).
assert.deepEqual(
    batch_frames(2, 5).map((f) => f.up),
    [false, false, true, false, false],
    "a tap delivers one tick over a delayed transport too, d ticks later -- and d is the design",
);

// Four humans on one keyboard is one client holding four seats, so one tick reads four
// frames. The latch clears per scheme: a tap on scheme 1 must survive scheme 0's read of
// the same tick (#32).
const couch_keyboard = new Keyboard([]);
const couch_room = new Room(batch_transport(0, [0, 1], ["local", "local", "ai", "ai"]), (scheme) =>
    couch_keyboard.input_frame(scheme),
);
couch_room.start({ seed: 1, settings: {}, held: [0, 1] });
[0, 1].forEach((scheme) => {
    couch_keyboard.onKeyDown({ keyCode: CONTROL_SCHEMES[scheme][0] }); // left
    couch_keyboard.onKeyUp({ keyCode: CONTROL_SCHEMES[scheme][0] });
    couch_keyboard.onKeyDown({ keyCode: CONTROL_SCHEMES[scheme][2] }); // up
    couch_keyboard.onKeyUp({ keyCode: CONTROL_SCHEMES[scheme][2] });
});
const couch = couch_room.step();
assert.deepEqual(
    [couch[0].up, couch[1].up],
    [true, true],
    "one tick reads a frame per held seat, and one seat's read must not eat another's tap",
);
assert.deepEqual(
    [couch[0].left, couch[1].left],
    [true, true],
    "the latch is not wired to `up` alone -- `left` and `right` tap the same way",
);

// The pump keeps up with the room, not with its own clock (#42). A client resumed into a
// match already running replays to the tick the room was on when the relay built the
// payload, and decoding that state, building the object graph and replaying the gap all
// take time the room spends playing -- so it lands behind. Pacing the ticks that follow off
// a 60 Hz budget of its own never closes that gap, because the room runs at 60 Hz too: the
// client stays exactly as far behind as the rebuild took, and every frame it sends is
// stamped for a tick the room has already passed and dropped by the relay. Its bunny then
// stops answering the keyboard, which is what this is here to stop (#40, #70).
const behind_transport = (ahead) => ({
    deliver: null,
    receive(fn) {
        this.deliver = fn;
    },
    send(msg) {
        if (msg.type !== "start") return;
        this.deliver({
            type: "start",
            t: 0,
            // The relay stamps every `start` with the match it begins, and every frame this
            // client sends carries it back (#122).
            match: 1,
            d: 2,
            seed: msg.seed,
            settings: msg.settings,
            held: msg.held,
            drivers: ["local", "ai", "ai", "ai"],
        });
        // What the room played while this client was being built: frames stamped for ticks
        // it has not reached, which are ticks whose input has already arrived.
        for (let t = 0; t <= ahead; t++) this.deliver({ type: "input", t, seats: {} });
    },
});
const behind = start(9, {}, [0], behind_transport(40));
assert.equal(behind.room.gap(), 38, "the room is 38 ticks past the tick this client landed on");
// Real `performance.now()` here, and the only real-clock dependency in this file: the 38
// ticks below must cost less than the 16.67 ms batch bound (#83) or the pump yields first.
// They cost microseconds -- but if this ever flakes, that bound is why.
behind.game.start();
assert.equal(
    behind.room.now(),
    38,
    "and the pump steps the backlog out before it paces itself, rather than one tick a frame",
);
assert.equal(behind.room.gap(), 0, "so the next frame it sends is for a tick nobody has passed");
behind.game.pause();

// And a frame for a tick no replay could reach is not a frame at all. `newest` is what the
// gap above is measured from and `pump` sprints while it is positive, so one client stamping
// a million -- which the relay fans out, checking only that the number is a non-negative
// integer -- would fast-forward every other client through the rest of the match (#51).
// The d-tick hole a repair digs in the repaired client's own input (#72). `catch_up` stamps
// nothing -- those ticks are history -- so the client lands d ticks past the last frame it
// stamped for itself and its own bunny reads all keys released until its stream catches up.
// That is its own doing rather than the room failing to send, which is why the two are
// counted apart: `substituted` is what the other clients cost this one, and `holes` is this.
const repaired_transport = behind_transport(40);
const repaired = start(9, {}, [0], repaired_transport);
repaired.room.catch_up(repaired.game.step);
assert.equal(repaired.room.stats().holes, 0, "replaying the gap is not a hole: it is history");
repaired.room.step();
repaired.room.step();
assert.deepEqual(
    [repaired.room.stats().holes, repaired.room.stats().substituted],
    [2, 0],
    "and the d ticks after it lands are holes of its own, not the room covering for it (#72)",
);

const absurd_transport = behind_transport(0);
const absurd = start(9, {}, [0], absurd_transport);
for (let tick = 0; tick < 10; tick++) absurd.room.step();
absurd_transport.deliver({ type: "input", t: 1000000, seats: { 1: { left: true } } });
assert.ok(
    absurd.room.gap() <= 0,
    "a frame stamped past anything this client could replay is dropped, not believed",
);

// --- one Room, two matches (#84) ------------------------------------------------------
//
// A `Room` normally dies with its match: the end routes to the lobby, which tears the
// session down and builds a fresh one. Two paths keep one alive across a `start` -- a client
// still on the match screen inside the two-second end-of-match freeze when the host starts
// the next match, and one that reconnects into a room as a match begins -- so every counter
// a match owns has to be reset by `start` and not merely by construction.
const no_keys = () => ({ left: false, right: false, up: false });

const reused = new Room(new Loopback_Transport(), no_keys);
reused.start({ seed: 1, settings: {}, held: [0] });
for (let tick = 0; tick < 300; tick++) reused.step();
assert.ok(reused.gap() <= 0, "a client alone in its room is never behind it");
assert.equal(reused.match, 1, "the match this client is in, counted from one (#122)");
reused.start({ seed: 2, settings: {}, held: [0] });
assert.equal(reused.now(), 0, "a second match on a live room opens at tick 0");
assert.equal(
    reused.match,
    2,
    "and a number that says it is a different match: the one thing that tells a `start` " +
        "beginning the next match from one for the match this client is already in (#122)",
);
assert.equal(
    reused.gap(),
    0,
    "and with no gap: the newest tick match 1 stamped is not match 2's (#84)",
);

// Catch-up replays a gap; it does not replay a match that is over. A `match_end` lands while
// a joining client is still fetching the level, and the ticks past the end are the ones that
// trip the simulation's end-of-match flag -- which latches, leaving a session that never
// pumps again.
const ending_transport = behind_transport(40);
const ending = new Room(ending_transport, no_keys);
ending.start({ seed: 1, settings: {}, held: [0] });
assert.equal(ending.gap(), 38, "a client 38 ticks behind the match it is in");
ending_transport.deliver({ type: "match_end", reason: "time", matrix: [] });
assert.equal(ending.gap(), 0, "and behind nothing at all once that match is over");
assert.equal(
    ending.match,
    1,
    "which is still the match it was in: a match that is over is the one this client last " +
        "played, and the number outlives it (#122)",
);
ending.catch_up(ending.step);
assert.equal(ending.now(), 0, "so the replay stops at the end of the match, not past it");

// A driver change stamped for a tick this client has already stepped. That tick never comes
// round again, so holding it in the map loses the change and leaks the entry: the seat the
// room gave the AI goes on being driven by the one client that never heard (#7, #84). The
// two halves are one branch, so this asserts both -- a released frame here would mean the
// change was stamped rather than applied, which is also the only key that can outlive the
// `step` that would have deleted it.
const late_transport = {
    receive(fn) {
        this.deliver = fn;
    },
    send() {},
};
const late = new Room(late_transport, no_keys);
late_transport.deliver({
    type: "start",
    t: 0,
    d: 0,
    seed: 1,
    settings: {},
    held: [0],
    drivers: ["local", "local", "ai", "ai"],
});
for (let tick = 0; tick < 10; tick++) late.step();
late_transport.deliver({ type: "driver", t: 3, seat: 1, driver: "ai" });
assert.equal(
    late.step()[1],
    undefined,
    "a seat the room handed the AI seven ticks ago is the AI's here too, not a released frame",
);

// The d-tick tail: a frame that was local when it was consumed -- not merely when it was
// scheduled -- outliving the handover. Two routes stamp such a frame, exercised here: this
// client's own schedule (seat 1, d ticks ahead of the handover) and the relay's resend ring
// (seat 2, landing on the handover tick itself, same as the live fan-out would). step is the
// only place the driver table and the frame set are both in hand to reconcile them (#110).
const handover_transport = function (extra) {
    return {
        receive(fn) {
            this.to_client = fn;
        },
        send(msg) {
            if (msg.type !== "start") return;
            this.to_client(
                Object.assign(
                    {
                        type: "start",
                        t: 0,
                        d: 2,
                        seed: 1,
                        settings: {},
                        held: [0, 1],
                        drivers: ["local", "local", "local", "ai"],
                        changes: [
                            { t: 2, seat: 1, driver: "ai" },
                            { t: 2, seat: 2, driver: "ai" },
                        ],
                        inputs: [{ t: 2, seats: { 2: { left: true, right: false, up: false } } }],
                    },
                    extra || {},
                ),
            );
        },
    };
};
const handover = new Room(handover_transport(), no_keys);
handover.start({ seed: 1, settings: {}, held: [0, 1] });
handover.step();
handover.step();
assert.deepEqual(
    Object.keys(handover.step()),
    ["0"],
    "a seat handed to the AI keeps no frame, whoever stamped it -- this client d ticks ago, or the relay's ring (#110)",
);

// The same reconciliation on the replay path, not only the live one: a joiner's catch-up
// steps through the same `step`, so the ring's stale frame for seat 2 must not survive
// being replayed into a fresh room either.
const replayed = new Room(handover_transport({ until: 3 }), no_keys);
replayed.start({ seed: 1, settings: {}, held: [0, 1] });
let replayed_last = null;
replayed.catch_up(function () {
    replayed_last = replayed.step();
});
assert.deepEqual(
    Object.keys(replayed_last),
    ["0"],
    "and replayed through catch_up, the ring's stale frame is dropped there too (#110)",
);

// A resume lands with the table as of its snapshot and the `local` that hands the seats back
// stamped 2d ticks ahead: for those ticks the seat is the AI's in the table, but already on
// its way back, and a line saying so would flash up after the press that fixed it (review:
// #76). A seat with nothing pending is still named.
const returning = new Room(
    handover_transport({
        held: [1, 2],
        drivers: ["local", "ai", "ai", "ai"],
        changes: [{ t: 2, seat: 1, driver: "local" }],
        inputs: [],
    }),
    no_keys,
);
returning.start({ seed: 1, settings: {}, held: [1, 2] });
assert.deepEqual(returning.ai_seats(), [2], "a seat on its way back is not the AI's to say (#76)");
returning.step();
returning.step();
returning.step();
assert.deepEqual(returning.ai_seats(), [2], "and once it is back, still only the other (#76)");

// What discriminates "local at the tick it was stamped for" from "local at the tick it is
// consumed" -- the wrong invariant and the right one -- is a window shorter than d: seat 1
// goes local -> ai at t=2 and back ai -> local at t=4, so the frame this client scheduled
// at t=0 for t=2 was stamped while local but must not survive to be consumed, and the frame
// it schedules once local again must reach the seat exactly as if it had never left.
const window_transport = {
    receive(fn) {
        this.deliver = fn;
    },
    send() {},
};
const windowed = new Room(window_transport, (scheme) => ({
    left: scheme === 1,
    right: false,
    up: false,
}));
window_transport.deliver({
    type: "start",
    t: 0,
    d: 2,
    seed: 1,
    settings: {},
    held: [0, 1],
    drivers: ["local", "local", "ai", "ai"],
    changes: [
        { t: 2, seat: 1, driver: "ai" },
        { t: 4, seat: 1, driver: "local" },
    ],
});
const seen = {};
for (let t = 0; t <= 6; t++) {
    const frames = windowed.step();
    if (t === 2 || t === 4 || t === 6) seen[t] = frames;
}
assert.deepEqual(
    Object.keys(seen[2]),
    ["0"],
    "the frame stamped at t=0 for t=2, while seat 1 was still local, does not survive the ai it became by t=2 (#110)",
);
assert.deepEqual(
    Object.keys(seen[4]),
    ["0", "1"],
    "and once local again the d-tick floor releases it exactly as any seat with no frame yet does",
);
assert.equal(
    seen[4][1].left,
    false,
    "released, not stale keys: nothing was ever scheduled for this tick while the seat was away",
);
assert.equal(
    seen[6][1].left,
    true,
    "and the seat's own keys reach it again once local has had d ticks to schedule one",
);

// #83: one simulation tick that costs more than a frame must not lock the loop. The pump
// advances its budget by exactly one frame per tick, so before the batch bound a tick that
// overran it left `next_time - now` monotonically decreasing and the break unreachable -- no
// draw, no keyboard, no socket read, and in an endless match no exit at all. Both the clock
// and the yield are globals the pump reads at call time, so a fake clock here needs no seam
// the game does not already have.
{
    const real_performance = globalThis.performance;
    const real_setTimeout = globalThis.setTimeout;
    let fake = 0;
    let drawn = 0;
    let stepped = 0;
    const yields = [];
    // The fake clock only moves when a tick runs, so nothing here depends on how fast the
    // machine running the test is. 20 ms a tick against a 16.67 ms budget.
    const slow_renderer = {
        add_pob() {},
        add_leftovers() {},
        clear_pobs() {
            fake += 20;
            // A regression in the intermediate state -- monotonic clock in, bound missing --
            // hangs rather than fails, so it is turned into a failure here.
            if (++stepped > 100) throw new Error("#83: pump spun instead of yielding");
        },
        draw() {
            drawn++;
        },
    };
    globalThis.performance = { now: () => fake };
    globalThis.setTimeout = (fn, ms) => yields.push(ms); // the wakeup is never run

    try {
        const slow = start(9, {}, [0], new Loopback_Transport(), slow_renderer);
        slow.game.start();
        assert.equal(stepped, 1, "the batch ends on the tick that overran the frame budget");
        assert.equal(
            yields.length,
            1,
            "and the loop yields to the event loop rather than spinning",
        );
        assert.equal(slow.room.now(), 1, "the tick it stepped is stepped, not skipped");
        assert.equal(drawn, 1, "a bounded batch still draws, so the tab is not frozen either");
        slow.game.pause();

        // The sprint branch `continue`s past both the draw and the yield, and any peer can
        // hold it open up to MAX_CATCH_UP every tick, so it needs the same bound -- and it is
        // this sub-case, not the one above, that fails without it: the pump would drain all
        // 38 backlog ticks in one block.
        fake = 0;
        stepped = 0;
        drawn = 0;
        yields.length = 0;
        const sprinting = start(9, {}, [0], behind_transport(40), slow_renderer);
        assert.equal(sprinting.room.gap(), 38, "the room is 38 ticks ahead before the first step");
        sprinting.game.start();
        assert.equal(stepped, 1, "a sprint is bounded by the same batch budget");
        assert.equal(yields.length, 1, "and yields instead of draining 38 ticks in one block");
        assert.equal(sprinting.room.gap(), 37, "the backlog is still there, to be run next wakeup");
        sprinting.game.pause();
    } finally {
        globalThis.performance = real_performance;
        globalThis.setTimeout = real_setTimeout;
    }
}

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

// --- snapshot, mid-match join and resync (#40) ---------------------------------------
//
// The claim under test is the whole of the feature: a client handed the host's packed
// state and the input frames since it reaches, tick for tick, the state the host is in.
// Last, because building a Game replaces the `player` array.

// The relay's input ring, kept here by the transport under the host: every frame it fanned
// out is what a joiner replays the gap with.
const ring = [];
const host_transport = new Loopback_Transport();
const to_relay = host_transport.send;
host_transport.send = function (msg) {
    if (msg.type === "input") ring.push({ t: msg.t, seats: msg.seats });
    to_relay(msg);
};

const HALF = 150;
const join_log = input_log(7);
const host = start(2468, { no_gore: false }, [0, 1], host_transport);
let body = null;
for (let tick = 0; tick < HALF * 2; tick++) {
    // Packed between two ticks, which is the only moment the state is a state any tick had
    // -- the pump steps a whole catch-up batch without yielding.
    if (tick === HALF)
        body = encode_snapshot(pack_snapshot(host.rnd, host.objects, host.room.now()));
    [0, 1].forEach((scheme) => {
        join_log[tick][scheme].forEach((down, key) => {
            const event = { keyCode: CONTROL_SCHEMES[scheme][key] };
            down ? host.keyboard.onKeyDown(event) : host.keyboard.onKeyUp(event);
        });
    });
    host.game.step();
}
const host_state = checksum(host.objects.objects);
// Taken here, not at the end of the file: `player` is a module global that building the
// joiner's Game replaces, so the host's state is only packable while the host's is the
// array the module holds (#5).
const host_hash = checksum_snapshot(pack_snapshot(host.rnd, host.objects, HALF * 2));
assert.equal(host.room.now(), HALF * 2, "the host played the match through");

assert.equal(
    decode_snapshot(body).length,
    pack_snapshot(host.rnd, host.objects, 0).length,
    "a snapshot decodes to the same fixed-size record it was packed from",
);
assert.equal(decode_snapshot("not a snapshot"), null, "and a body that is not one is refused");

// The joiner's relay: it answers `start` with the mid-match payload -- the host's snapshot,
// the frames since it, and the tick to replay up to -- instead of a match at tick 0.
const join_transport = {
    sent: [],
    receive(fn) {
        this.to_client = fn;
    },
    send(msg) {
        this.sent.push(msg);
        if (msg.type !== "start") return;
        this.to_client({
            type: "start",
            t: HALF,
            until: HALF * 2,
            d: 0,
            seed: 2468,
            // The settings block travels with it: a joiner with the wrong no_gore desyncs
            // on the first kill (#22, #5).
            settings: { no_gore: false },
            held: [],
            drivers: ["local", "local", "ai", "ai"],
            snapshot: body,
            inputs: ring.filter((frame) => frame.t >= HALF),
        });
    },
};

const joiner = start(2468, {}, [], join_transport);
// Hashed by the room every 30 ticks in a networked room, which this transport is standing
// in for; a local room keeps no history and sends none (#41, #16).
keep_history(joiner);
assert.equal(joiner.room.now(), HALF, "a joined match starts on the snapshot's tick, not zero");
unpack_snapshot(decode_snapshot(body), joiner.rnd, joiner.objects);
joiner.room.catch_up(joiner.game.step);
assert.equal(joiner.room.now(), HALF * 2, "and is replayed up to the tick the room is on");
const joined_hash = checksum_snapshot(pack_snapshot(joiner.rnd, joiner.objects, HALF * 2));
assert.equal(
    checksum(joiner.objects.objects),
    host_state,
    "a client resumed from the host's snapshot and the input ring is in the host's state",
);
assert.deepEqual(
    join_transport.sent.filter((msg) => msg.type === "input"),
    [],
    "and sends no frames of its own for ticks that are already history",
);
assert.deepEqual(
    join_transport.sent.filter((msg) => msg.type === "checksum"),
    [],
    "nor a hash of one: the host checksummed those ticks seconds ago (#41)",
);

// Where the replay ends is the newest tick anybody has stamped a frame for, less the delay,
// and not only the number the relay put in the payload: fetching a level and unpacking a
// state takes time the room spends playing, so a client that lands where the room was when
// it asked is behind by all of it -- and a client behind by more than the delay has its
// frames arrive for ticks everybody else has stepped past (#40, #6).
join_transport.to_client({ type: "input", t: HALF * 2 + 30, seats: {} });
joiner.room.catch_up(joiner.game.step);
assert.equal(
    joiner.room.now(),
    HALF * 2 + 30,
    "a replay lands on the tick the room is on now, not the one it was on when it answered",
);

// --- checksum desync detection (#41) -------------------------------------------------
//
// The hash is FNV-1a over the snapshot serializer's own output, so two clients in the same
// state hash the same and the check covers exactly what a resync would repair. The joiner
// above replayed into the host's state, which is what makes it the pair to compare.
assert.equal(joined_hash, host_hash, "a client in the host's state hashes to the host's");
assert.notEqual(
    checksum_snapshot(decode_snapshot(body)),
    host_hash,
    "and one 150 ticks behind it does not: a mismatch is the desync",
);

// Every 30 ticks, and only once the client is playing rather than replaying: the room is at
// HALF * 2 + 30 after the catch-up above. The tick hashed is the one leaving the ring, a
// second back, which no late frame can change any more (#141).
join_transport.sent.length = 0;
joiner.room.catch_up(joiner.game.step);
joiner.game.step();
const hashed = () => join_transport.sent.filter((msg) => msg.type === "checksum");
assert.equal(hashed().length, 1, "a playing client hashes its state on a thirtieth tick");
assert.equal(hashed()[0].t, HALF * 2 + 30 - 60, "stamped with the settled tick it hashed");
for (let tick = 0; tick < 29; tick++) joiner.game.step();
assert.equal(hashed().length, 1, "and on no tick in between");

// --- rewind (#141) --------------------------------------------------------------------
//
// A peer's seat holds right, its frames stall for ten ticks, and the key it changed to
// inside the stall arrives after this client stepped those ticks on the guess. The relay's
// frame is the truth for a tick (#42), so the client rewinds and lands where a client that
// had the frames on time is. Without the ring it stays where the guess put it: the desync.
const RIGHT = { left: false, right: true, up: false };
const LEFT = { left: true, right: false, up: false };
function stalled(history, on_time) {
    const transport = {
        receive(fn) {
            this.deliver = fn;
        },
        send(msg) {
            if (msg.type === "start")
                this.deliver({
                    type: "start",
                    t: 0,
                    d: 2,
                    match: 1,
                    seed: 77,
                    settings: { no_gore: false },
                    held: [0],
                    drivers: ["local", "local", "ai", "ai"],
                });
        },
    };
    const client = start(77, {}, [0], transport);
    if (history) keep_history(client);
    const frame = (t, keys) => transport.deliver({ type: "input", t, seats: { 1: keys } });
    for (let t = 2; t < 20; t++) frame(t, RIGHT);
    if (on_time) for (let t = 20; t < 60; t++) frame(t, LEFT);
    for (let t = 0; t < 30; t++) client.game.step();
    if (!on_time) for (let t = 20; t < 60; t++) frame(t, LEFT);
    for (let t = 30; t < 60; t++) client.game.step();
    return checksum(client.objects.objects);
}
const on_time = stalled(true, true);
assert.equal(stalled(true, false), on_time, "a late frame that differs is rewound to (#141)");
assert.notEqual(stalled(false, false), on_time, "and without the ring it is the desync");

// A level edited under the same name -- a tile retyped by a deploy, which is the shape the
// stale cache serves -- is what the hash over the state alone cannot see (#95). SOLID and
// ICE are interchangeable in both clauses of `position_player`'s spawn test, so the two
// clients draw the same cells from the same seed and pack a byte-identical tick 0; a bunny
// has to slide on that one tile before the states part. Last, because building a Game
// replaces the `player` array that `pack_snapshot` reads, so each state is packed before
// the next Game is built.
const edited_map = default_ban_map();
edited_map[2 + 11 * LEVEL_WIDTH] = BAN_ICE;
const stale = start(2468, {}, [0]);
const stale_state = pack_snapshot(stale.rnd, stale.objects, 0);
const fresh = start(2468, {}, [0], new Loopback_Transport(), no_renderer, edited_map);
const fresh_state = pack_snapshot(fresh.rnd, fresh.objects, 0);
assert.equal(
    checksum_snapshot(fresh_state),
    checksum_snapshot(stale_state),
    "one tile apart, two clients are in the same state at tick 0: the state alone cannot see it",
);
// The expression the room builds, by hand -- same as the joiner's above.
assert.notEqual(
    checksum_snapshot(fresh_state, checksum_ban_map(edited_map)),
    checksum_snapshot(stale_state, checksum_ban_map(default_ban_map())),
    "and chaining the ban map's hash in front of it makes them disagree from tick 0 (#95)",
);

// The simulation-level half of the same fact (#110): `player[i].ai` is `!frame`, so the
// reconciliation in `step` above has to reach `game.js` too. Last, because building a Game
// replaces the `player` array.
const handover_game = start(1, {}, [0, 1], handover_transport());
handover_game.game.step();
handover_game.game.step();
handover_game.game.step();
assert.deepEqual(
    player.map((p) => p.ai),
    [false, true, true, true],
    "and the AI steers it on this client too, which is what every other client is doing (#110)",
);

// Two AI bunnies stacked in one column, each the other's nearest target and out of the
// other's reach, used to stand there for the rest of the match (#52). Placed by hand: once
// mid-map, once against the left wall and facing it. Last, because building a Game
// replaces the `player` array.
for (const [upper_x, upper_y, lower_x, lower_y, direction] of [
    [118, 112, 116, 208, 0],
    [16, 112, 16, 192, 1],
]) {
    const stacked = start(1, {}, [], batch_transport(0, [], ["ai", "ai", "off", "off"]));
    const placed = [
        [upper_x, upper_y],
        [lower_x, lower_y],
    ];
    placed.forEach(([x, y], i) => {
        player[i].x.pos = x << 16;
        player[i].y.pos = y << 16;
        player[i].x.velocity = player[i].y.velocity = 0;
        player[i].direction = direction;
    });
    for (let tick = 0; tick < 120; tick++) stacked.game.step();
    assert.ok(
        placed.some(([x], i) => Math.abs((player[i].x.pos >> 16) - x) >= 16),
        `a stacked pair at x=${upper_x} breaks its own symmetry inside two seconds (#52)`,
    );
}

console.log(
    "OK replay is deterministic and headless, schemes bind in join order, the leftovers ring is bounded, a snapshot plus the input gap lands in the host's state, and a seat handed to the AI keeps no stale frame, and a stacked AI pair breaks its own column",
);
