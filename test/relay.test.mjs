// The relay (#34): room ids, the two failure answers, fan-out and the derived input delay.
// It runs against a real server on a real socket, because the protocol is the thing under
// test and a fake of it would be the thing under test instead. Run with `npm test`.
import assert from "node:assert";
import fs from "node:fs";

import { normalise_room_id } from "../src/net/room_id.js";
import { LEVELS, config_diff, default_config } from "../src/net/room_config.js";
import { start_server } from "../server/index.js";
import { Room } from "../src/net/room.js";
import { WebSocket_Transport } from "../src/net/websocket_transport.js";

// Room ids: five characters, uppercase A-Z minus I and O, and the client's casing is not
// what makes one legal.
assert.equal(normalise_room_id("abcde"), "ABCDE", "a lowercase id is re-uppercased");
assert.equal(normalise_room_id("ABCDI"), null, "I is not in the alphabet");
assert.equal(normalise_room_id("ABCDO"), null, "O is not in the alphabet");
assert.equal(normalise_room_id("ABCD"), null, "four characters is not a room id");
assert.equal(normalise_room_id(undefined), null, "nor is nothing at all");

// Room config is host input, so the shared validator is what the relay trusts and the only
// thing it stages: unknown keys are dropped, a level that is not one of the room's is not a
// level, and a value the room already has is not a change (#38).
const base = default_config();
assert.deepEqual(base.level, "default", "a room starts on the built-in map");
assert.deepEqual(config_diff(base, { no_gore: true }), { no_gore: true }, "a flag that flips");
assert.deepEqual(config_diff(base, { no_gore: false }), {}, "one that does not is not a change");
assert.deepEqual(config_diff(base, { level: "caves" }), { level: "caves" }, "a level in the list");
assert.deepEqual(config_diff(base, { level: "../levelmap.txt" }), {}, "and one that is not");
assert.deepEqual(config_diff(base, { win_score: 10 }), {}, "a key nobody declared is dropped");
// The two match-end limits, which are the one place a config value is a number: zero is
// endless and is where a room starts, and anything outside the ceiling is dropped rather
// than clamped -- a silently clamped 99 is a limit nobody chose (#22, #39).
assert.equal(base.bump_limit, 0, "a room is endless until somebody says otherwise");
assert.equal(base.time_limit, 0);
assert.deepEqual(config_diff(base, { bump_limit: 5 }), { bump_limit: 5 }, "a limit inside 0-99");
assert.deepEqual(config_diff(base, { time_limit: 60 }), { time_limit: 60 }, "and 0-60 minutes");
assert.deepEqual(config_diff(base, { bump_limit: "7" }), { bump_limit: 7 }, "a number box types");
assert.deepEqual(config_diff(base, { bump_limit: 100 }), {}, "over the two-digit counter");
assert.deepEqual(config_diff(base, { time_limit: 61 }), {}, "over the hour");
assert.deepEqual(config_diff(base, { bump_limit: -1 }), {}, "under nothing at all");
assert.deepEqual(config_diff(base, { time_limit: 1.5 }), {}, "and half a minute is not one");
assert.deepEqual(config_diff(base, { bump_limit: "lots" }), {}, "nor is a word");
assert.deepEqual(config_diff(base, { bump_limit: "" }), {}, "and an emptied box is no value");
assert.deepEqual(config_diff(base, { bump_limit: 0 }), {}, "endless is what it already is");
assert.deepEqual(config_diff(base, "nonsense"), {}, "and so is a config that is not one");

const server = await start_server(0);
const url = "ws://localhost:" + server.address().port + "/ws";

// The transport is the client's, so the test drives the same one the browser does. Lobby
// messages -- the handshake, every room update and every refusal -- are collected as they
// arrive and awaited by shape, because seating is answered by a room update rather than by
// a reply of its own. One waiter at a time, which is all this test ever has.
function connect(entry) {
    const events = [];
    let wake = null;
    const record = (msg) => {
        events.push(msg);
        if (wake) wake();
    };
    const socket = new WebSocket_Transport(url, entry, record, (code) =>
        record({ type: "error", code }),
    );
    return {
        socket,
        events,
        async until(matches) {
            for (;;) {
                const index = events.findIndex(matches);
                // Consumed, so the next wait cannot be answered by an old message.
                if (index >= 0) return events.splice(0, index + 1).pop();
                await new Promise((resolve) => (wake = resolve));
            }
        },
        seats(names) {
            socket.send({ type: "seats", names });
            // A grant is a room update carrying seats; a refusal is an error. A room update
            // with nothing held is somebody else's news and not an answer to this.
            return this.until(
                (msg) => msg.type === "error" || (msg.type === "room" && msg.held.length),
            );
        },
    };
}

const lobby_token = async (client) => (await client.until((msg) => msg.type === "joined")).token;

const lobby = (client) => client.until((msg) => msg.type === "joined" || msg.type === "error");

const created = connect({ type: "create", id: "qmftx" });
const created_joined = await lobby(created);
assert.equal(created_joined.id, "QMFTX", "a host-chosen id is accepted when free, uppercased");
assert.equal(created_joined.host, false, "and hosts nothing until it holds a seat (#7)");
assert.deepEqual(created_joined.seats, [null, null, null, null], "an empty room has four seats");

