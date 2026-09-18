// The relay (#34). One Node process, one origin: express serves the built client and the
// WebSocket is terminated on the same port, so there is no CORS, no second hostname and no
// routing config -- the room id rides in the URL fragment, which never reaches here.
//
// It runs no simulation (#6). It stamps ticks and fans out frames; clients are trusted,
// because a bot sends legal inputs a server simulation would not catch either. The only
// game-shaped number in this file is a tick counter, and it exists solely so a driver
// change can be stamped for a tick nobody has stepped past yet.
//
// Rooms live in this process's memory. Ceiling: one process, and a restart drops every
// room -- the same blast radius a reconnect has to handle anyway (#42).
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocketServer } from "ws";

import { generate_room_id, normalise_room_id } from "../src/net/room_id.js";
import { config_diff, default_config } from "../src/net/room_config.js";

const PORT = process.env.PORT || 8080;
const TICK_MS = 1000 / 60;
const PING_MS = 1000;
const SEATS = 4;
const MAX_NAME = 16;
// How long a seat stays reserved for the token that dropped it. Long enough for a reload
// and for a phone moving WiFi -> cellular, which is what #17 sized it for; a deliberate
// Leave frees the seat at once and never waits for this. Read per disconnect rather than
// once, so a test can shorten it without a second knob.
const reserve_ms = () => Number(process.env.RESERVE_MS || 60000);
// How long the host's countdown runs when somebody is not ready (#21). The first
// deployment-level knob: it is not room config and never on the wire, and it is read per
// countdown rather than once, so it is tunable on a running relay (#11, #37).
const countdown_ms = () => Number(process.env.COUNTDOWN_MS || 10000);
// The input ring: every frame the relay has fanned out since the host's last snapshot, so
// a client joining mid-match gets the gap between that state and now (#40). The host
// snapshots every 2s, which is ~120 ticks of frames from up to four clients.
// ponytail: a hard cap on entries rather than on bytes, in case a host stops snapshotting
// -- the ring then holds the newest ~500 ticks and the oldest fall off the front. Upgrade
// path: drop the room's snapshot and stop ringing at all if that is ever a real state.
const MAX_RING = 2000;
// A snapshot body is ~10 KB of base64 the relay never decodes. Bounded because it is
// client input the relay stores and hands to the next joiner.
const MAX_SNAPSHOT = 64 * 1024;
// How many ticks the host's checksums are remembered for, at one every 30 ticks: four
// seconds, which is a whole snapshot interval plus the round trip a client's own hash for
// the same tick takes to arrive (#41).
const CHECKSUM_WINDOW = 8;
// Resyncs a client gets in one match before the relay gives up on it. A desync is a
// determinism bug, not drift: it never heals on its own, so a client that keeps disagreeing
// after three repairs is one the room cannot carry (#41).
const MAX_DESYNCS = 3;

const rooms = {};
// Arrival order, room-independent: the only thing it decides is which seat-holding client
// inherits the host when one leaves (#14).
let arrivals = 0;

function send(client, msg) {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(msg));
}

function broadcast(room, msg, except) {
    for (const client of room.clients) if (client !== except) send(client, msg);
}

