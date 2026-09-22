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
import { DRIVERS, MAX_CATCH_UP, config_diff, default_config } from "../src/net/room_config.js";

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
// A snapshot body is ~10 KB of base64 the relay never decodes. Bounded because it is
// client input the relay stores and hands to the next joiner.
const MAX_SNAPSHOT = 64 * 1024;
// How many of the host's checksums are remembered, at one every 30 ticks: four seconds,
// which is a whole snapshot interval plus the round trip a client's own hash for the same
// tick takes to arrive (#41).
// ponytail: a hash for a tick that has fallen out of the window is dropped uncompared, so a
// client more than four seconds behind the host is never checked. upgrade path: widen the
// window if that is ever a client worth checking rather than one already unplayable (#6).
const CHECKSUM_WINDOW = 8;
// The frame the relay puts in for a seat whose client did not send one in time, and the
// only input the relay ever invents (#42). Every other byte of a frame is a client's.
const RELEASED = { left: false, right: false, up: false };
// How many ticks of missing frames hand a seat to the AI. Thirty is half a second, biased
// short deliberately: taking the seat back is one message, and every other client in a
// lockstep room is stepping those ticks with a bunny nobody is steering (#17, #42).
const AI_AFTER = 30;
// A repair is the host's whole state plus every frame since it, replayed synchronously the
// moment it lands. Sending a second one before the host has snapshotted again repairs from
// the same state twice and costs the client the replay for nothing -- and a client that is
// behind because it is slow least of all, which is the spiral this interval exists to stop.
// Read per repair rather than once, so a test can shorten it without a second knob -- the
// same deployment-level dial `reserve_ms` and `countdown_ms` are, and never room config.
const repair_cooldown_ms = () => Number(process.env.REPAIR_COOLDOWN_MS || 2000);
// How long a client has to go without needing a repair before the ones it has had stop
// counting. A quiet period rather than a sliding window, because the allowance is for one
// run of repairs and not for the match: a client that has been fine for half a minute came
// back from the run that led to it, and whatever it does next is a new episode with its own
// five rather than the tail of one it has already recovered from. Five with no let-up
// between them is a client that is not coming back (#41).
//
// ponytail: a client that needs a repair just less often than this is repaired for as long
// as it cares to play, teleporting every half minute for everybody else. upgrade path: a
// cap on repairs for the whole match if one ever turns up in a log.
const repair_reset_ms = () => Number(process.env.REPAIR_RESET_MS || 30000);
const MAX_REPAIRS = 5;

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

// The same fan-out, minus the clients waiting for a seat. A client with no seat is not the
// test: one that followed a link into a running match has no seat either and is spectating
// the simulation it asked for (#40). A client in the queue asked for a seat and is waiting
// for one, which is the whole of what it is doing until it gets one (#44). Room news still
// reaches it -- that is `broadcast_state`, a loop of its own.
function broadcast_frame(room, msg, except) {
    for (const client of room.clients)
        if (client !== except && !client.queued.length) send(client, msg);
}

// The room's password, as it is stored and as every join is compared against it. One
// coercion for both sides, because the comparison is `!==`: a room created with something
// that is not a string could never be joined again -- by the host as much as by anybody --
// and the host's own config handler coerced while the create handler did not (#8, #82).
// Absent, empty or null is no password at all, which is also how a host clears one.
const password_of = (msg) => (msg.password == null ? null : String(msg.password) || null);