const taken = connect({ type: "create", id: "QMFTX" });
assert.equal(
    (await lobby(taken)).code,
    "ID_TAKEN",
    "a taken id is answered honestly: it is the host's own",
);
taken.socket.close();

// One opaque code covers both, which is the whole point of it (#8).
const missing = connect({ type: "join", id: "ZZZZZ" });
assert.equal((await lobby(missing)).code, "ROOM_UNAVAILABLE", "a room that does not exist");
missing.socket.close();

const locked = connect({ type: "create", password: "hunter2" });
const locked_id = (await lobby(locked)).id;
const wrong = connect({ type: "join", id: locked_id, password: "hunter3" });
assert.equal(
    (await lobby(wrong)).code,
    "ROOM_UNAVAILABLE",
    "a wrong password is indistinguishable from it",
);
wrong.socket.close();
const right = connect({ type: "join", id: locked_id, password: "hunter2" });
assert.equal((await lobby(right)).type, "joined", "the right password gets in");
right.socket.close();
locked.socket.close();

// Seats, usernames and the client token (#36), on the room the match below runs in.
const seated = await created.seats(["Alice", "Bob"]);
assert.deepEqual(seated.held, [0, 1], "a client is granted as many seats as it has names");
assert.deepEqual(seated.seats, ["Alice", "Bob", null, null], "and every seat carries its name");
assert.equal(seated.host, true, "the first client holding a seat is the host");

const generated = connect({ type: "join", id: "qmftx" });
const generated_joined = await lobby(generated);
assert.equal(generated_joined.id, "QMFTX", "a lowercase id joins the same room");
assert.deepEqual(
    generated_joined.seats,
    ["Alice", "Bob", null, null],
    "every client sees every seat in the room, with the username on it",
);
assert.deepEqual(generated_joined.held, [], "and holds none of them until it asks");

assert.equal(
    (await generated.seats(["alice"])).code,
    "NAME_TAKEN",
    "a username is room-unique, and case is not what makes it different",
);
assert.equal((await generated.seats([""])).code, "BAD_NAME", "a name is 1 to 16 characters");
assert.equal((await generated.seats(["x".repeat(17)])).code, "BAD_NAME", "on both ends");
assert.equal(
    (await generated.seats(["Carol", "Carol"])).code,
    "NAME_TAKEN",
    "two participants on one couch hit the same check",
);
assert.equal(
    (await generated.seats(["Carol", "Dave", "Erin"])).code,
    "ROOM_FULL",
    "a client is atomic: three seats into two free ones is refused, not part-filled",
);
// The grant itself, in a room of its own: the match below needs QMFTX's other two seats
// left to the AI.
const couch_host = connect({ type: "create", id: "KFTVW" });
await lobby(couch_host);
await couch_host.seats(["Ann", "Ben"]);
const couch = connect({ type: "join", id: "KFTVW" });
await lobby(couch);
const pair = await couch.seats(["Carol", "Dave"]);
assert.deepEqual(pair.held, [2, 3], "a couch pair takes the two that are left, together");
assert.equal(pair.host, false, "and does not take the host with them");
assert.deepEqual(
    pair.seats,
    ["Ann", "Ben", "Carol", "Dave"],
    "four seats, four participants, one room",
);
couch.socket.close();
couch_host.socket.close();

// A full match's worth of the protocol, through the same Room the browser runs: the seed
// and the settings arrive on `start`, the delay is derived and clamped, and seats are
// driven by stamped driver changes.
const seen = [];
generated.socket.receive((msg) => seen.push(msg));

const host_room = new Room(created.socket, () => ({ left: false, right: true, up: false }));
// Stepped from inside `on_start`, because that is what a browser does: `Game.start` pumps
// the first tick synchronously, and the browser delivers every frame after `start` as its
// own event. Anything the match needs for tick 0 has to be on `start` itself (#34).
let first_tick = null;
const started = new Promise(
    (resolve) =>
        (host_room.on_start = () => {
            first_tick = host_room.step();
            resolve();
        }),
);
// `held` is the relay's to answer with: this client asked for two names and was granted
// seats 0 and 1, and what it proposes here is only the seed and the settings (#36).
host_room.start({ seed: 1234, settings: { no_gore: true }, held: [] });
await started;

assert.notEqual(first_tick[0], undefined, "a held seat is its client's from the very first tick");
assert.equal(first_tick[2], undefined, "and a seat nobody holds is the AI's from the same one");

assert.equal(host_room.seed, 1234, "the seed rides on `start`");
assert.deepEqual(
    host_room.settings,
    default_config(),
    "the settings ride there too -- the room's own, not the ones this client proposed (#38)",
);
assert.ok(host_room.d >= 2 && host_room.d <= 10, "the delay is clamped to 2..10 ticks");

const fixed = host_room.d;
// The first d ticks are released frames, because the earliest frame anyone stamps is for
// tick d -- and then the held seats are driven, the unheld ones left to the AI.
const frames = [first_tick];
for (let tick = 0; tick < 40; tick++) frames.push(host_room.step());
assert.equal(host_room.d, fixed, "derived once at match start and never adapted mid-match");
assert.equal(frames[0][0].right, false, "a held seat is released until its first frame lands");
assert.equal(frames[fixed][0].right, true, "and driven by its client from tick d on");
assert.equal(frames[fixed][2], undefined, "a seat nobody holds has no frame, so the AI has it");