function create(client, msg) {
    const id = msg.id ? normalise_room_id(msg.id) : generate_room_id(rooms);
    if (!id) return send(client, { type: "error", code: "BAD_ID" });
    // A host-chosen id is answered honestly when it is taken: this is the creator's own
    // id, not somebody else's room being probed (#8).
    if (rooms[id]) return send(client, { type: "error", code: "ID_TAKEN" });
    rooms[id] = {
        id,
        password: msg.password || null,
        // The build of the client that opened it. Every client in a lockstep room has to be
        // running the same simulation, and the relay cannot tell one build from another by
        // watching it play -- so it is told, and refuses the mismatch on the way in (#40).
        build: msg.build || null,
        clients: new Set(),
        // Four seats, global to the room, one participant each. A seat is
        // { token, name } or null; the token is the client holding it, which is what makes
        // a seat reclaimable across a disconnect (#7).
        seats: new Array(SEATS).fill(null),
        // The last username on each seat, kept for as long as the room lives. The board is
        // seat-keyed, so a seat that has been vacated still has a column of bumps on it and
        // still needs a name over that column (#13, #39).
        last_names: new Array(SEATS).fill(null),
        // Who is driving each seat, as last stamped. The relay runs no simulation, but it
        // does route every driver change, and that is the difference between a bunny its
        // participant is steering and one the AI took over (#13, #39).
        drivers: new Array(SEATS).fill(null),
        tick: 0,
        d: 2,
        // The seed the running match was started on, and the host's last snapshot with the
        // frames since it: the three things a client joining that match needs on top of
        // what a `start` already carries (#40).
        seed: 0,
        snapshot: null,
        inputs: [],
        // One entry per checksummed tick, newest CHECKSUM_WINDOW kept: the host's hash for
        // that tick and any client hash that arrived before it (#41). `desyncs` is the
        // room's own counter, which is how a determinism defect gets noticed in the wild --
        // it is the number in the log line.
        checksums: [],
        desyncs: 0,
        // Driver changes stamped for a tick nobody has stepped yet. The table above is
        // updated the moment one is stamped, because that is what the board reads -- so a
        // client joining now has to be handed the table as it will be on the tick it lands
        // on, plus the changes themselves, or it would drive a seat the rest of the room
        // still has the AI on (#7, #40).
        stamped: [],
        // The whole phase model: a room is in lobby or in-game, and there is no third
        // (#21). The countdown is part of the lobby, not a phase of its own.
        started: false,
        // The room's config, and the only configuration path there is: the creator gets
        // the defaults and the host stages changes from the lobby (#38). Nothing on the
        // handshake sets it, so a link cannot carry one either.
        config: default_config(),
        // Changes the host has staged, applied when the next match begins -- never to the
        // one being played (#38). Null when there is nothing waiting.
        staged: null,
        deadline: null,
        timer: null,
        pending: null,
    };
    console.log("room %s created", id);
    admit(client, rooms[id], msg);
}

function join(client, msg) {
    const room = rooms[normalise_room_id(msg.id)];
    // One opaque code for a wrong password and a missing room alike: telling them apart is
    // what would turn an unlisted room's id into something worth guessing at (#8). No
    // profanity blocklist, and no second failure code to leak the difference.
    if (!room || room.password !== (msg.password || null))
        return send(client, { type: "error", code: "ROOM_UNAVAILABLE" });
    // After the password, so a refusal still says nothing about a room the client could not
    // have joined anyway (#8). A client that declares no build is not checked: the headless
    // suites and `smoke.mjs` are clients too, and this catches a tab left open across a
    // rebuild rather than a client that lies about what it is running (#29 owns that).
    if (msg.build && room.build && msg.build !== room.build) {
        console.log("room %s refused build %s, running %s", room.id, msg.build, room.build);
        return send(client, { type: "error", code: "OUT_OF_DATE" });
    }
    admit(client, room, msg);
}

// A name is display-only and never an identity (#7) -- but it is client input rendered to
// everyone in the room, so it is bounded here: trimmed, 1-16 characters, no control
// characters, at most one per seat.
function clean_names(names) {
    if (!Array.isArray(names) || !names.length || names.length > SEATS) return null;
    const clean = names.map((name) => String(name == null ? "" : name).trim());
    const bad = (name) => !name.length || name.length > MAX_NAME || /\p{C}/u.test(name);
    return clean.some(bad) ? null : clean;
}

// Room-unique, rejected rather than auto-suffixed, and the two participants on one couch
// hit the same check as two clients do (#7).
function name_taken(room, names) {
    const all = room.seats
        .filter(Boolean)
        .map((seat) => seat.name)
        .concat(names)
        .map((name) => name.toLowerCase());
    return new Set(all).size !== all.length;
}

// Host is a property of the client, not of a seat or a participant, and it always holds at
// least one seat -- which is also why it cannot drop its last one: a client's seat count is
// fixed for the room's lifetime (#7, #14). It migrates to the oldest remaining seat-holding
// client, so a stranger who leaves does not evaporate a live match.
function ensure_host(room) {
    for (const client of room.clients) if (client.host && client.seats.length) return;
    let successor = null;
    for (const client of room.clients)
        if (client.seats.length && (!successor || client.arrived < successor.arrived))
            successor = client;
    for (const client of room.clients) client.host = client === successor;
}

// The seats whose holder is connected right now. A seat held by an absent token is neither
// reclaimable by anyone else nor driven by a keyboard, which is the one question both
// callers ask.
function online_seats(room) {
    const online = new Set();
    for (const client of room.clients) for (const seat of client.seats) online.add(seat);
    return online;
}