function create(client, msg) {
    const id = msg.id ? normalise_room_id(msg.id) : generate_room_id(rooms);
    if (!id) return send(client, { type: "error", code: "BAD_ID" });
    // A host-chosen id is answered honestly when it is taken: this is the creator's own
    // id, not somebody else's room being probed (#8).
    if (rooms[id]) return send(client, { type: "error", code: "ID_TAKEN" });
    rooms[id] = {
        id,
        password: password_of(msg),
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
        // The newest tick the ring's own count cap has ever evicted -- a snapshot at or
        // behind this tick cannot be served, count-cap-safe or not (#92 review). -1, not 0:
        // a legitimate first snapshot lands at tick 0, and 0 is a real tick, not "never".
        holed: -1,
        // The host's hash for each of the last CHECKSUM_WINDOW checksummed ticks, and
        // nobody else's: a client cannot push an entry in here, so it cannot flush the
        // reference out of it either (#41). `desyncs` is the room's own counter, which is
        // how a determinism defect gets noticed in the wild -- it is the number in the log.
        // It counts mismatches *seen*, not repairs sent: the three branches in `desync()`
        // that can repair nothing are detections all the same, and a counter that skipped
        // them read zero for exactly the desyncs nobody could see (#118, #126).
        checksums: [],
        desyncs: 0,
        // Driver changes stamped for a tick nobody has stepped yet. The table above is
        // updated the moment one is stamped, because that is what the board reads -- so a
        // client joining now has to be handed the table as it will be on the tick it lands
        // on, plus the changes themselves, or it would drive a seat the rest of the room
        // still has the AI on (#7, #40).
        stamped: [],
        // The relay's own deadline, and what it has spent on it (#42). `due` is the tick
        // every client's frame for was needed by, and is where substitution has got to;
        // `missing` counts, per seat, how many ticks in a row the relay has had to put a
        // released frame in for -- thirty of them hands that seat to the AI. `late` and
        // `forged` are the two ways a frame is dropped silently, counted per room and read
        // from the log line the match ends on. Both are incremented where the frame is
        // refused, which is the same rule `desyncs` above keeps: a counter counts what the
        // relay saw, and the log line says what it did about it. A counter added here goes
        // at its own refusal site, not after whatever the refusal led to (#118, #126).
        due: 0,
        missing: new Array(SEATS).fill(0),
        substituted: 0,
        late: 0,
        forged: 0,
        // What each token has spent of its repair allowance, and whether the relay has given
        // up repairing it this match (#41, #93). Keyed by token, not kept on the socket: the
        // socket is what a reload replaces, so a counter on it counts reloads, not repairs.
        // Emptied at `begin`, which is the fresh start a new match is. Not a growth bound: a
        // room that never starts one, or an endless match, accumulates one entry per token
        // admitted. Bounded with the rest of abuse (#47).
        //
        // ponytail: the token is accepted from the client verbatim (`admit`), so a client that
        // wants a fresh allowance sends a fresh one. The seat no longer comes back with it:
        // both doors into one refuse a seat the AI is not driving mid-match, so a `leave`
        // costs the thirty missing ticks it takes the room to hand that bunny over rather
        // than a round trip (#116). Closes the accidental reload, deters nothing deliberate.
        // upgrade path: an identity the client cannot choose (#7), or rate limiting (#47).
        allowances: new Map(),
        // The whole phase model: a room is in lobby or in-game, and there is no third
        // (#21). The countdown is part of the lobby, not a phase of its own.
        started: false,
        // The room's config, and the only configuration path there is: the creator gets
        // the defaults and the host stages changes from the lobby (#38). Nothing on the
        // handshake sets it, so a link cannot carry one either.
        // Chosen once, on the way in, and never again: the public list is not host config,
        // so there is no staging path and nothing to change while the room is live (#43).
        listed: !!msg.listed,
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
    if (!room || room.password !== password_of(msg))
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

// Which seat the host is sitting on. `host` in the room view is the recipient's own answer,
// so a client that is not the host is told there is one and never which (#88).
// ponytail: the first of the host's seats, so a couch is named after its first participant;
// upgrade path is sending every seat it holds if the sentence ever names more than one.
function host_seat(room) {
    for (const client of room.clients)
        if (client.host && client.seats.length) return client.seats[0];
    return null;
}

// Host is a property of the client, not of a seat or a participant, and it always holds at
// least one seat -- which is also why it cannot drop its last one: a client's seat count is
// fixed for the room's lifetime (#7, #14). It migrates to the oldest remaining seat-holding
// client, so a stranger who leaves does not evaporate a live match.
function ensure_host(room) {
    if (host_seat(room) !== null) return;
    let successor = null;
    for (const client of room.clients)
        if (client.seats.length && (!successor || client.arrived < successor.arrived))
            successor = client;
    for (const client of room.clients) client.host = client === successor;
}

// The one room Quick Join would put this client in, or null if none would take it. Listed
// and unlocked, because an unlisted room is somebody's private code and a locked one is
// nobody's to walk into; room enough for the whole client, because a couch is atomic; and a
// name it can still use.
//
// Fewest free seats first, then a match in progress over a lobby, then oldest. Concentrating
// rather than spreading is the whole point: spreading is what makes a quiet subdomain feel
// broken, and a lobby may never start on its own -- the default bump limit is endless (#44).
// Insertion order is creation order, so "oldest" needs no timestamp and a stable sort keeps
// it (#43).
function best_room(names, build) {
    return (
        Object.values(rooms)
            .filter(
                (room) =>
                    room.listed &&
                    !room.password &&
                    !(build && room.build && build !== room.build) &&
                    free_seats(room).length >= names.length &&
                    !name_taken(room, names),
            )
            .sort(
                (a, b) =>
                    free_seats(a).length - free_seats(b).length ||
                    Number(b.started) - Number(a.started),
            )[0] || null
    );
}

// One round trip, and it never waitlists: a client that pressed Quick Join asked to play
// now, and the queue is the answer to wanting one particular room (#44). The pick and the
// seating happen in the same step, so there is no list to go stale between them and nothing
// to retry -- and when nothing fits, the answer is a room of its own rather than a wait.
function quick_join(client, msg) {
    const names = clean_names(msg.names);
    if (!names) return send(client, { type: "error", code: "BAD_NAME" });
    const room = best_room(names, msg.build);
    // Listed, because an unlisted one would leave the next client pressing Quick Join with
    // nothing to find and a second room to sit alone in. Either way the seats are taken
    // inside `admit`, on the way in: one round trip, one answer.
    if (!room) create(client, { ...msg, id: "", listed: true });
    else admit(client, room, msg);
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

// What the board calls each seat. Every state is the room's own knowledge: a seat held by a
// connected client is that participant, a seat whose holder was dropped out of this match
// says why, a seat whose holder is not connected is played by the AI, and a seat nobody
// holds any more keeps the name of whoever last did. A seat nobody ever took has no name
// here at all, and the client falls back to the bunny's (#13, #39, #41).
function seat_labels(room) {
    const online = online_seats(room);
    const dropped = new Set();
    for (const client of room.clients)
        if (client.allowance.dropped) for (const seat of client.seats) dropped.add(seat);
    return room.last_names.map((name, seat) =>
        !name
            ? null
            : !room.seats[seat]
              ? name + " (left)"
              : dropped.has(seat)
                ? name + " (out of sync)"
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
// What the relay had to invent to keep the room in one stream, and what it threw away doing
// it: the per-room counters #42 asked for, on one line per match. Both ends of a match say
// it -- one that reaches the lobby and one whose room died with its last client.
function report_match(room) {
    if (!room.started) return;
    console.log(
        "room %s match over: %d frames substituted, %d late, %d forged",
        room.id,
        room.substituted,
        room.late,
        room.forged,
    );
}

function to_lobby(room, msg) {
    report_match(room);
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
        // Which seat that host is on, so the lobby can name the player everyone is
        // waiting for: the flag above names nobody (#88).
        host_seat: host_seat(room),
        started: room.started,
        ready: ready_seats(room),
        you_ready: !!client.ready,
        // Waiting for a seat in this room rather than choosing names for one: the two are
        // the same zero seats held, and only one of them is a screen to stay on (#44).
        queued: !!client.queued.length,
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
// The seats nobody is holding. A reserved seat is not one of them: its holder's token owns
// it until the window runs out, which is the same reason `/api/rooms` counts it as occupied.
function free_seats(room) {
    return room.seats.map((seat, index) => (seat ? -1 : index)).filter((index) => index >= 0);
}

// Seats a whole client or none of it, which is the one rule every way into a seat obeys: a
// couch is atomic, so a client that does not fit waits rather than splitting (#14). False
// when the room cannot take it -- too few seats, or a name that somebody took while it
// waited.
function seat_client(client, names) {
    const room = client.room;
    // Mid-match, only a seat the AI is driving, which is the rule `claim_seat` has always
    // applied to the other door (#7, #37, #116): a seat its holder let go is still that
    // bunny's driver until the room hands it over, and one the room disabled stays disabled
    // for the match it was disabled in. Filtered before the fit test, not after the grant,
    // so a couch that no longer fits waitlists exactly as a full room makes it (#14, #44).
    const free = free_seats(room).filter((seat) => !room.started || room.drivers[seat] === "ai");
    if (free.length < names.length || name_taken(room, names)) return false;
    client.seats = free.slice(0, names.length);
    client.seats.forEach((seat, nth) => {
        room.seats[seat] = { token: client.token, name: names[nth] };
        room.last_names[seat] = names[nth];
    });
    client.queued = [];
    ensure_host(room);
    // Taken while a match is running: the seat was the AI's when that match began, so the
    // room is told on an agreed tick that somebody is driving it now (#7, #40). After the
    // grant, never during it: a half-seated couch is not a room view anybody should see.
    if (room.started) for (const seat of client.seats) stamp_driver(room, seat, "local");
    return true;
}

// A full room waitlists rather than refuses (#44): the names it asked with are kept, so a
// seat that frees can be handed over without asking for them again, and `arrived` -- which
// the room already keeps for host migration -- is the arrival order the queue is served in.
function take_seats(client, msg) {
    const room = client.room;
    if (client.seats.length) return;
    const names = clean_names(msg.names);
    if (!names) return send(client, { type: "error", code: "BAD_NAME" });
    if (name_taken(room, names)) return send(client, { type: "error", code: "NAME_TAKEN" });
    if (!seat_client(client, names)) client.queued = names;
    broadcast_state(room);
}

// The waitlist, in arrival order: the clients in this room holding no seats and waiting for
// some. Derived rather than kept, so a client that disconnects leaves the queue by leaving
// the room and there is no second list to keep true.
function queue(room) {
    return [...room.clients]
        .filter((client) => client.queued.length)
        .sort((a, b) => a.arrived - b.arrived);
}

// Freed seats go to the first waiting client that fits, and a smaller client may pass a
// blocked larger one: head-of-line blocking is accepted, not fixed, because a client is
// atomic and splitting one to fill a seat is the thing that rule exists to prevent (#44).
// The reserved holder is ahead of all of them, and needs no code here -- a reserved seat is
// still held, so it is not free to hand out. AI-fill is behind them, and happens where it
// always did: at the next `begin`, and mid-match after thirty missing ticks.
function seat_queue(room) {
    for (const client of queue(room)) {
        if (!seat_client(client, client.queued)) continue;
        // Seated inside a countdown it had no chance to press anything during, which is
        // the rule a client joining inside one already gets (#37).
        client.ready = !!room.deadline;
    }
}

// One seat at a time, which is the other way into one (#42). It is what a newcomer displaces
// an AI-filled bunny with, what a client vacated at the ready gate sits back down on, and
// what grows a client past the seat count it fixed at the names screen -- one path, and it
// works in either phase. A seat somebody else reserved is refused: a reservation is
// exclusive to its token for as long as it lasts, and free to anyone the moment it expires.
function claim_seat(client, msg) {
    const room = client.room;
    const seat = msg.seat | 0;
    if (!(seat >= 0 && seat < SEATS) || client.seats.includes(seat)) return;
    const held = room.seats[seat];
    if (held && held.token !== client.token)
        return send(client, { type: "error", code: "SEAT_TAKEN" });
    // Mid-match, only a seat the AI is driving: one a client is steering is not free, and
    // one the room disabled stays disabled for the match it was disabled in (#7, #37).
    if (!held && room.started && room.drivers[seat] !== "ai")
        return send(client, { type: "error", code: "SEAT_TAKEN" });
    if (!held) {
        const names = clean_names([msg.name]);
        if (!names) return send(client, { type: "error", code: "BAD_NAME" });
        if (name_taken(room, names)) return send(client, { type: "error", code: "NAME_TAKEN" });
        room.seats[seat] = { token: client.token, name: names[0] };
        room.last_names[seat] = names[0];
    }
    client.seats.push(seat);
    ensure_host(room);
    // The seat is granted now and driven when the client has a state to drive it from: the
    // `resume` it asks for next is where it is stamped back to this client (#40, #42).
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
    seat_queue(room);
}

// One record per token, made on the way in so nothing downstream has to test for it -- and
// found again rather than remade on a reconnect, which is the whole of #93.
function allowance_of(room, token) {
    let spent = room.allowances.get(token);
    if (!spent) room.allowances.set(token, (spent = { repairs: 0, at: 0, dropped: false }));
    return spent;
}

function admit(client, room, msg) {
    client.room = room;
    client.arrived = ++arrivals;
    // Identity is a server-minted opaque token, per client rather than per participant: one
    // browser is one socket and one reconnect, so the token reclaims every seat that client
    // held. A username is guessable by anyone in the room and is never an identity (#7).
    client.token = String(msg.token || "") || randomUUID();
    // The repair allowance is the player's, not the socket's: a reconnect on the same token
    // comes back to what it has spent rather than to a fresh five (#93).
    client.allowance = allowance_of(room, client.token);
    // A seat whose holder is connected is not reclaimable: duplicating a tab copies
    // sessionStorage, and two sockets driving one seat is a desync, not a rejoin.
    const online = online_seats(room);
    client.seats = room.seats
        .map((seat, index) =>
            seat && seat.token === client.token && !online.has(index) ? index : -1,
        )
        .filter((index) => index >= 0);
    // The names this client is waiting to sit down with, empty unless it asked for seats
    // in a room that had none (#44).
    client.queued = [];
    // Joining or reconnecting during a countdown is auto-ready: whoever arrives inside it
    // has had no chance to press anything, and would otherwise be vacated at zero (#37).
    client.ready = !!room.deadline;
    room.clients.add(client);
    // Quick Join answered the names screen before it asked, so its seats are taken on the
    // way in rather than on a second message: `joined` is what the client acts on, and a
    // client told it holds nothing walks back to the names screen (#44).
    if (msg.type === "quick") {
        const names = clean_names(msg.names);
        if (names) seat_client(client, names);
    }
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
        // How long this client's seats are held for it if the socket goes, so the page
        // knows when to stop retrying rather than guessing at the relay's dial (#42).
        reserve: reserve_ms(),
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
        report_match(room);
        delete rooms[room.id];
        console.log("room %s ended", room.id);
        return;
    }
    // A dropped connection reserves its seats for the token that held them, so a reload
    // reclaims them -- and frees them when the window expires, so a closed tab does not
    // hold a seat for the room's whole life (#17).
    // Mid-match, the seat goes on being played: the relay puts a released frame in for it
    // every tick until thirty of them hand it to the AI, and the client that dropped it
    // freezes under a Reconnecting overlay and retries until the window runs out (#42).
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
    // Not the clients waiting for a seat: a queued client's round trip is nobody's frame
    // deadline, and letting it set the delay would make the whole room play to the latency
    // of somebody who is not playing (#44).
    for (const client of room.clients)
        if (!client.queued.length) worst = Math.max(worst, client.one_way);
    return Math.min(10, Math.max(2, Math.ceil(worst / TICK_MS) + 1));
}

// The one thing the relay stamps itself, at currentTick + 2d (#12). `tick` is the first
// tick no client has reported stepping past: stamping one already stepped past would lose
// the change, since that tick never comes round again.
function stamp_driver(room, seat, driver) {
    const t = room.tick + 2 * room.d;
    // A seat handed to a client starts its gap count again: whatever that seat missed, it
    // missed while somebody else was driving it (#42).
    if (driver === "local") room.missing[seat] = 0;
    broadcast_frame(room, { type: "driver", t, seat, driver });
    room.stamped.push({ t, seat, driver, was: room.drivers[seat] });
    // A client that walks back to the lobby keeps its seats and hands the AI its bunnies,
    // so the seat is held, its holder is connected, and the AI is driving it all the same.
    // The board has to say so, which means the room is described again (#13, #39).
    room.drivers[seat] = driver;
    broadcast_state(room);
}

// The client holding a seat right now, or nothing when its holder is away: a seat whose
// token is nobody's open socket is a seat with no frames coming (#42).
function holder_of(room, seat) {
    for (const client of room.clients) if (client.seats.includes(seat)) return client;
    return null;
}

// The driver table as it was on a tick the room has not finished with. The table itself is
// updated the moment a change is stamped, but the change lands 2d ticks later, so the ticks
// in between are still the old driver's -- and substituting for a seat the room has not
// handed to the AI yet is exactly what those ticks need (#7, #42).
//
// All four seats in one pass. It answered a seat at a time, which was this scan four times
// on every tick of a catch-up run, over an array that only shrank when a snapshot landed
// (#92). `resume` had the same loop written out inline; it calls this now.
//
// ponytail: still a scan of the array, once per substitute call rather than four times a
// tick. upgrade path: a table kept alongside `room.due` and advanced with it, if a room
// ever holds enough stamped changes for the pass to show up.
function drivers_at(room, t) {
    const drivers = room.drivers.slice();
    for (let i = room.stamped.length - 1; i >= 0; i--)
        if (room.stamped[i].t > t) drivers[room.stamped[i].seat] = room.stamped[i].was;
    return drivers;
}

// The relay substitutes, never the client (#42 corrects #6). A client-local substitution
// manufactures a desync out of a late frame: the client that had not reached the tick used
// the frame when it finally came, and the one that had put released keys in its place, and
// the two played different matches from there. One released frame, broadcast to everybody
// including the seat's own holder, is one input stream.
//
// The deadline is the room's own 60 Hz clock and there is no slack margin, because d
// already is one: a client stamps its frames d ticks ahead of the tick it is on, so
// `room.tick - d - 1` is the tick the room's fastest client has just stepped, and a frame
// for it has had its whole delay to arrive. This runs off arriving frames rather than off a
// timer -- a room where nobody is sending has nobody to substitute for.
//
// ponytail: two ceilings, both sized for four seats. A room whose every client stops sending
// at once stops substituting and never hands a seat over -- a room with nobody left in the
// match to notice -- and `holder_of` is a linear scan run per seat per tick.
// upgrade path: a 60 Hz interval per started room, and a seat -> holder map, if a room ever
// has a spectator watching four AI bunnies play on after everybody dropped.
function substitute(room) {
    const limit = room.tick - room.d - 1;
    if (room.due > limit) return;
    // The table as of the first tick still to cover, and the changes that land inside the
    // run bucketed by the tick they land on: one pass over the stamped changes for the
    // whole run instead of one per seat on every tick of it (#92). A change stamped from
    // inside this loop -- the AI taking a seat over below -- is for `room.tick + 2d`, which
    // is past `limit`, so it lands after the run either way.
    const drivers = drivers_at(room, room.due);
    const landing = {};
    for (const change of room.stamped)
        if (change.t > room.due) (landing[change.t] = landing[change.t] || []).push(change);
    while (room.due <= limit) {
        const t = room.due++;
        for (const change of landing[t] || []) drivers[change.seat] = change.driver;
        const seats = {};
        for (let seat = 0; seat < SEATS; seat++) {
            if (drivers[seat] !== "local") continue;
            const holder = holder_of(room, seat);
            // A motionless player is holding no keys and still sending a frame every tick,
            // so it is never this: a drop is a missing frame, never a missing keypress
            // (#17). Detection is the socket closing or this gap, whichever comes first.
            if (holder && holder.last_t >= t) {
                room.missing[seat] = 0;
                continue;
            }
            seats[seat] = RELEASED;
            room.substituted++;
            // A client that is connected and has not sent a frame in this match yet is
            // still arriving, not gone: a gap needs a stream to be a gap in. Its seat is
            // covered for meanwhile, which is what the first d ticks of every match are
            // anyway -- and what a cold cache fetching the room's level looks like from
            // here (#38). A socket that closed is not this: its holder is nobody.
            // ponytail: so a tab that hangs before its first frame keeps a bunny standing
            // still for the whole match, which is what #42 found rather than what it broke.
            // upgrade path: a second, longer gap that converts a seat nobody ever drove, if
            // a level ever takes long enough to load that thirty ticks cannot tell them
            // apart.
            if (holder && holder.last_t < 0) continue;
            if (++room.missing[seat] >= AI_AFTER) {
                room.missing[seat] = 0;
                console.log(
                    "room %s seat %d to the AI after %d missing ticks",
                    room.id,
                    seat,
                    AI_AFTER,
                );
                stamp_driver(room, seat, "ai");
                // The one moment mid-match a free seat becomes grantable, now that a seat
                // is only grantable while the AI drives it: a `leave` frees seats the room
                // goes on driving for their holder, so a client that waitlisted against
                // them is served here rather than on a `leave` that may never come (#44).
                seat_queue(room);
            }
        }
        if (!Object.keys(seats).length) continue;
        broadcast_frame(room, { type: "input", t, seats });
        room.inputs.push({ t, seats });
        prune(room);
    }
}

// Everything the next resume could need and nothing older: the frames and the driver
// changes between the host's last snapshot and now, floored rather than counted so a
// throttled host does not outrun a fixed cap (#40, #70, #92). The ring is not sorted by
// tick, so a filter prunes it, guarded behind a prefix check since the floor rarely moves.
//
// ponytail: MAX_RING is the honest-client ceiling behind that floor -- a client resending
// frames at the tip forever never lets the floor catch up. What it evicts is not silent:
// `room.holed` remembers the newest tick lost that way, and both catch-up-ceiling guards
// refuse a snapshot at or behind it, so a resume never ships the hole this cap cuts.
// upgrade path: merge same-tick frames, four fifths of the memory, if a relay ever runs
// short.
const MAX_RING = MAX_CATCH_UP * (SEATS + 1);
function prune(room) {
    const floor = Math.max(room.snapshot ? room.snapshot.t : 0, room.tick - MAX_CATCH_UP);
    if (room.inputs.length && room.inputs[0].t < floor)
        room.inputs = room.inputs.filter((frame) => frame.t >= floor);
    while (room.inputs.length > MAX_RING) room.holed = Math.max(room.holed, room.inputs.shift().t);
    if (room.stamped.length && room.stamped[0].t <= floor)
        room.stamped = room.stamped.filter((change) => change.t > floor);
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
    prune(room);
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
    // Out of this match for good: a client the relay gave up repairing must not be handed
    // the match back by an ask still in flight, or by the next snapshot answering it (#41).
    if (client.allowance.dropped) return void (client.waiting = false);
    // A client waiting for a seat has nothing to resume into, and asks on the way *out* of
    // the queue instead -- `seat_client` clears `queued`, and the ask that follows is the
    // one every mid-match arrival makes (#40, #44).
    if (client.queued.length) return void (client.waiting = false);
    // Further back than the ring can reach: the frames between the snapshot and now are
    // what close the gap, and past the catch-up ceiling there are not all of them any more
    // -- a payload with a hole behind the state, which the joiner replays as released keys
    // (#92). Left standing rather than refused: `waiting` is already set by every caller, so
    // the host's next snapshot moves the floor up and answers this ask, exactly as it
    // answers one made before there was any snapshot at all (#40). The client keeps its seat
    // and its place in the room -- being out of a match is never being out of the room (#41,
    // #42).
    //
    // ponytail: a host that never snapshots again leaves the ask standing for the rest of
    // the match, silently, which is what a room with no snapshot at all already does.
    // upgrade path: tell the client, if a room ever sits in that state long enough for
    // anybody to ask why.
    if (room.tick - room.snapshot.t > MAX_CATCH_UP) return;
    // The floor missed one anyway: the ring's own count cap evicted a frame past this
    // snapshot's tick before the snapshot even existed, and `room.holed` is the newest tick
    // it took with it. A snapshot at or behind that is a hole no floor can undo (#92 review).
    if (room.snapshot.t <= room.holed) return;
    client.waiting = false;
    // Every hash this client stamped for a tick at or before now belongs to the state being
    // replaced, and some of it is still in flight: counting it would spend a second of the
    // room's three repairs on the desync already being repaired (#41).
    client.resync_t = room.tick;
    client.pending = null;
    // Back in the seat it left. A seat the relay handed to the AI while its holder was away,
    // and one taken from the AI mid-match, are the same thing from here: the client is given
    // the seat back on a tick the whole room agrees on, and the gap counter starts again
    // from nothing. Stamped here rather than on the grant, because this is the moment the
    // client has a state to play the seat from (#42).
    for (const seat of client.seats) {
        room.missing[seat] = 0;
        if (room.drivers[seat] === "ai") stamp_driver(room, seat, "local");
    }
    const until = Math.max(room.snapshot.t, room.tick - room.d - 1);
    // The driver table as it was on the tick the snapshot was taken, which is the tick the
    // replay starts from: every change stamped since -- pruned to exactly those when that
    // snapshot landed -- undone, and handed down as a change instead, to be applied on the
    // tick every other client applies it on.
    const ahead = room.stamped;
    const drivers = drivers_at(room, room.snapshot.t);
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

// The host is the reference and there is no vote: a two-client room splits 1-1 every time
// (#41 amends #19). A client's hash for a tick may arrive either side of the host's for it,
// so both sides compare on the way in and whichever came first is held. The relay reads
// none of it -- a hash is four bytes it matches against another four.
//
// ponytail: a host that is wrong takes the room with it, self-consistently. upgrade path:
// none short of a server-side simulation, which is the thing this whole design avoids (#6).
function keep_checksum(client, msg) {
    const room = client.room;
    if (!room.started) return;
    if (!Number.isInteger(msg.t) || !Number.isInteger(msg.h)) return;
    if (!client.host) {
        // `resync_t` is the guard here: a hash the client had already sent when the repair
        // was decided on belongs to the state being replaced. `dropped` beside it is a fast
        // path and not the rule -- `desync()` owns that one and checks it again -- worth its
        // half of the line for skipping the lookup and not parking a `pending` on a client
        // nobody is going to repair (#126).
        if (client.allowance.dropped || msg.t <= (client.resync_t || 0)) return;
        const reference = room.checksums.find((one) => one.t === msg.t);
        // Held one deep rather than queued: a client has one tick in flight at a time, and
        // a hash it sent for a tick the host has not reached yet is the newer question.
        if (!reference) return void (client.pending = { t: msg.t, h: msg.h });
        if (reference.h !== msg.h) desync(client, msg.t);
        return;
    }
    room.checksums.push({ t: msg.t, h: msg.h });
    if (room.checksums.length > CHECKSUM_WINDOW) room.checksums.shift();
    // Answered here rather than held: the clients that agreed are the ones nobody asks
    // about again, and the ones that did not are being repaired.
    for (const other of room.clients) {
        if (!other.pending || other.pending.t !== msg.t) continue;
        if (other.pending.h !== msg.h) desync(other, msg.t);
        other.pending = null;
    }
}

// Detected, and answerable with nothing: the three branches in `desync()` below repair no
// one, and until #118 each of them said so in the log nowhere and in the counter nowhere.
// #110 hid behind that silence for months. One helper for all three, so the shape cannot
// drift between them.
function unrepairable(client, t, why) {
    client.waiting = true;
    console.log(
        "room %s desync %d at tick %d, nothing to repair with (%s)",
        client.room.id,
        client.room.desyncs,
        t,
        why,
    );
}

// A mismatch is the desync -- the relay substitutes a missing frame, so every client's input
// stream is identical and a divergence is a determinism bug rather than routine drift (#17,
// #41). Recovery is the payload the join path already sends, and there is no new UI for it:
// a desync correction and a lag correction look alike from the inside.
function desync(client, t) {
    const room = client.room;
    // The player's record, not this socket's: a reload is a new socket on the same token and
    // comes back to what that token has spent (#93).
    const spent = client.allowance;
    // A hash held for a host hash that arrived after its sender went is nobody's
    // disagreement any more, and must not spend a repair.
    if (!room.clients.has(client) || spent.dropped) return;
    // Counted at detection rather than beside the repair: the counter says what the relay
    // saw, the log line beneath it says what the relay did about it (#118).
    room.desyncs++;
    // Nothing to repair it with yet: the host's first snapshot is two seconds into a match
    // and the first hashes are half a second in, so the whole allowance would be spent
    // before a single repair could be sent. Marked instead, and answered by that first
    // snapshot exactly as a mid-match joiner's ask is (#40).
    if (!room.snapshot) return unrepairable(client, t, "no snapshot yet");
    // Same shape, one snapshot later: a resume `room.tick - room.snapshot.t` this far past
    // cannot be served either, and spending a repair on an ask that comes back with nothing
    // is how a client starves its way to `drop_from_match` without ever having been repaired
    // (#92).
    if (room.tick - room.snapshot.t > MAX_CATCH_UP)
        return unrepairable(client, t, "snapshot is past the catch-up ceiling");
    // Same reason, same shape: the ring's count cap can evict past this snapshot's tick
    // before the ceiling above even trips, and spending a repair on that is spending it on
    // nothing (#92 review).
    if (room.snapshot.t <= room.holed)
        return unrepairable(client, t, "the frames behind the snapshot are gone");
    const now = Date.now();
    const since = now - spent.at;
    // Quiet for long enough: the run this client was in is over, and the repair that ended
    // it worked. What is starting now gets the whole allowance.
    if (since > repair_reset_ms()) spent.repairs = 0;
    // Still the same unrepaired desync, seen again 30 ticks later: the last repair has not
    // had a fresh snapshot to have worked from yet, so this is not a second one. Silent on
    // purpose, and the one branch in here that has to be: a client hashes every 30 ticks and
    // a divergence lasts until something repairs it, so a line here is a line every half
    // second for as long as the fault runs. It is still counted -- the count is sightings --
    // and the repair line below prints that count, so a count running ahead of the repair
    // number is how often this branch was taken (#118).
    else if (since < repair_cooldown_ms()) return;
    if (spent.repairs >= MAX_REPAIRS) {
        console.log(
            "room %s desync %d at tick %d, dropped after %d repairs with no let-up",
            room.id,
            room.desyncs,
            t,
            MAX_REPAIRS,
        );
        return drop_from_match(client);
    }
    console.log(
        "room %s desync %d at tick %d, repair %d of %d",
        room.id,
        room.desyncs,
        t,
        spent.repairs + 1,
        MAX_REPAIRS,
    );
    spent.repairs++;
    spent.at = now;
    client.waiting = true;
    resume(client);
}

// Out of the match, not out of the room (#41). The seat stays this client's, the board says
// why nobody is driving it, and the next match in this room is one it plays like any other
// -- which is the difference between a client the relay cannot carry and one it threw away.
//
// It is the message the host's own walk back to the lobby sends, to one client instead of
// the room: the client already ends its match on it, hands its seats to the AI on the way
// out and lands in the lobby with the board, so there is no second way out of a match (#22,
// #39).
function drop_from_match(client) {
    const room = client.room;
    client.allowance.dropped = true;
    client.waiting = false;
    // Every client on this token, not only the one that spent the last repair: a duplicated
    // tab (#93) shares the record, so a desync in one is a desync for both, and the other
    // must hear it too or it sits repaired-forever on a `dropped` record it never sees change.
    for (const other of room.clients)
        if (other.allowance === client.allowance)
            send(other, { type: "match_end", reason: "desync", matrix: last_board(room) });
    // The seat reads `(out of sync)` from here on, which is a change to the room.
    broadcast_state(room);
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
    room.holed = -1;
    room.stamped = [];
    room.checksums = [];
    room.desyncs = 0;
    // The deadline counts from this match's tick 0, and what the last one cost is the last
    // one's (#42).
    room.due = 0;
    room.missing = new Array(SEATS).fill(0);
    room.substituted = room.late = room.forged = 0;
    // A fresh match is a legitimately fresh allowance -- for every token in the room, dropped
    // or not (#41, #93). Cleared before the walk below, or the re-point it does is thrown
    // away again.
    room.allowances.clear();
    // Nobody is waiting to be let into a match that has not started yet: every client in
    // the room is being handed this one.
    // With the tick counter, since the next match counts from zero again: a client resynced
    // late in the last one would otherwise have every hash of this one ignored (#41).
    for (const other of room.clients) {
        other.waiting = false;
        other.resync_t = 0;
        other.pending = null;
        // A client dropped out of the last match plays this one: being out of step is the
        // match's state, never the room's (#41).
        other.allowance = allowance_of(room, other.token);
        // No frame in for a tick of a match that has not been stepped yet (#42).
        other.last_t = -1;
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
    // A holder who leaves mid-match is the substitution path's, not this one's: this is
    // only what each seat starts the match being driven by (#42).
    const online = online_seats(room);
    const drivers = room.seats.map((seat, index) =>
        seat && online.has(index) ? "local" : room.config.ai_fill ? "ai" : "off",
    );
    room.drivers = drivers;
    // Not the clients waiting for a seat: a queued client has no simulation, and a `start`
    // is what would make it build one. It enters through the resync path instead, once a
    // freed seat has made it a client in the match (#44).
    for (const other of room.clients)
        if (!other.queued.length)
            send(other, {
                type: "start",
                t: 0,
                d: room.d,
                seed: msg.seed,
                // The room's, never the proposer's: a client that configured itself -- an
                // old query param, a stale tab, a bot -- would desync the RNG stream on
                // the first kill, so what a `start` carries in `settings` is ignored here
                // (#5, #38).
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
    if ("password" in msg) room.password = password_of(msg);
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
        case "input": {
            if (!Number.isInteger(msg.t) || msg.t < 0) return;
            // A client waiting for a seat has no frame to send, and the one it sent would
            // move the room's clock on: `tick` is taken before any seat is looked at, so a
            // queued client could make every real client's frames late (#44).
            if (client.queued.length) return;
            // Past its deadline: the relay already put a released frame in for this tick and
            // the room stepped it, so the real one is for a tick that never comes round
            // again. Dropped silently and counted, because a client cannot be told to send
            // it sooner (#42).
            if (msg.t < room.due) return void room.late++;
            // And the other end of the same clock: a tick further ahead than any client
            // could catch up to is not a frame, it is a number. The line below raises the
            // room's tick to it, and `substitute` then walks every tick in between -- a
            // scan per seat per tick and a frame broadcast each -- which is the whole
            // process, and every room on it, for as long as the arithmetic takes (#80, #82).
            // ponytail: one frame may still legitimately push the room's clock a whole
            // minute ahead, which is 3600 substituted ticks in one turn of the event loop.
            // upgrade path: a bound of a few ticks past `room.tick + room.d`, if a client
            // whose clock raced ever turns out not to need the slack.
            if (msg.t - room.tick > MAX_CATCH_UP) return void room.forged++;
            // Monotonic, and a whole delay ahead of any client's real tick, since `t` is
            // already stamped d into the future: stamping too late loses nothing, and
            // letting a slower client drag it backwards would stamp a change for a tick a
            // faster one has stepped past.
            room.tick = Math.max(room.tick, msg.t + 1);
            // The newest tick this client has a frame in for, which is the whole of the
            // relay's frame-gap detection: it is d ticks ahead of the tick the client is
            // on, so a healthy one is always ahead of the deadline (#42).
            client.last_t = Math.max(client.last_t, msg.t);
            // Input for a seat the sender does not hold is dropped: one lookup per frame,
            // and the only forgery the relay can catch without a simulation (#7). Counted
            // per room with the late frames, and answered with nothing either way (#42).
            const seats = {};
            if (msg.seats && typeof msg.seats === "object")
                for (const seat in msg.seats) {
                    if (client.seats.includes(+seat)) seats[seat] = msg.seats[seat];
                    else room.forged++;
                }
            // Every other client, never the sender: it scheduled its own frame when it
            // sent it, which is what makes the delay one-way (#12).
            broadcast_frame(room, { type: "input", t: msg.t, seats }, client);
            // Rung as well as fanned out, the sender's own frames included: a joiner needs
            // every seat's input for the gap, not just the ones somebody else sent (#40).
            room.inputs.push({ t: msg.t, seats });
            prune(room);
            // An arriving frame is what moves the room's clock on, so it is also what makes
            // another client's missing one late (#42).
            substitute(room);
            break;
        }
        case "seats":
            take_seats(client, msg);
            break;
        case "take":
            claim_seat(client, msg);
            break;
        case "leave":
            // The socket usually follows, but the seats are free either way.
            vacate(client);
            broadcast_state(room);
            break;
        case "driver":
            // A seat's driver is its holder's to change, exactly as its input is. The seat
            // has to be one this client holds -- which is also what makes it a seat index
            // rather than an arbitrary property to write the driver table at -- and the
            // value has to be one the room knows: `local` for a seat somebody else holds
            // clears that seat's missing-tick counter, which is AI takeover itself switched
            // off (#7, #42). Counted as forged and answered with nothing, like a forged
            // frame is (#82).
            if (!client.seats.includes(msg.seat) || !DRIVERS.includes(msg.driver))
                return void room.forged++;
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
            // The host's to announce, as the start was (#22, #37). It ends the match for
            // everybody and the board rides on it verbatim -- the relay cannot read the
            // simulation, so it could not compute one (#19) -- which is exactly why a peer
            // must not be able to send one: it would end everyone's match and dictate the
            // result. The client's board-shape guard bounds the shape, not the right. A
            // client that still believes it is host through a migration is dropped here in
            // silence, which is the relay's flag being the one that counts (#82).
            if (!client.host) return;
            // The announcement is over with it, so an arrival is told about a room and not
            // about a match nobody is running.
            to_lobby(room, msg);
            break;
        default:
            // A type this relay has no case for: a newer client against an older
            // deployment, or a bot. Dropped -- the relay answers nothing it did not
            // understand -- but said so once per client rather than once per message.
            // ponytail: the type itself is never logged and the second unknown type from
            // the same client is silent, because `msg.type` is unbounded client input and
            // nothing rate-limits an established socket (#47). upgrade path: log the type
            // once payload caps exist.
            if (!client.unknown_type) {
                client.unknown_type = true;
                console.log("room %s dropped a message type it does not know", room.id);
            }
            break;
    }
}

// The five fields a room is chosen by, and nothing else: no level (nobody picks a room by
// it), no waitlist depth (`4/4` already says full) and no name (the host's username is the
// name). The password is a boolean here, as everywhere a client can see it (#8, #43).
function listing(room) {
    let host = null;
    for (const client of room.clients)
        if (client.host && client.seats.length) host = room.seats[client.seats[0]].name;
    return {
        id: room.id,
        host,
        seats: room.seats.filter(Boolean).length,
        of: SEATS,
        locked: !!room.password,
        started: room.started,
    };
}

// Most occupied first, oldest breaking ties -- the same concentrating rule Quick Join will
// use, so the two surfaces cannot contradict each other (#43, #44). `rooms` is keyed by
// five letters, never by digits, so its insertion order is creation order and a stable sort
// on occupancy alone leaves the oldest room first within each tie. No timestamp needed.
function listings() {
    return Object.values(rooms)
        .filter((room) => room.listed)
        .map(listing)
        .sort((a, b) => b.seats - a.seats);
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
    // A snapshot, never a subscription: Browse asks once on entry and the list is never
    // authoritative -- the join attempt is. Ten seconds of cache is what keeps a refresh
    // button from being a polling loop in disguise (#29, #43).
    app.get("/api/rooms", (_req, res) => res.set("Cache-Control", "max-age=10").json(listings()));

    const server = app.listen(port, "0.0.0.0");
    const sockets = new WebSocketServer({ server, path: "/ws" });

    sockets.on("connection", (client) => {
        client.one_way = 0;
        client.last_t = -1;
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
                    // The only number a client sends before it is even in a room, and the
                    // one every room's input delay is derived from. `NaN` walks straight
                    // through `input_delay`'s clamp -- `Math.max(2, NaN)` is `NaN` -- and
                    // the delay is fixed for the match at `begin`, so one malformed pong
                    // stops substitution comparing at all and serialises as `null` on
                    // `start`, leaving every client stamping with no delay (#34, #82).
                    if (Number.isFinite(msg.at)) client.one_way = (Date.now() - msg.at) / 2;
                    break;
                case "create":
                    if (!client.room) create(client, msg);
                    break;
                case "join":
                    if (!client.room) join(client, msg);
                    break;
                case "quick":
                    if (!client.room) quick_join(client, msg);
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