await new Promise((resolve) => setTimeout(resolve, 100));
const start_msg = seen.find((msg) => msg.type === "start");
assert.equal(start_msg.d, fixed, "every client in the room is handed the same delay");
assert.deepEqual(
    start_msg.drivers,
    ["local", "local", "ai", "ai"],
    "the driver table rides on `start`, so tick 0 has one before anybody steps it",
);

// A client that follows the link after the host started is told so, rather than waiting on
// a broadcast that already happened (#40).
const late = connect({ type: "join", id: "QMFTX" });
assert.equal((await lobby(late)).started, true, "a room with a match running says so on join");
late.socket.close();

// The host announces the end -- the relay cannot read the simulation, so the final board
// travels with the message -- and the announcement is over with it (#22).
host_room.end_match("lobby", [[0, 1]]);
await new Promise((resolve) => setTimeout(resolve, 100));
const ended = seen.find((msg) => msg.type === "match_end");
assert.equal(ended.reason, "lobby", "the reason is relayed verbatim");
assert.deepEqual(ended.matrix, [[0, 1]], "and so is the board the host counted");
const quiet = connect({ type: "join", id: "QMFTX" });
assert.equal(
    (await lobby(quiet)).started,
    false,
    "a room whose match was announced over stops telling arrivals one is running",
);
quiet.socket.close();
// Started again, so the host-departure rule at the end of this file has something to clear.
host_room.start({ seed: 1234, settings: {}, held: [] });
await new Promise((resolve) => setTimeout(resolve, 100));

// Fan-out: every other client in the room, and never the sender -- a client schedules its
// own frames when it sends them, which is what makes the delay one-way (#12). And a frame
// for a seat the sender does not hold is dropped on the way through (#7).
const sender = connect({ type: "create", id: "ECHZX" });
await lobby(sender);
await sender.seats(["Sender"]);
const other = connect({ type: "join", id: "ECHZX" });
// The relay mints the token; a client never picks its own (#7).
const token = (await lobby(other)).token;
assert.ok(token, "the handshake carries a token");
await other.seats(["Other"]);
const sender_saw = [];
const other_saw = [];
sender.socket.receive((msg) => sender_saw.push(msg));
other.socket.receive((msg) => other_saw.push(msg));
const pressed = { left: false, right: true, up: false };
sender.socket.send({ type: "input", t: 7, seats: { 0: pressed, 1: pressed } });
await new Promise((resolve) => setTimeout(resolve, 100));
const relayed = other_saw.filter((msg) => msg.type === "input");
assert.deepEqual(
    relayed.map((msg) => msg.t),
    [7],
    "the other client in the room sees the input",
);
assert.deepEqual(
    relayed[0].seats,
    { 0: pressed },
    "for the seat the sender holds, and not for the one it forged",
);
assert.deepEqual(sender_saw, [], "and the sender is never echoed its own");

// A client that walks back to the lobby keeps its seats and hands its bunnies to the AI, so
// the seat is held by somebody who is still in the room and driven by nobody. The board says
// which: "(AI)" is not only for a holder who dropped its connection (#13, #39).
other.socket.send({ type: "driver", seat: 1, driver: "ai" });
await new Promise((resolve) => setTimeout(resolve, 100));
assert.deepEqual(
    sender.events.filter((msg) => msg.type === "room").pop().labels,
    ["Sender", "Other (AI)", null, null],
    "a seat its holder handed over is named for the holder, and said to be the AI's",
);

// The token reclaims every seat that client held, across a disconnect (#7).
other.socket.close();
const back = connect({ type: "join", id: "ECHZX", token });
assert.deepEqual((await lobby(back)).held, [1], "a reload comes back to the seat it left");
const stranger = connect({ type: "join", id: "ECHZX" });
assert.deepEqual((await lobby(stranger)).held, [], "and a stranger is handed none of it");
assert.deepEqual(
    (await stranger.seats(["Stranger"])).held,
    [2],
    "a seat still held by an absent token is not one a stranger is given",
);

// A reload is a disconnect, so the host migrates -- and gets the room back when its own
// token returns inside the reservation window (amends #17).
const owner = connect({ type: "create", id: "HJZWR" });
const owner_token = (await lobby(owner)).token;
assert.equal((await owner.seats(["Owner"])).host, true, "the first seat-holder hosts");
const guest = connect({ type: "join", id: "HJZWR" });
await lobby(guest);
await guest.seats(["Guest"]);
owner.socket.close();
const while_away = await guest.until((msg) => msg.type === "room" && msg.host);
assert.equal(while_away.host, true, "the guest hosts while the owner is away");
assert.deepEqual(
    while_away.labels,
    ["Owner (AI)", "Guest", null, null],
    "and the board says who is really driving that seat while its holder is away (#13, #39)",
);
const returned = connect({ type: "join", id: "HJZWR", token: owner_token });
const restored = await lobby(returned);
assert.deepEqual(restored.held, [0], "the owner reclaims its seat");
assert.equal(restored.host, true, "and the room with it");
assert.equal(
    (await guest.until((msg) => msg.type === "room" && !msg.host)).host,
    false,
    "so the guest hands it back",
);
returned.socket.close();
guest.socket.close();