// Ready is declared per client and covers every seat it holds at once, forced by the input
// surface: a participant presses left, right and up and nothing else, so a second player on
// one couch has no key of its own to ready with (#7, #37). An AI-filled seat is implicitly
// ready, which is why this asks the clients and not the seats.
function all_ready(room) {
    for (const client of room.clients) if (client.seats.length && !client.ready) return false;
    return true;
}

// What the board calls each seat. The three states are all the room's own knowledge: a
// seat held by a connected client is that participant, a seat whose holder is not connected
// is played by the AI, and a seat nobody holds any more keeps the name of whoever last did.
// A seat nobody ever took has no name here at all, and the client falls back to the bunny's
// (#13, #39).
function seat_labels(room) {
    const online = online_seats(room);
    return room.last_names.map((name, seat) =>
        !name
            ? null
            : !room.seats[seat]
              ? name + " (left)"
              : online.has(seat) && room.drivers[seat] !== "ai"
                ? name
                : name + " (AI)",
    );
}

// Per seat, for display only: its holder's own flag, and ready for a seat the AI has.
function ready_seats(room) {
    const ready = room.seats.map(() => true);
    for (const client of room.clients)
        for (const seat of client.seats) ready[seat] = !!client.ready;
    return ready;
}

function cancel_countdown(room) {
    clearTimeout(room.timer);
    room.timer = null;
    room.deadline = null;
    room.pending = null;
}

// Ready resets on lobby entry and on the host staging a config change, and never on seat
// churn (#21). The countdown goes with it, which is how a staged change cancels one (#38).
function reset_ready(room) {
    cancel_countdown(room);
    for (const client of room.clients) client.ready = false;
}

// Both routes into the lobby -- the host announcing the end, and the server observing one --
// are this same broadcast and this same reset (#37, #22). The relay cannot read the
// simulation, so a final board rides along only when the host sent one (#19).
function to_lobby(room, msg) {
    room.started = false;
    reset_ready(room);
    broadcast(room, msg);
    broadcast_state(room);
}

// Every client sees every seat and the username of the participant on it. `held` and `host`
// are the parts that differ per client, which is why this is a loop and not a broadcast.
function room_view(room, client) {
    return {
        seats: room.seats.map((seat) => (seat ? seat.name : null)),
        labels: seat_labels(room),
        held: client.seats,
        host: !!client.host,
        started: room.started,
        ready: ready_seats(room),
        you_ready: !!client.ready,
        // Milliseconds left of the countdown, from the relay's own deadline rather than a
        // count the client accumulates: a hidden tab stops its game loop but not its
        // clock, and a countdown built on frames would freeze with it (#51).
        countdown: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
        // The config the next match will run on, and what the host has staged on top of
        // it: everyone sees both, because a banner naming the diff is what stops the
        // cleared ready checkboxes reading as a bug (#10, #38). The password is in neither
        // -- it is write-only, and the host is not exempt (#8).
        config: room.config,
        staged: room.staged,
    };
}

function broadcast_state(room) {
    for (const client of room.clients) send(client, { type: "room", ...room_view(room, client) });
}

// A client is atomic: its seat count is fixed at the names screen and granted
// all-or-nothing, so a couch pair stays together and keeps every seat (#14).
function take_seats(client, msg) {
    const room = client.room;
    if (client.seats.length) return;
    const names = clean_names(msg.names);
    if (!names) return send(client, { type: "error", code: "BAD_NAME" });
    if (name_taken(room, names)) return send(client, { type: "error", code: "NAME_TAKEN" });
    const free = room.seats.map((seat, index) => (seat ? -1 : index)).filter((i) => i >= 0);
    if (free.length < names.length) return send(client, { type: "error", code: "ROOM_FULL" });
    client.seats = free.slice(0, names.length);
    client.seats.forEach((seat, nth) => {
        room.seats[seat] = { token: client.token, name: names[nth] };
        room.last_names[seat] = names[nth];
    });
    ensure_host(room);
    // Taken while a match is running: the seat was the AI's when that match began, so the
    // room is told on an agreed tick that somebody is driving it now (#7, #40). After the
    // grant, never during it: a half-seated couch is not a room view anybody should see.
    if (room.started) for (const seat of client.seats) stamp_driver(room, seat, "local");
    broadcast_state(room);
}

