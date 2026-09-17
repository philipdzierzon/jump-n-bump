// The relay (#34): room ids, the two failure answers, fan-out and the derived input delay.
// It runs against a real server on a real socket, because the protocol is the thing under
// test and a fake of it would be the thing under test instead. Run with `npm test`.
import assert from "node:assert";
import fs from "node:fs";

import { normalise_room_id } from "../src/net/room_id.js";
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
assert.deepEqual(host_room.settings, { no_gore: true }, "so do the settings, and only there");
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
