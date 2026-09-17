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
        tick: 0,
        d: 2,
        started: false,
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

// Every client sees every seat and the username of the participant on it. `held` and `host`
// are the parts that differ per client, which is why this is a loop and not a broadcast.
function room_view(room, client) {
    return {
        seats: room.seats.map((seat) => (seat ? seat.name : null)),
        held: client.seats,
        host: !!client.host,
        started: room.started,
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
    client.seats.forEach(
        (seat, nth) => (room.seats[seat] = { token: client.token, name: names[nth] }),
    );
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
    room.clients.add(client);
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
    if (client.seats.length)
        setTimeout(() => {
            if (rooms[room.id] !== room) return;
            for (const other of room.clients) if (other.token === client.token) return;
            vacate(client);
            broadcast_state(room);
        }, reserve_ms()).unref();
    ensure_host(room);
    // The host is what announced the match, so a room left without one retires the
    // announcement: the client arriving next is joining a room, not waiting on a match
    // nobody runs.
    // ponytail: the real match-end triggers are #22's, and this is not one of them.
    if (![...room.clients].some((other) => other.host)) room.started = false;
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

function relay(client, msg) {
    const room = client.room;
    switch (msg.type) {
        case "start":
            if (!client.host) return;
            room.tick = 0;
            room.d = input_delay(room);
            room.started = true;
            // The driver table rides on `start` rather than as four changes stamped for
            // tick 0: a client steps tick 0 the instant `start` lands, and the browser
            // delivers each frame as its own event, so stamped changes for that tick
            // arrive after it has been stepped past and every seat stays with the AI.
            //
            // A seat is driven by a client when the client holding it is connected, and by
            // the AI otherwise -- which is AI-fill for an empty seat and for a seat whose
            // holder walked away between matches. `held` is this client's own seats, so it
            // is sent per client rather than broadcast: the seats it drives are the only
            // ones it reads a keyboard for (#7).
            // ponytail: a holder who leaves mid-match keeps its bunny standing still until
            // the next match. upgrade path: the released-frame and AI takeover (#42).
            const online = online_seats(room);
            const drivers = room.seats.map((seat, index) =>
                seat && online.has(index) ? "local" : "ai",
            );
            for (const other of room.clients)
                send(other, {
                    type: "start",
                    t: 0,
                    d: room.d,
                    seed: msg.seed,
                    settings: msg.settings,
                    held: other.seats,
                    drivers,
                });
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
        case "match_end":
            // Broadcast exactly as the host sent it, final board included: the relay
            // cannot read the simulation, so it could not compute one (#19, #22). The
            // announcement is over with it, so an arrival is told about a room and not
            // about a match nobody is running.
            room.started = false;
            broadcast(room, msg);
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