// Frees every seat a client holds. Deliberate: pressing Leave says so before the socket
// goes, which is the only way the relay can tell a Leave from a dropped connection (#7).
function vacate(client) {
    const room = client.room;
    for (const seat of client.seats)
        if (room.seats[seat] && room.seats[seat].token === client.token) room.seats[seat] = null;
    client.seats = [];
    // A client with no seats is not in the room, so it has nothing left to come back to.
    if (room.away_host === client.token) room.away_host = null;
    ensure_host(room);
}

function admit(client, room, msg) {
    client.room = room;
    client.arrived = ++arrivals;
    // Identity is a server-minted opaque token, per client rather than per participant: one
    // browser is one socket and one reconnect, so the token reclaims every seat that client
    // held. A username is guessable by anyone in the room and is never an identity (#7).
    client.token = String(msg.token || "") || randomUUID();
    // A seat whose holder is connected is not reclaimable: duplicating a tab copies
    // sessionStorage, and two sockets driving one seat is a desync, not a rejoin.
    const online = online_seats(room);
    client.seats = room.seats
        .map((seat, index) =>
            seat && seat.token === client.token && !online.has(index) ? index : -1,
        )
        .filter((index) => index >= 0);
    // Joining or reconnecting during a countdown is auto-ready: whoever arrives inside it
    // has had no chance to press anything, and would otherwise be vacated at zero (#37).
    client.ready = !!room.deadline;
    room.clients.add(client);
    // A reload is a disconnect, so the host migrated the moment it dropped -- and hands the
    // room back when its own token returns inside the reservation window. Amends #17's
    // "host gets no grace and no restore": migration still happens immediately, so a host
    // that never comes back is never a single point of failure, but a refresh does not
    // cost you your own room.
    if (client.seats.length && room.away_host === client.token) {
        for (const other of room.clients) other.host = other === client;
        room.away_host = null;
    }
    if (client.seats.length) ensure_host(room);
    // `started` because `start` is a broadcast, not a replay: a client that follows the
    // link after the host began is waiting for the next match, and would otherwise wait
    // on a page that never says so. Joining the match in progress needs a snapshot (#40).
    send(client, {
        type: "joined",
        id: room.id,
        started: room.started,
        token: client.token,
        ...room_view(room, client),
    });
    broadcast_state(room);
}

function leave(client) {
    const room = client.room;
    if (!room) return;
    room.clients.delete(client);
    // The room dies with its last client, not with its creator: host migration is what
    // retired that rule (#14).
    if (!room.clients.size) {
        delete rooms[room.id];
        console.log("room %s ended", room.id);
        return;
    }
    // A dropped connection reserves its seats for the token that held them, so a reload
    // reclaims them -- and frees them when the window expires, so a closed tab does not
    // hold a seat for the room's whole life (#17).
    // ponytail: the reserved seat is played by the AI from the next match start and the
    // dropped client is told nothing. upgrade path: the released-frame, AI takeover
    // mid-match and the Reconnecting... overlay (#42).
    // Remembered only while the seats are: the window that reserves them is the window the
    // host role waits out too.
    if (client.host && client.seats.length) room.away_host = client.token;
    if (client.seats.length)
        setTimeout(() => {
            if (rooms[room.id] !== room) return;
            for (const other of room.clients) if (other.token === client.token) return;
            vacate(client);
            broadcast_state(room);
        }, reserve_ms()).unref();
    // The countdown is the host's to run and the host's to cancel, so a host that leaves
    // takes it with it rather than handing a successor a match it never proposed (#37).
    if (client.host && room.timer) cancel_countdown(room);
    ensure_host(room);
    // The host is what announced the match, so a room left without one retires the
    // announcement: the client arriving next is joining a room, not waiting on a match
    // nobody runs -- and the clients already in it hear it end on the same broadcast the
    // host's own announcement makes, which is the server-observed route into the lobby
    // (#22, #37). The relay ran no simulation, so there is no final board to send with it.
    if (room.started && ![...room.clients].some((other) => other.host))
        return to_lobby(room, {
            type: "match_end",
            reason: "host_left",
            // The relay ran no simulation, but the host's last snapshot carried the board
            // in plaintext beside the body -- which is the closest thing to a final one
            // when the host left without announcing an end (#13, #19). Null before the
            // first snapshot, and a client with a board of its own uses that instead.
            matrix: last_board(room),
        });
    broadcast_state(room);
}