// Host migration: the oldest remaining seat-holding client, so a stranger leaving does not
// evaporate a live match (#14).
assert.equal((await back.until((msg) => msg.type === "room")).host, false, "not the host yet");
sender.socket.close();
assert.equal(
    (await back.until((msg) => msg.type === "room" && msg.host)).host,
    true,
    "the host migrates when the host leaves",
);

// A deliberate Leave frees the seats at once: the relay cannot tell one from a dropped
// connection unless it is told (#7). A dropped connection reserves them instead, and the
// window frees them when it expires (#17).
back.socket.send({ type: "leave" });
assert.deepEqual(
    (await stranger.until((msg) => msg.type === "room" && !msg.seats[1])).seats,
    ["Sender", null, "Stranger", null],
    "Leave frees the seat at once -- while seat 0's dropped holder keeps its reservation",
);
process.env.RESERVE_MS = "60";
const dropper = connect({ type: "join", id: "ECHZX" });
await lobby(dropper);
assert.deepEqual((await dropper.seats(["Dropper"])).held, [1], "the freed seat is handed on");
dropper.socket.close();
assert.equal(
    (await stranger.until((msg) => msg.type === "room" && !msg.seats[1])).seats[1],
    null,
    "a seat dropped by a disconnect is freed when its reservation window expires",
);
delete process.env.RESERVE_MS;
back.socket.close();
stranger.socket.close();

// The ready gate and the countdown (#37, #21). Ready is per client, the countdown's length
// is the deployment's, and both routes into the lobby are the one broadcast.
process.env.COUNTDOWN_MS = "2000";
const gate = connect({ type: "create", id: "TVWXY" });
await lobby(gate);
await gate.seats(["Host"]);
const late_ready = connect({ type: "join", id: "TVWXY" });
await lobby(late_ready);
await late_ready.seats(["Straggler"]);
const gate_saw = [];
const straggler_saw = [];
gate.socket.receive((msg) => gate_saw.push(msg));
late_ready.socket.receive((msg) => straggler_saw.push(msg));

gate.socket.send({ type: "start", seed: 1, settings: {} });
const counting = await late_ready.until((msg) => msg.type === "room" && msg.countdown);
assert.ok(counting.countdown <= 2000, "the countdown is what is left of the relay's deadline");
assert.equal(counting.started, false, "a room counting down is still in the lobby");
assert.deepEqual(
    counting.ready,
    [true, false, true, true],
    "starting counts as readying, a straggler is not ready, and an AI seat always is",
);
assert.equal(counting.you_ready, false, "ready is the client's own answer");

// Auto-ready on arrival: whoever joins inside a countdown has had nothing to press (#37).
const latecomer = connect({ type: "join", id: "TVWXY" });
assert.equal((await lobby(latecomer)).you_ready, true, "joining during a countdown is auto-ready");
latecomer.socket.close();

// Cancellable by the host alone, and un-readying inside one does not cancel it either
// (#21). Drained first, so the answer is the broadcast these two messages cause.
late_ready.events.length = 0;
late_ready.socket.send({ type: "cancel" });
late_ready.socket.send({ type: "ready", ready: false });
assert.ok(
    (await late_ready.until((msg) => msg.type === "room")).countdown,
    "neither a straggler's cancel nor its un-readying stops the countdown",
);
gate.socket.send({ type: "cancel" });
assert.equal(
    (await late_ready.until((msg) => msg.type === "room" && !msg.countdown)).started,
    false,
    "the host can cancel it, and cancelling starts nothing",
);
await new Promise((resolve) => setTimeout(resolve, 100));
assert.ok(!straggler_saw.some((msg) => msg.type === "start"), "a cancelled countdown never starts");

// The stragglers readying mid-countdown collapses it to an instant start (#21).
gate.socket.send({ type: "start", seed: 2, settings: {} });
await late_ready.until((msg) => msg.type === "room" && msg.countdown);
late_ready.socket.send({ type: "ready", ready: true });
await new Promise((resolve) => setTimeout(resolve, 100));
const collapsed = straggler_saw.find((msg) => msg.type === "start");
assert.ok(collapsed, "the last straggler readying starts the match at once");
assert.deepEqual(
    collapsed.drivers,
    ["local", "local", "ai", "ai"],
    "and the seats nobody holds are AI-filled",
);

// Both routes into the lobby are the same broadcast, and ready resets on entry (#37).
gate.socket.send({ type: "match_end", t: 0, reason: "lobby", matrix: [] });
const lobbied = await late_ready.until((msg) => msg.type === "room" && !msg.started);
assert.equal(lobbied.you_ready, false, "ready resets on lobby entry");
assert.ok(
    straggler_saw.some((msg) => msg.type === "match_end"),
    "the host's announcement reaches every client in the room",
);

