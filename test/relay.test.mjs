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

// The transport is the client's, so the test drives the same one the browser does.
function connect(entry) {
    return new Promise((resolve) => {
        const socket = new WebSocket_Transport(
            url,
            entry,
            (joined) => resolve({ socket, joined }),
            (code) => resolve({ socket, code }),
        );
    });
}

const created = await connect({ type: "create", id: "qmftx" });
assert.equal(created.joined.id, "QMFTX", "a host-chosen id is accepted when free, uppercased");
assert.equal(created.joined.host, true, "the client that creates a room hosts it");

const taken = await connect({ type: "create", id: "QMFTX" });
assert.equal(taken.code, "ID_TAKEN", "a taken id is answered honestly: it is the host's own");
taken.socket.close();

// One opaque code covers both, which is the whole point of it (#8).
const missing = await connect({ type: "join", id: "ZZZZZ" });
assert.equal(missing.code, "ROOM_UNAVAILABLE", "a room that does not exist");
missing.socket.close();

const locked = await connect({ type: "create", password: "hunter2" });
const wrong = await connect({ type: "join", id: locked.joined.id, password: "hunter3" });
assert.equal(wrong.code, "ROOM_UNAVAILABLE", "a wrong password is indistinguishable from it");
wrong.socket.close();
const right = await connect({ type: "join", id: locked.joined.id, password: "hunter2" });
assert.ok(right.joined, "the right password gets in");
assert.equal(right.joined.host, false, "the second client in is not the host");
right.socket.close();
locked.socket.close();

const generated = await connect({ type: "join", id: created.joined.id.toLowerCase() });
assert.equal(generated.joined.id, created.joined.id, "a lowercase id joins the same room");

// A full match's worth of the protocol, through the same Room the browser runs: the seed
// and the settings arrive on `start`, the delay is derived and clamped, and seats are
// driven by stamped driver changes.
const seen = [];
generated.socket.receive((msg) => seen.push(msg));

const host_room = new Room(created.socket, () => ({ left: false, right: true, up: false }));
const started = new Promise((resolve) => (host_room.on_start = resolve));
host_room.start({ seed: 1234, settings: { no_gore: true }, held: [0, 1] });
await started;

assert.equal(host_room.seed, 1234, "the seed rides on `start`");
assert.deepEqual(host_room.settings, { no_gore: true }, "so do the settings, and only there");
assert.ok(host_room.d >= 2 && host_room.d <= 10, "the delay is clamped to 2..10 ticks");

const fixed = host_room.d;
// The first d ticks are released frames, because the earliest frame anyone stamps is for
// tick d -- and then the held seats are driven, the unheld ones left to the AI.
const frames = [];
for (let tick = 0; tick < 40; tick++) frames.push(host_room.step());
assert.equal(host_room.d, fixed, "derived once at match start and never adapted mid-match");
assert.equal(frames[0][0].right, false, "a held seat is released until its first frame lands");
assert.equal(frames[fixed][0].right, true, "and driven by its client from tick d on");
assert.equal(frames[fixed][2], undefined, "a seat nobody holds has no frame, so the AI has it");

await new Promise((resolve) => setTimeout(resolve, 100));
const start_msg = seen.find((msg) => msg.type === "start");
assert.equal(start_msg.d, fixed, "every client in the room is handed the same delay");
assert.deepEqual(
    seen.filter((msg) => msg.type === "driver" && msg.driver === "local").map((msg) => msg.seat),
    [0, 1],
    "the relay stamps the initial drivers rather than riding them on `start`",
);

// Fan-out: every other client in the room, and never the sender -- a client schedules its
// own frames when it sends them, which is what makes the delay one-way (#12).
const sender = await connect({ type: "create", id: "ECHZX" });
const other = await connect({ type: "join", id: "ECHZX" });
const sender_saw = [];
const other_saw = [];
sender.socket.receive((msg) => sender_saw.push(msg));
other.socket.receive((msg) => other_saw.push(msg));
sender.socket.send({ type: "input", t: 7, seats: { 0: { left: false, right: true, up: false } } });
await new Promise((resolve) => setTimeout(resolve, 100));
assert.deepEqual(
    other_saw.filter((msg) => msg.type === "input").map((msg) => msg.t),
    [7],
    "the other client in the room sees the input",
);
assert.deepEqual(sender_saw, [], "and the sender is never echoed its own");
sender.socket.close();
other.socket.close();

// The relay runs no simulation of its own, and the cheapest way to keep it that way is to
// notice when it starts importing one (#6).
const source = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
assert.ok(!/from "\.\.\/src\/game\//.test(source), "the relay imports nothing from the simulation");

created.socket.close();
generated.socket.close();
server.close();
console.log("OK the relay routes rooms, hides its failures, fans out input and derives one delay");
process.exit(0);