// The 16-entry header of the host's last snapshot, as the four-by-four board every client
// reads (#13). The relay never decodes the body, which is why the board is beside it.
function last_board(room) {
    const matrix = room.snapshot && room.snapshot.matrix;
    if (!matrix) return null;
    return room.seats.map((_seat, index) => matrix.slice(index * SEATS, index * SEATS + SEATS));
}

// Derived once, from the worst one-way trip in the room, and fixed for the match: a delay
// that adapts mid-match is a delay every client disagrees about (#34). Clients stamp ticks
// ahead of time, so the cost is the one-way trip rather than the round trip.
function input_delay(room) {
    let worst = 0;
    for (const client of room.clients) worst = Math.max(worst, client.one_way);
    return Math.min(10, Math.max(2, Math.ceil(worst / TICK_MS) + 1));
}

// The one thing the relay stamps itself, at currentTick + 2d (#12). `tick` is the first
// tick no client has reported stepping past: stamping one already stepped past would lose
// the change, since that tick never comes round again.
function stamp_driver(room, seat, driver) {
    const t = room.tick + 2 * room.d;
    broadcast(room, { type: "driver", t, seat, driver });
    room.stamped.push({ t, seat, driver, was: room.drivers[seat] });
    // A client that walks back to the lobby keeps its seats and hands the AI its bunnies,
    // so the seat is held, its holder is connected, and the AI is driving it all the same.
    // The board has to say so, which means the room is described again (#13, #39).
    room.drivers[seat] = driver;
    broadcast_state(room);
}

// The host's simulation state, every 2s, and only the host's: whoever holds host holds
// truth, there is no vote and no authoritative server sim, and the reference moves with
// the host when it migrates (#40 amends #19). Four staggered clients meant no two ever
// snapshotted the same tick, so there was nothing to byte-compare and a desynced client
// could seed the next joiner.
//
// It is client input the relay stores and hands on, so it is bounded here -- but never
// decoded: the tick and the 16-entry bump matrix are plaintext beside the body for exactly
// that reason, and the body itself is an opaque blob (#12, #13).
function keep_snapshot(client, msg) {
    const room = client.room;
    if (!client.host || !room.started) return;
    if (!Number.isInteger(msg.t) || msg.t < 0) return;
    if (typeof msg.body !== "string" || !msg.body.length || msg.body.length > MAX_SNAPSHOT) return;
    const matrix = msg.matrix;
    if (!Array.isArray(matrix) || matrix.length !== SEATS * SEATS) return;
    if (!matrix.every((bumps) => Number.isInteger(bumps) && bumps >= 0)) return;
    room.snapshot = { t: msg.t, matrix, body: msg.body };
    // The frames and the driver changes that state already accounts for are the ones
    // nobody will ever ask for again: what both lists are for is the gap between it and
    // now, and the snapshot's tick is where that gap starts.
    room.inputs = room.inputs.filter((frame) => frame.t >= msg.t);
    room.stamped = room.stamped.filter((change) => change.t > msg.t);
    // A client that asked before there was anything to answer with: the first two seconds
    // of a match are exactly when a seat is taken, and an ask the relay drops is one
    // nobody repeats (#40).
    for (const other of room.clients) if (other.waiting) resume(other);
}

// One payload, two triggers (#40): a client joining a match in progress asks for this, and
// so does one whose own state has gone wrong (#41). It is a `start` like any other -- the
// settings block included, since a joiner with the wrong no_gore desyncs on the first kill
// (#22, #5) -- carrying the host's last snapshot and every frame since it.
//
// Sent on request rather than pushed with the handshake: a client has no simulation to
// receive it into until it has built one, and a `start` that lands before then is a `start`
// nobody heard.
function resume(client) {
    const room = client.room;
    if (!room.started || !room.snapshot) return;
    client.waiting = false;
    // Every hash this client stamped for a tick at or before now belongs to the state being
    // replaced, and some of it is still in flight: counting it would spend a second of the
    // room's three repairs on the desync already being repaired (#41).
    client.resync_t = room.tick;
    const until = Math.max(room.snapshot.t, room.tick - room.d - 1);
    // The driver table as it was on the tick the snapshot was taken, which is the tick the
    // replay starts from: every change stamped since -- pruned to exactly those when that
    // snapshot landed -- undone, newest first, and handed down as a change instead, to be
    // applied on the tick every other client applies it on.
    const ahead = room.stamped;
    const drivers = room.drivers.slice();
    for (let i = ahead.length - 1; i >= 0; i--) drivers[ahead[i].seat] = ahead[i].was;
    send(client, {
        type: "start",
        // The tick the snapshot was taken on, and the tick to replay the gap up to. A
        // client at tick c has stamped frames up to c + d, so `room.tick - d - 1` is the
        // tick the room's fastest client has just stepped: the joiner lands one tick
        // behind it, which is inside the window every other client is playing in. Landing
        // ahead of the room instead would leave it with no frames for the ticks it is
        // ahead by, and it would read them as all keys released -- which is also what
        // every client in the room does for a client more than d ticks behind, joiner or
        // no joiner (#6, #17).
        t: room.snapshot.t,
        until,
        d: room.d,
        seed: room.seed,
        settings: room.config,
        held: client.seats,
        // As of the tick the replay starts on, not as the match began: a seat the AI took
        // over is the AI's to this client too (#7).
        drivers,
        changes: ahead.map(({ t, seat, driver }) => ({ t, seat, driver })),
        snapshot: room.snapshot.body,
        inputs: room.inputs,
    });
}