// Seat churn is not a ready change: a stranger sitting down clears nobody's answer (#21).
late_ready.socket.send({ type: "ready", ready: true });
await late_ready.until((msg) => msg.type === "room" && msg.you_ready);
const sitter = connect({ type: "join", id: "TVWXY" });
await lobby(sitter);
await sitter.seats(["Sitter"]);
assert.equal(
    (await late_ready.until((msg) => msg.type === "room" && msg.seats[2])).you_ready,
    true,
    "ready survives somebody else taking a seat",
);
sitter.socket.send({ type: "leave" });
await late_ready.until((msg) => msg.type === "room" && !msg.seats[2]);

// At zero, a client that never readied gives up every seat and reserves nothing, and the
// match starts short of it (#17, #37).
process.env.COUNTDOWN_MS = "150";
late_ready.socket.send({ type: "ready", ready: false });
await late_ready.until((msg) => msg.type === "room" && !msg.you_ready);
gate.socket.send({ type: "start", seed: 3, settings: {} });
const vacated = await late_ready.until((msg) => msg.type === "room" && !msg.held.length);
assert.deepEqual(
    vacated.seats,
    ["Host", null, null, null],
    "the un-ready client's seat is free at zero, reserved for nobody",
);
assert.deepEqual(
    vacated.labels,
    ["Host", "Straggler (left)", "Sitter (left)", null],
    "but the board keeps the name of whoever last held it: a seat-keyed column of bumps " +
        "still needs a heading, and a seat nobody ever took has none of its own (#13, #39)",
);
await new Promise((resolve) => setTimeout(resolve, 100));
const short_handed = gate_saw.filter((msg) => msg.type === "start").pop();
assert.deepEqual(
    short_handed.drivers,
    ["local", "ai", "ai", "ai"],
    "and the match runs with the AI on the seat it gave up",
);
// A host that leaves takes its countdown with it: a successor inherits the room, never a
// match it did not propose (#37).
const leaver = connect({ type: "create", id: "PRSTV" });
await lobby(leaver);
await leaver.seats(["Leaver"]);
const stayer = connect({ type: "join", id: "PRSTV" });
await lobby(stayer);
await stayer.seats(["Stayer"]);
const stayer_saw = [];
stayer.socket.receive((msg) => stayer_saw.push(msg));
leaver.socket.send({ type: "start", seed: 4, settings: {} });
await stayer.until((msg) => msg.type === "room" && msg.countdown);
leaver.socket.close();
assert.equal(
    (await stayer.until((msg) => msg.type === "room" && !msg.countdown)).host,
    true,
    "the host leaving mid-countdown hands the room to the successor and cancels it",
);
await new Promise((resolve) => setTimeout(resolve, 200));
assert.ok(
    !stayer_saw.some((msg) => msg.type === "start"),
    "and the countdown it cancelled starts nothing",
);
stayer.socket.close();

delete process.env.COUNTDOWN_MS;

// The server-observed route into the lobby: the same `match_end`, with no board, because
// the relay ran no simulation to count one (#22, #37).
gate.socket.close();
const orphan = await late_ready.until((msg) => msg.type === "room" && !msg.started);
assert.equal(orphan.started, false, "a room left with no host is back in the lobby");
assert.ok(
    straggler_saw.filter((msg) => msg.type === "match_end").length > 1,
    "and every client in it hears the match end on the same broadcast the host would send",
);
late_ready.socket.close();

// Host config (#38): staged, applied when the next match begins, and a password that is
// write-only. Configuration has exactly one path now, which is why a client's own proposed
// settings are ignored above -- a differing no_gore desyncs the RNG on the first kill (#5).
const chief = connect({ type: "create", id: "WXYZB" });
const chief_joined = await lobby(chief);
assert.deepEqual(chief_joined.config, default_config(), "a new room starts on the defaults");
assert.equal(chief_joined.staged, null, "with nothing staged");
await chief.seats(["Chief"]);
const second = connect({ type: "join", id: "WXYZB" });
await lobby(second);
await second.seats(["Guest"]);
second.socket.send({ type: "ready", ready: true });
await second.until((msg) => msg.type === "room" && msg.you_ready);

// A client that is not the host configures nothing, so the jetpack never reaches the diff.
second.socket.send({ type: "config", config: { jetpack: true } });
chief.socket.send({ type: "config", config: { level: "caves", no_gore: true, ai_fill: false } });
const pending = await second.until((msg) => msg.type === "room" && msg.staged);
assert.deepEqual(
    pending.staged,
    { level: "caves", no_gore: true, ai_fill: false },
    "the host's change is staged as a diff, and only the host's",
);
assert.deepEqual(pending.config, default_config(), "the match being waited on is unchanged");
assert.equal(pending.you_ready, false, "and everyone's ready is cleared, which the banner says");

// Staging what is already staged changes nothing, so it must not clear the room again.
second.socket.send({ type: "ready", ready: true });
await second.until((msg) => msg.type === "room" && msg.you_ready);
chief.socket.send({ type: "config", config: { level: "caves", nonsense: true } });
const unchanged = await second.until((msg) => msg.type === "room");
assert.equal(unchanged.you_ready, true, "re-staging a value the room has clears nobody's ready");
assert.deepEqual(unchanged.staged, pending.staged, "and stages nothing new");

