var RELEASED = { left: false, right: false, up: false };

// The most ticks a `start` may ask this client to replay. A minute of them costs a few
// hundred milliseconds; more than that is a host that stopped snapshotting rather than a
// gap worth closing, and a client that replayed it would land minutes behind the room and
// consume every frame late (#51). A gap this size is a match not joined, not one joined
// short: the caller checks `gap()` and stays in the lobby (#40).
export var MAX_CATCH_UP = 3600;

// How often a client hashes its own simulation and hands the hash to the relay, which holds
// the host's and compares (#41). Half a second: the relay keeps eight of the host's, so a
// client's hash for a tick has four seconds to arrive before the tick it names is aged out.
var CHECKSUM_TICKS = 30;

// The client's half of a room (#33). It owns the tick counter, the input-delay buffer and
// the driver table, and it never knows whether the transport under it is a WebSocket or
// the in-tab loopback -- offline play is a room of one, not a second code path (#16).
//
// `read_input(scheme)` returns this client's {left, right, up} for its scheme-th held
// seat; schemes belong to the client and bind to seats in join order (#32).
export function Room(transport, read_input) {
    "use strict";
    var self = this;
    var tick = 0;
    var held = [];
    var drivers = [];
    var input_at = {}; // tick -> { seat: frame }
    var drivers_at = {}; // tick -> [ driver message ]
    // Replaying the gap between a snapshot and now, rather than playing the match: no
    // frame of this client's own is read, scheduled or sent for a tick that is already
    // history, or it would overwrite the frames the gap is made of (#40).
    var catching_up = false;
    var catch_up_to = 0;
    // The newest tick anybody has stamped a frame for. A client stamps d ahead of the tick
    // it is on, so this less d is the tick the room's fastest client is on -- which is where
    // a client replaying a gap has to land, and it is fresher than the number the relay put
    // in the payload: fetching a level and unpacking a state takes time the room spends
    // playing (#40).
    var newest = 0;
    // What a late frame cost this client, counted per match (#70). A frame that crossed
    // late used to *be* the divergence -- it was used by whoever had not reached its tick
    // yet and substituted for by whoever had -- until the relay took the substitution over
    // and started dropping the frames that miss its deadline, so the room reads one input
    // stream whatever the wire does (#42). What is left here is the cost: how often this
    // client was the one being covered for. `margin` is the ticks of slack a frame landed with -- d when it crossed
    // instantly, zero in the nick of time, negative for a tick already stepped -- so the
    // worst of them starts at d, the best any frame can do, and falls from there. `late_by`
    // is how the late ones were distributed, which is the number a d has to cover and the
    // one thing a single worst case cannot tell you (#70).
    var stats = null;
    // A repair is something that happens inside a match, so it keeps the count going; a
    // match beginning and a match joined both start one. Tracked here because `start` and
    // `match_end` are both this layer's.
    var in_match = false;
    reset_stats();

    function reset_stats() {
        stats = { substituted: 0, arrived: 0, late: 0, worst_margin: self.d, late_by: {} };
    }

    // Set by the relay's `start`, which is where everything the match must agree on rides
    // -- the seed and the settings both, since a differing no_gore desyncs the RNG stream
    // on the first kill (#12, #5).
    this.d = 0;
    this.seed = 0;
    this.settings = {};
    // The host's packed simulation state, when this `start` is one that joins a match
    // already running or replaces a state that has gone wrong -- one payload, two
    // triggers (#40). Null on a `start` that begins a match at tick 0.
    this.resume = null;
    this.on_start = null;
    this.on_match_end = null;
    // What this client hashes its state to for a given tick, or null in a local room, which
    // has nobody to disagree with and checksums nothing (#41, #16). Set by the session,
    // because the state being hashed is the simulation's and this layer sees none of it.
    this.checksum = null;

    transport.receive(function (msg) {
        switch (msg.type) {
            case "start":
                // Zero when a match begins, the snapshot's own tick when this is a
                // mid-match join or a resync: the match is already running, and the state
                // that arrives with it belongs to a tick somewhere in the middle (#40).
                tick = msg.t | 0;
                input_at = {};
                drivers_at = {};
                // The table rides on `start` rather than as four stamped changes: a
                // client steps tick 0 the instant `start` lands, and a separate message
                // for that same tick is a message for a tick already stepped past (#34).
                drivers = msg.drivers.slice();
                self.d = msg.d;
                self.seed = msg.seed;
                self.settings = msg.settings;
                held = msg.held;
                self.resume = msg.snapshot || null;
                if (!in_match || !msg.snapshot) reset_stats();
                in_match = true;
                catch_up_to = Math.max(tick, msg.until == null ? tick : msg.until | 0);
                // The frames the relay rang since that snapshot: the gap between the
                // state and now, scheduled exactly as live ones are (#40).
                (msg.inputs || []).forEach(function (frame) {
                    schedule_input(frame.t, frame.seats);
                });
                // And the driver changes stamped for a tick this client has not reached:
                // wiped with `drivers_at` above, so the payload hands them back rather
                // than leaving this client the only one in the room that never applies
                // them (#7, #40).
                (msg.changes || []).forEach(function (change) {
                    (drivers_at[change.t] = drivers_at[change.t] || []).push(change);
                });
                // A socket answers later than a loopback does, so the match's shared
                // state is not readable on the line after `start` (#34).
                if (self.on_start) self.on_start(msg);
                break;
            case "input":
                // Measured on arrival rather than on use: this is the only moment the wire
                // trip and the sender's own lateness are both visible (#70).
                stats.arrived++;
                var margin = (msg.t | 0) - tick;
                if (margin < 0) {
                    stats.late++;
                    stats.late_by[margin] = (stats.late_by[margin] || 0) + 1;
                }
                if (margin < stats.worst_margin) stats.worst_margin = margin;
                schedule_input(msg.t, msg.seats);
                break;
            case "driver":
                (drivers_at[msg.t] = drivers_at[msg.t] || []).push(msg);
                break;
            case "match_end":
                in_match = false;
                if (self.on_match_end) self.on_match_end(msg);
                break;
        }
    });

    function schedule_input(t, seats) {
        if (t > newest) newest = t;
        var frames = (input_at[t] = input_at[t] || {});
        for (var seat in seats) frames[seat] = seats[seat];
    }

    this.start = function (config) {
        transport.send({
            type: "start",
            seed: config.seed,
            settings: config.settings,
            held: config.held,
        });
    };

    // Where a replay has to end: as far as the relay said, or as far as the frames that have
    // arrived since say, whichever is further on.
    function target() {
        return Math.max(catch_up_to, newest - self.d);
    }

    // How many ticks of history this `start` is asking to be replayed. Zero for one that
    // begins a match at tick 0.
    this.gap = function () {
        return target() - tick;
    };

    // Replays the gap, one `step` per tick, up to the tick the relay said the room's
    // fastest client is about to step: this client lands where everybody else is playing
    // from rather than a delay ahead of them (#40).
    this.catch_up = function (step) {
        catching_up = true;
        while (tick < target()) step();
        catching_up = false;
    };

    // The host's, every two seconds, and nobody else's: staggering four clients meant no
    // two ever snapshotted the same tick, so there was nothing to byte-compare and a
    // desynced client could seed the next joiner (#40 amends #19). The tick and the board
    // ride outside the body, which the relay stores without ever decoding.
    this.send_snapshot = function (t, matrix, body) {
        transport.send({ type: "snapshot", t: t, matrix: matrix, body: body });
    };

    // Asks for that payload: what a client sends to join a match in progress. A client
    // whose state has gone wrong never asks, because it cannot tell -- the relay sees the
    // checksums disagree and pushes the same payload down unprompted (#41).
    this.request_resume = function () {
        transport.send({ type: "resync" });
    };

    this.set_driver = function (seat, driver) {
        transport.send({ type: "driver", seat: seat, driver: driver });
    };

    // What the match cost this client: frames substituted for, frames that arrived after
    // the tick they were stamped for, and the worst slack any frame landed with (#70).
    this.stats = function () {
        return stats;
    };

    // The tick this room is on, which is the tick the match is on: what a time limit is
    // measured against, and the one counter there is (#39).
    this.now = function () {
        return tick;
    };

    // The host announces the end; the relay cannot read the simulation, so the final board
    // travels with it (#22, #19).
    this.end_match = function (reason, matrix) {
        transport.send({ type: "match_end", t: tick, reason: reason, matrix: matrix });
    };

    // Hands every seat this client drives to the AI, on a tick the whole room agrees on
    // (#7). This is what a client leaving the match says instead of going silent: a seat
    // with a driver and no frames is all keys released, which looks like a bunny stuck in
    // the scenery rather than one nobody is holding.
    this.release = function () {
        held.forEach(function (seat) {
            self.set_driver(seat, "ai");
        });
    };

    // A seat the room disabled: nobody holds it and the room's AI-fill is off, so the
    // match runs short-handed rather than growing a bunny nobody asked for (#7, #37).
    this.enabled_seat = function (seat) {
        return drivers[seat] !== "off";
    };

    // One tick of the room: apply the driver changes stamped for it, send this client's
    // input frame for every seat it drives, and hand back the frames to simulate now. A
    // seat with no driver at all is one nobody is holding, which is the AI's (#7).
    this.step = function () {
        (drivers_at[tick] || []).forEach(function (change) {
            drivers[change.seat] = change.driver;
        });
        delete drivers_at[tick];

        if (!catching_up) {
            var seats = {};
            held.forEach(function (seat, scheme) {
                if (drivers[seat] === "local") seats[seat] = read_input(scheme);
            });
            // Every tick, unconditionally, stamped d ahead so the delay is the one-way
            // trip; never echoed back to its sender, so this client schedules its own
            // (#12, #6).
            schedule_input(tick + self.d, seats);
            transport.send({ type: "input", t: tick + self.d, seats: seats });
            // On the same tick on every client, and from the same point in it: the state
            // hashed here is every tick before this one applied and none of this one, which
            // is a state each client reaches in its own time and all of them agree on. Not
            // while replaying a gap, for the reason no frame is sent there -- those ticks
            // are history, and the host hashed them seconds ago (#41).
            if (self.checksum && tick % CHECKSUM_TICKS === 0)
                transport.send({ type: "checksum", t: tick, h: self.checksum(tick) });
        }

        var frames = input_at[tick] || {};
        delete input_at[tick];
        // A seat somebody drives but no frame arrived for is all keys released, never the
        // AI -- a missing frame is a missing frame (#6). The first d ticks of every match
        // are exactly this, since the earliest frame anyone stamps is for tick d.
        //
        // It is a floor and not the substitution: the relay rings a released frame to the
        // whole room on its own deadline, so every client uses the same input for a tick
        // whose frame never came, and a client that put its own in would be playing a
        // different match from that tick on (#42 corrects #6). What is left here is the
        // ticks before anybody has stamped a frame at all, and a relay frame that has not
        // landed yet -- which is the same value, so it cannot manufacture a divergence.
        drivers.forEach(function (driver, seat) {
            if (driver !== "local" || frames[seat]) return;
            frames[seat] = RELEASED;
            // Not the first d ticks, where every seat is substituted for by definition, and
            // not a replayed gap, whose holes are the relay's ring rather than this
            // client's lateness (#70).
            if (!catching_up && tick >= self.d) stats.substituted++;
        });
        tick++;
        return frames;
    };
}
