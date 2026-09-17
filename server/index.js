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
        clients: new Set(),
        // Four seats, global to the room, one participant each. A seat is
        // { token, name } or null; the token is the client holding it, which is what makes
        // a seat reclaimable across a disconnect (#7).
        seats: new Array(SEATS).fill(null),
        // The last username on each seat, kept for as long as the room lives. The board is
        // seat-keyed, so a seat that has been vacated still has a column of bumps on it and
        // still needs a name over that column (#13, #39).
        last_names: new Array(SEATS).fill(null),
        tick: 0,
        d: 2,
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
              : online.has(seat)
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
        return to_lobby(room, { type: "match_end", reason: "host_left" });
    broadcast_state(room);
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
    broadcast(room, { type: "driver", t: room.tick + 2 * room.d, seat, driver });
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