// A value the validator refuses is ignored, never read as a revert: it must not throw away
// the level that is already staged, and it must not clear the room on the way past.
chief.socket.send({ type: "config", config: { level: "levelmap.txt" } });
const refused = await second.until((msg) => msg.type === "room");
assert.deepEqual(
    refused.staged,
    pending.staged,
    "a level that is not one of the room's is ignored",
);
assert.equal(refused.you_ready, true, "and clears nobody's ready on its way to being ignored");

// Applied on restart, and that is the only place it is applied.
const guest_saw = [];
second.socket.receive((msg) => guest_saw.push(msg));
chief.socket.send({ type: "start", seed: 9, settings: { level: "mario", no_gore: false } });
await new Promise((resolve) => setTimeout(resolve, 100));
const configured = guest_saw.find((msg) => msg.type === "start");
assert.equal(configured.settings.level, "caves", "the match runs on the room's staged level");
assert.equal(configured.settings.no_gore, true, "and on its flags, not on the host's proposal");
assert.deepEqual(
    configured.drivers,
    ["local", "local", "off", "off"],
    "AI-fill off disables the seats nobody holds instead of growing bunnies on them",
);
const applied = await second.until((msg) => msg.type === "room" && msg.started);
assert.equal(applied.staged, null, "the staged change is spent, so the banner comes down");
assert.equal(applied.config.level, "caves", "and the room's config is the one being played");

// The password is write-only: set blind, never in a room view, and an empty one clears it
// (#8). It is the one setting that applies at once -- it guards the door, not the match.
chief.socket.send({ type: "config", password: "hunter2" });
await second.until((msg) => msg.type === "room");
const barred = connect({ type: "join", id: "WXYZB" });
assert.equal((await lobby(barred)).code, "ROOM_UNAVAILABLE", "a new password takes effect at once");
barred.socket.close();
second.socket.send({ type: "config", password: "" });
const admitted = connect({ type: "join", id: "WXYZB", password: "hunter2" });
const admitted_view = await lobby(admitted);
assert.equal(admitted_view.type, "joined", "a second cannot clear the host's password");
assert.ok(
    !JSON.stringify(admitted_view).includes("hunter2"),
    "and nothing a client is ever sent carries it, the host included",
);
admitted.socket.close();
chief.socket.send({ type: "config", password: "" });
await second.until((msg) => msg.type === "room");
const walk_in = connect({ type: "join", id: "WXYZB" });
assert.equal((await lobby(walk_in)).type, "joined", "an empty password is how a room loses one");
walk_in.socket.close();
second.socket.close();
chief.socket.close();

// --- snapshot, mid-match join and resync (#40) ---------------------------------------
//
// The relay stores the host's snapshot without decoding it -- the tick and the 16-entry
// board are plaintext beside the body for exactly that reason -- and rings the frames since
// it, so the payload that joins a match in progress is that pair plus the settings block.
const snap_host = connect({ type: "create", id: "SNAPX" });
await lobby(snap_host);
await snap_host.seats(["Chief"]);
const snap_saw = [];
snap_host.socket.receive((msg) => snap_saw.push(msg));
snap_host.socket.send({ type: "start", seed: 99, settings: {}, held: [] });
await new Promise((resolve) => setTimeout(resolve, 100));
const snap_start = snap_saw.find((msg) => msg.type === "start");
assert.ok(snap_start, "the host starts the match it will be the reference state for");

const matrix = new Array(16).fill(0);
// A frame the snapshot already accounts for, then the snapshot, then two it does not: the
// ring is the gap between that state and now, so the first one is dropped by the second.
snap_host.socket.send({ type: "input", t: 1, seats: { 0: pressed } });
snap_host.socket.send({ type: "snapshot", t: 3, matrix, body: "SNAPSHOT-BODY" });
snap_host.socket.send({ type: "input", t: 5, seats: { 0: pressed } });
snap_host.socket.send({ type: "input", t: 6, seats: { 0: pressed } });
await new Promise((resolve) => setTimeout(resolve, 100));

