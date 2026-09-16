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
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocketServer } from "ws";

import { generate_room_id, normalise_room_id } from "../src/net/room_id.js";

const PORT = process.env.PORT || 8080;
const TICK_MS = 1000 / 60;
const PING_MS = 1000;
const SEATS = 4;

const rooms = {};

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
        tick: 0,
        d: 2,
        started: false,
    };
    console.log("room %s created", id);
    admit(client, rooms[id]);
}

function join(client, msg) {
    const room = rooms[normalise_room_id(msg.id)];
    // One opaque code for a wrong password and a missing room alike: telling them apart is
    // what would turn an unlisted room's id into something worth guessing at (#8). No
    // profanity blocklist, and no second failure code to leak the difference.
    if (!room || room.password !== (msg.password || null))
        return send(client, { type: "error", code: "ROOM_UNAVAILABLE" });
    admit(client, room);
}

function admit(client, room) {
    // ponytail: the first client in is the host and holds every seat, which is what one
    // seat over a socket means -- `held` is broadcast unfiltered, so a second client in
    // the room drives all four seats too and the two desync on the first tick. upgrade
    // path: seats, a client token and host migration (#36), and a lobby to hold them
    // (#37).
    client.host = room.clients.size === 0;
    client.room = room;
    room.clients.add(client);
    // `started` because `start` is a broadcast, not a replay: a client that follows the
    // link after the host began is waiting for the next match, and would otherwise wait
    // on a page that never says so. Joining the match in progress needs a snapshot (#40).
    send(client, { type: "joined", id: room.id, host: client.host, started: room.started });
}

function leave(client) {
    const room = client.room;
    if (!room) return;
    room.clients.delete(client);
    // The room dies with its last client: nothing here outlives a connection, so there is
    // nothing to reconnect to yet (#42).
    if (!room.clients.size) {
        delete rooms[room.id];
        console.log("room %s ended", room.id);
    }
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
            broadcast(room, {
                type: "start",
                t: 0,
                d: room.d,
                seed: msg.seed,
                settings: msg.settings,
                held: msg.held,
            });
            // Initial drivers ride at tick 0, not at the 2d a mid-match change is stamped
            // for: `start` is itself the synchronisation point, so no client can have
            // stepped past tick 0 yet, and stamping 2d would leave the first 2d ticks of
            // every match with no driver at all and every seat handed to the AI.
            // ponytail: AI-fill is on, which is the room default. upgrade path: room
            // config turns it off and an unheld seat goes enabled = false (#7, #38).
            for (let seat = 0; seat < SEATS; seat++)
                broadcast(room, {
                    type: "driver",
                    t: 0,
                    seat,
                    driver: (msg.held || []).indexOf(seat) >= 0 ? "local" : "ai",
                });
            break;
        case "input":
            // Monotonic, and a whole delay ahead of any client's real tick, since `t` is
            // already stamped d into the future: stamping too late loses nothing, and
            // letting a slower client drag it backwards would stamp a change for a tick a
            // faster one has stepped past.
            room.tick = Math.max(room.tick, msg.t + 1);
            // Every other client, never the sender: it scheduled its own frame when it
            // sent it, which is what makes the delay one-way (#12).
            broadcast(room, msg, client);
            break;
        case "driver":
            stamp_driver(room, msg.seat, msg.driver);
            break;
        case "match_end":
            // Broadcast exactly as the host sent it, final board included: the relay
            // cannot read the simulation, so it could not compute one (#19, #22).
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