// The host is the reference and there is no vote: a two-client room splits 1-1 every time,
// and a host that is wrong takes the room with it, self-consistently (#41 amends #19).
//
// A client's hash for a tick may arrive either side of the host's for it, so both sides
// compare on the way in and an entry holds whichever came first. The relay reads none of it
// -- a hash is four bytes it matches against another four.
function keep_checksum(client, msg) {
    const room = client.room;
    if (!room.started) return;
    if (!Number.isInteger(msg.t) || !Number.isInteger(msg.h)) return;
    if (!client.host && msg.t <= (client.resync_t || 0)) return;
    let entry = room.checksums.find((one) => one.t === msg.t);
    if (!entry) {
        room.checksums.push((entry = { t: msg.t, host: null, clients: [] }));
        if (room.checksums.length > CHECKSUM_WINDOW) room.checksums.shift();
    }
    if (!client.host) {
        if (entry.host === null) entry.clients.push({ client, h: msg.h });
        else if (entry.host !== msg.h) desync(client, msg.t);
        return;
    }
    entry.host = msg.h;
    // Answered here rather than held: the ones that agreed are the ones nobody asks about
    // again, and the ones that did not are being repaired.
    for (const waiting of entry.clients) if (waiting.h !== msg.h) desync(waiting.client, msg.t);
    entry.clients = [];
}

// A mismatch is the desync -- the relay substitutes a missing frame, so every client's input
// stream is identical and a divergence is a determinism bug rather than routine drift (#17,
// #41). Recovery is the payload the join path already sends, and there is no new UI for it:
// a desync correction and a lag correction look alike from the inside.
function desync(client, t) {
    const room = client.room;
    // A hash held for a host hash that arrived after its sender went is nobody's disagreement
    // any more, and must not spend one of the room's three repairs.
    if (!room.clients.has(client)) return;
    room.desyncs++;
    console.log("room %s desync %d at tick %d", room.id, room.desyncs, t);
    if (room.desyncs > MAX_DESYNCS) {
        // A server-observed failure, not a kick: three repairs did not take, so this client
        // is told why its socket is closing rather than left playing a match of its own.
        send(client, { type: "error", code: "DESYNC" });
        return client.close();
    }
    client.waiting = true;
    resume(client);
}