const late_joiner = connect({ type: "join", id: "SNAPX" });
assert.equal((await lobby(late_joiner)).started, true, "the room says a match is running");
const late_saw = [];
late_joiner.socket.receive((msg) => late_saw.push(msg));
// Seats taken while a match runs: the seat was the AI's when it began, so the room is told
// on an agreed tick that somebody is driving it now (#7).
assert.deepEqual((await late_joiner.seats(["Late"])).held, [1], "a seat is free mid-match");
// A non-host's snapshot is not the room's reference state and is dropped: there is no
// stagger, and a desynced client must not seed the next joiner (#19).
late_joiner.socket.send({ type: "snapshot", t: 99, matrix, body: "NOT-THE-HOSTS" });
late_joiner.socket.send({ type: "resync" });
await new Promise((resolve) => setTimeout(resolve, 100));
const payload = late_saw.find((msg) => msg.type === "start");
assert.ok(payload, "a client that asks is handed the match in progress");
assert.equal(payload.t, 3, "on the tick the host's snapshot was taken");
assert.equal(payload.snapshot, "SNAPSHOT-BODY", "with the host's body, opaque and unread");
assert.deepEqual(
    payload.inputs.map((frame) => frame.t),
    [5, 6],
    "and the frames since it, the ones it already accounts for pruned",
);
assert.deepEqual(payload.settings, default_config(), "the settings block rides with it (#22)");
assert.deepEqual(payload.held, [1], "the seats the joiner holds");
// The table the relay keeps is updated the moment a change is stamped, because that is
// what the board reads -- but the tick it takes effect on is later than the one this
// client lands on. So the payload undoes it and hands the change down instead: a joiner
// that drove a seat the rest of the room still has the AI on is a desync (#7).
assert.deepEqual(
    payload.drivers,
    ["local", "ai", "ai", "ai"],
    "the driver table as it will be on the tick this client lands on",
);
assert.deepEqual(
    payload.changes,
    [{ t: 7 + 2 * payload.d, seat: 1, driver: "local" }],
    "with the changes stamped for a later tick, on the tick every other client applies them",
);
assert.ok(payload.changes[0].t > payload.until, "which is a tick the replayed gap does not reach");
assert.equal(
    payload.until,
    7 - payload.d - 1,
    "replayed up to the tick the fastest client is about to step, not the one it stamps for",
);
// A change stamped inside the gap, rather than after the tick the replay ends on: the
// replay starts at the snapshot, so it has to be handed down as a change too. Baking it
// into the table would apply it from the snapshot's tick on, which is 30-odd ticks before
// every other client applied it.
for (let t = 10; t <= 40; t++) snap_host.socket.send({ type: "input", t, seats: { 0: pressed } });
const third = connect({ type: "join", id: "SNAPX" });
await lobby(third);
const third_saw = [];
third.socket.receive((msg) => third_saw.push(msg));
third.socket.send({ type: "resync" });
await new Promise((resolve) => setTimeout(resolve, 100));
const later = third_saw.find((msg) => msg.type === "start");
assert.ok(later.until > later.changes[0].t, "the stamped tick is inside the gap now");
assert.deepEqual(
    later.drivers,
    ["local", "ai", "ai", "ai"],
    "and the table is still the one the snapshot's tick had",
);
assert.deepEqual(
    later.changes,
    [{ t: 7 + 2 * later.d, seat: 1, driver: "local" }],
    "with the change applied where it belongs, part-way through the replay",
);
third.socket.close();
snap_host.socket.close();
late_joiner.socket.close();

// An ask the relay has nothing to answer with yet is remembered, not dropped: the first
// two seconds of a match are exactly when a seat is taken, and nobody asks twice (#40).
const early_host = connect({ type: "create", id: "SNPZX" });
await lobby(early_host);
await early_host.seats(["Chief"]);
early_host.socket.send({ type: "start", seed: 7, settings: {}, held: [] });
const early_guest = connect({ type: "join", id: "SNPZX" });
await lobby(early_guest);
const early_saw = [];
early_guest.socket.receive((msg) => early_saw.push(msg));
await early_guest.seats(["Early"]);
early_guest.socket.send({ type: "resync" });
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(
    early_saw.find((msg) => msg.type === "start"),
    undefined,
    "a room whose host has not snapshotted yet has nothing to hand over",
);
const early_matrix = new Array(16).fill(0);
early_matrix[1] = 2;
early_host.socket.send({ type: "snapshot", t: 0, matrix: early_matrix, body: "FIRST-BODY" });
// Answered by the snapshot rather than by a reply to anything, so this waits on the
// message and gives up rather than hanging a suite that has no test runner under it.
function awaited(seen, type) {
    return new Promise((resolve, reject) => {
        const since = Date.now();
        const wait = setInterval(() => {
            const msg = seen.find((one) => one.type === type);
            if (msg) {
                clearInterval(wait);
                resolve(msg);
            } else if (Date.now() - since > 2000) {
                clearInterval(wait);
                reject(new Error("no " + type + " ever arrived"));
            }
        }, 10);
    });
}
const answered = await awaited(early_saw, "start");
assert.equal(answered.snapshot, "FIRST-BODY", "so the host's first snapshot answers the ask");

// The relay runs no simulation, so a host that leaves without announcing an end used to
// take the board with it. The matrix rides plaintext on the snapshot, which is what lets
// the relay hand one over anyway (#13, #19). The seat goes first, because a room with a
// seat-holder left in it migrates the host instead of ending the match (#14).
early_guest.socket.send({ type: "leave" });
await new Promise((resolve) => setTimeout(resolve, 100));
early_host.socket.close();
const orphaned = await awaited(early_saw, "match_end");
assert.equal(orphaned.reason, "host_left");
assert.deepEqual(
    orphaned.matrix,
    [
        [0, 2, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
    ],
    "the host's last board, four by four, from the 16 entries beside the body it never read",
);
early_guest.socket.close();

// --- checksum desync detection (#41) ---------------------------------------------------
//
// The relay substitutes a missing frame, so every client in a room plays the same input
// stream and a divergence is a determinism bug rather than drift (#6, #17). The host's hash
// is the reference -- there is no vote, because a two-client room splits 1-1 every time --
// and the repair is the resync payload the join path already sends.
const chk_host = connect({ type: "create", id: "CHKSM" });
await lobby(chk_host);
await chk_host.seats(["Chief"]);
chk_host.socket.send({ type: "start", seed: 5, settings: {}, held: [] });
await new Promise((resolve) => setTimeout(resolve, 100));
chk_host.socket.send({ type: "snapshot", t: 0, matrix, body: "REFERENCE-BODY" });

const chk_guest = connect({ type: "join", id: "CHKSM" });
await lobby(chk_guest);
await chk_guest.seats(["Guest"]);
const chk_saw = [];
chk_guest.socket.receive((msg) => chk_saw.push(msg));

chk_host.socket.send({ type: "checksum", t: 30, h: 111 });
chk_guest.socket.send({ type: "checksum", t: 30, h: 111 });
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(
    chk_saw.find((msg) => msg.type === "start"),
    undefined,
    "two clients that agree on a tick hear nothing about it",
);

// Eight of the host's are kept, which at one every 30 ticks is four seconds -- long enough
// for a client's hash for the same tick to arrive either side of it, and no longer.
for (let t = 180; t <= 180 + 7 * 30; t += 30) chk_host.socket.send({ type: "checksum", t, h: 111 });
chk_guest.socket.send({ type: "checksum", t: 30, h: 999 });
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(
    chk_saw.find((msg) => msg.type === "start"),
    undefined,
    "and a hash for a tick the window has aged out has nothing to disagree with",
);

// The host's first, then the client's: the mismatch is the desync, and the answer is the
// same payload a mid-match joiner gets.
chk_host.socket.send({ type: "checksum", t: 600, h: 111 });
chk_guest.socket.send({ type: "checksum", t: 600, h: 222 });
const repaired = await awaited(chk_saw, "start");
assert.equal(repaired.snapshot, "REFERENCE-BODY", "a mismatch is answered with the host's state");
assert.equal(repaired.t, 0, "on the tick the host took it, which is the resync path exactly");

// The client's first this time. Clients run at their own pace, so either order happens; a
// hash with no host hash yet is held and compared when one arrives.
chk_saw.length = 0;
chk_guest.socket.send({ type: "checksum", t: 630, h: 222 });
chk_host.socket.send({ type: "checksum", t: 630, h: 111 });
assert.ok(
    await awaited(chk_saw, "start"),
    "a hash that arrives before the host's is still compared",
);

chk_saw.length = 0;
chk_host.socket.send({ type: "checksum", t: 660, h: 111 });
chk_guest.socket.send({ type: "checksum", t: 660, h: 222 });
assert.ok(await awaited(chk_saw, "start"), "three repairs in a match, and the room counts them");

// The fourth is a client the room cannot carry: a desync never heals on its own, so three
// repairs that did not take is a server-observed failure rather than a kick.
chk_saw.length = 0;
chk_host.socket.send({ type: "checksum", t: 690, h: 111 });
chk_guest.socket.send({ type: "checksum", t: 690, h: 222 });
assert.equal(
    (await chk_guest.until((msg) => msg.type === "error")).code,
    "DESYNC",
    "the fourth desync in a match closes the connection instead of repairing it",
);
assert.equal(
    chk_saw.find((msg) => msg.type === "start"),
    undefined,
    "with no fourth payload behind it",
);
chk_host.socket.close();
chk_guest.socket.close();

// Two builds of the simulation in one lockstep room is two different matches: the same seed
// drawn through different code diverges, and no amount of agreeing on input fixes it. The
// relay cannot tell one build from another by watching a room play, so it is told on the way
// in and refuses the mismatch (#40).
const built = connect({ type: "create", id: "BLDXZ", build: "one" });
await lobby(built);
const stale = connect({ type: "join", id: "BLDXZ", build: "two" });
assert.equal((await lobby(stale)).code, "OUT_OF_DATE", "a client on another build is refused");
const current = connect({ type: "join", id: "BLDXZ", build: "one" });
assert.equal((await lobby(current)).type, "joined", "and one on the room's build is not");
// The headless suites and `smoke.mjs` are clients too, and this guards against a tab left
// open across a rebuild rather than against a client that lies about what it is (#29).
const unversioned = connect({ type: "join", id: "BLDXZ" });
assert.equal((await lobby(unversioned)).type, "joined", "as is one that declares no build");
built.socket.close();
current.socket.close();
unversioned.socket.close();

// A level name is resolved by fetching `levels/<name>/<name>.dat` beside the page, so the
// list is only an allowlist while every name in it is really there (#38).
for (const level of LEVELS.slice(1))
    assert.ok(
        fs.existsSync(new URL("../game/levels/" + level + "/" + level + ".dat", import.meta.url)),
        level + " is offered in the level picker, so the relay has to be serving it",
    );

// The relay runs no simulation of its own, and the cheapest way to keep it that way is to
// notice when it starts importing one (#6).
const source = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
assert.ok(!/from "\.\.\/src\/game\//.test(source), "the relay imports nothing from the simulation");

// The host is what announced the match, so a room left without one stops telling arrivals
// that a match is running (#36).
created.socket.close();
const after = connect({ type: "join", id: "QMFTX" });
assert.equal(
    (await lobby(after)).started,
    false,
    "the match in progress goes with the host that announced it",
);
after.socket.close();
generated.socket.close();

server.close();
console.log("OK the relay routes rooms, hides its failures, fans out input and derives one delay");
process.exit(0);