// The match itself begins here whichever way the host got to it -- every client ready, or
// a countdown run out (#37).
function begin(room, msg) {
    cancel_countdown(room);
    // Staged changes land here and nowhere else: "applied on restart" is this line (#38).
    if (room.staged) {
        room.config = { ...room.config, ...room.staged };
        room.staged = null;
    }
    room.tick = 0;
    room.d = input_delay(room);
    room.started = true;
    // The match that is beginning is not the one the cached state belongs to.
    room.seed = msg && msg.seed;
    room.snapshot = null;
    room.inputs = [];
    room.stamped = [];
    room.checksums = [];
    room.desyncs = 0;
    // Nobody is waiting to be let into a match that has not started yet: every client in
    // the room is being handed this one.
    // With the tick counter, since the next match counts from zero again: a client resynced
    // late in the last one would otherwise have every hash of this one ignored (#41).
    for (const other of room.clients) {
        other.waiting = false;
        other.resync_t = 0;
    }
    // The driver table rides on `start` rather than as four changes stamped for tick 0: a
    // client steps tick 0 the instant `start` lands, and the browser delivers each frame
    // as its own event, so stamped changes for that tick arrive after it has been stepped
    // past and every seat stays with the AI.
    //
    // A seat is driven by a client when the client holding it is connected, and by the AI
    // otherwise -- which is AI-fill for an empty seat and for a seat whose holder walked
    // away between matches. With AI-fill off the seat is disabled instead and the match
    // runs short-handed: one rule for a disconnect, a deliberate drop and an un-ready
    // client vacated at countdown zero (#7, #37). `held` is this client's own seats, so it
    // is sent per client rather than broadcast: the seats it drives are the only ones it
    // reads a keyboard for (#7).
    // ponytail: a holder who leaves mid-match keeps its bunny standing still until the
    // next match. upgrade path: the released-frame and AI takeover (#42).
    const online = online_seats(room);
    const drivers = room.seats.map((seat, index) =>
        seat && online.has(index) ? "local" : room.config.ai_fill ? "ai" : "off",
    );
    room.drivers = drivers;
    for (const other of room.clients)
        send(other, {
            type: "start",
            t: 0,
            d: room.d,
            seed: msg.seed,
            // The room's, never the proposer's: a client that configured itself -- an old
            // query param, a stale tab, a bot -- would desync the RNG stream on the first
            // kill, so what a `start` carries in `settings` is ignored here (#5, #38).
            settings: room.config,
            held: other.seats,
            drivers,
        });
    // The room changed on the way in -- the staged config landed -- and a client that is
    // not playing this match hears about it on the same broadcast every other change uses
    // (#36). It is also what retires the staged banner once the match it named begins.
    broadcast_state(room);
}

// At zero, a client that never readied gives up every seat it holds and reserves nothing:
// it could have readied and did not, which is not the disconnect the reservation window
// exists for -- a hidden tab that sat out a countdown included (#17, #51). The host readied
// by starting, so the vacate rule never collides with "the host cannot drop its last seat"
// and needs no guard for it (#37).
function countdown_zero(room) {
    if (rooms[room.id] !== room) return;
    const pending = room.pending;
    for (const client of [...room.clients])
        if (client.seats.length && !client.ready) vacate(client);
    // The seats changed hands before the match began, so the room is described again
    // first: a client vacated at zero has to hear that it holds nothing.
    broadcast_state(room);
    begin(room, pending);
}

// The host configures the room, and only the host (#38). Two clocks in one message: the
// password takes effect the moment it lands, because it guards the door rather than the
// match, and everything else is staged for the next match so a config change can never
// alter one being played.
//
// The password is write-only. It is compared in memory, never broadcast, never logged and
// never embedded in a link, so the host sets a replacement blind -- and an empty one clears
// it, which is the only way to remove one (#8). It travels plaintext over WSS; there is no
// database to protect at rest.
function host_config(client, msg) {
    const room = client.room;
    if (!client.host) return;
    if ("password" in msg) room.password = String(msg.password) || null;
    if (!msg.config) return broadcast_state(room);
    // Twice through the validator, because the two questions are different ones. First:
    // what did the host actually change? Diffing against the effective config drops a key
    // that is not one of the room's and a level that is not in the list, so an invalid
    // value is ignored rather than read as a revert of what is already staged.
    const effective = { ...room.config, ...room.staged };
    const wanted = { ...effective, ...config_diff(effective, msg.config) };
    // Second: what will the next match change? Against the applied config, not the staged
    // one, so the banner names the whole change -- and picking a value back to the one the
    // room already has un-stages it rather than stacking a second change on top.
    const staged = config_diff(room.config, wanted);
    const changed = JSON.stringify(staged) !== JSON.stringify(room.staged || {});
    room.staged = Object.keys(staged).length ? staged : null;
    // Ready resets on a staged change and the countdown goes with it (#37) -- but only on a
    // real one, or the host reading its own settings back would clear the room.
    if (changed) reset_ready(room);
    broadcast_state(room);
}

function relay(client, msg) {
    const room = client.room;
    switch (msg.type) {
        case "start": {
            if (!client.host) return;
            // Starting counts as readying (#37).
            client.ready = true;
            if (all_ready(room)) return begin(room, msg);
            // Nobody's start is instant while somebody is not ready: the countdown is the
            // host's, cancellable by the host, and its length is the deployment's (#21).
            cancel_countdown(room);
            const ms = countdown_ms();
            room.pending = msg;
            room.deadline = Date.now() + ms;
            room.timer = setTimeout(() => countdown_zero(room), ms);
            room.timer.unref();
            broadcast_state(room);
            break;
        }
        case "ready":
            // Ready is the client's, not the seat's, and it is never reset by seat churn
            // (#21). Readying the last straggler collapses the countdown to an instant
            // start; un-readying during one does not cancel it.
            client.ready = !!msg.ready;
            if (client.ready && room.timer && all_ready(room)) return begin(room, room.pending);
            broadcast_state(room);
            break;
        case "cancel":
            if (!client.host || !room.timer) return;
            cancel_countdown(room);
            broadcast_state(room);
            break;
        case "input":
            // Monotonic, and a whole delay ahead of any client's real tick, since `t` is
            // already stamped d into the future: stamping too late loses nothing, and
            // letting a slower client drag it backwards would stamp a change for a tick a
            // faster one has stepped past.
            room.tick = Math.max(room.tick, msg.t + 1);
            // Input for a seat the sender does not hold is dropped: one lookup per frame,
            // and the only forgery the relay can catch without a simulation (#7).
            const seats = {};
            for (const seat of client.seats)
                if (msg.seats && msg.seats[seat]) seats[seat] = msg.seats[seat];
            // Every other client, never the sender: it scheduled its own frame when it
            // sent it, which is what makes the delay one-way (#12).
            broadcast(room, { type: "input", t: msg.t, seats }, client);
            // Rung as well as fanned out, the sender's own frames included: a joiner needs
            // every seat's input for the gap, not just the ones somebody else sent (#40).
            room.inputs.push({ t: msg.t, seats });
            if (room.inputs.length > MAX_RING) room.inputs.shift();
            break;
        case "seats":
            take_seats(client, msg);
            break;
        case "leave":
            // The socket usually follows, but the seats are free either way.
            vacate(client);
            broadcast_state(room);
            break;
        case "driver":
            stamp_driver(room, msg.seat, msg.driver);
            break;
        case "snapshot":
            keep_snapshot(client, msg);
            break;
        case "checksum":
            keep_checksum(client, msg);
            break;
        case "resync":
            // Remembered rather than dropped when the host has not snapshotted yet: the
            // next snapshot answers it (#40).
            client.waiting = true;
            resume(client);
            break;
        case "config":
            host_config(client, msg);
            break;
        case "match_end":
            // Broadcast exactly as the host sent it, final board included: the relay
            // cannot read the simulation, so it could not compute one (#19, #22). The
            // announcement is over with it, so an arrival is told about a room and not
            // about a match nobody is running.
            to_lobby(room, msg);
            break;
    }
}

export function start_server(port = PORT) {
    const app = express();
    // Resolved from this file rather than from the working directory: the image runs it
    // from /app and a developer runs it from the repo root, and neither should have to
    // know that.
    app.use(
        express.static(
            process.env.CLIENT_DIR || fileURLToPath(new URL("../game", import.meta.url)),
        ),
    );
    app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

    const server = app.listen(port, "0.0.0.0");
    const sockets = new WebSocketServer({ server, path: "/ws" });

    sockets.on("connection", (client) => {
        client.one_way = 0;
        // Measured from the first message rather than the first interval: a room can be
        // started before a second has passed, and the delay is derived once (#34).
        const ping = () => send(client, { type: "ping", at: Date.now() });
        const timer = setInterval(ping, PING_MS);
        ping();

        client.on("message", (data) => {
            let msg;
            // ponytail: a malformed frame is dropped and the connection kept. upgrade
            // path: rate limits and payload caps live with the rest of abuse (#47).
            try {
                msg = JSON.parse(data.toString());
            } catch {
                return;
            }
            switch (msg.type) {
                case "pong":
                    client.one_way = (Date.now() - msg.at) / 2;
                    break;
                case "create":
                    if (!client.room) create(client, msg);
                    break;
                case "join":
                    if (!client.room) join(client, msg);
                    break;
                default:
                    if (client.room) relay(client, msg);
            }
        });

        client.on("close", () => {
            clearInterval(timer);
            leave(client);
        });
    });

    return new Promise((resolve) => server.on("listening", () => resolve(server)));
}

// Run directly rather than imported by a test.
if (process.argv[1] === import.meta.filename)
    start_server().then((server) => console.log("listening on :%d", server.address().port));
