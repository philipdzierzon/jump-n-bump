var RELEASED = { left: false, right: false, up: false };

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

    // Set by the relay's `start`, which is where everything the match must agree on rides
    // -- the seed and the settings both, since a differing no_gore desyncs the RNG stream
    // on the first kill (#12, #5).
    this.d = 0;
    this.seed = 0;
    this.settings = {};
    this.on_start = null;
    this.on_match_end = null;

    transport.receive(function (msg) {
        switch (msg.type) {
            case "start":
                tick = 0;
                input_at = {};
                drivers_at = {};
                drivers = [];
                self.d = msg.d;
                self.seed = msg.seed;
                self.settings = msg.settings;
                held = msg.held;
                // A socket answers later than a loopback does, so the match's shared
                // state is not readable on the line after `start` (#34).
                if (self.on_start) self.on_start(msg);
                break;
            case "input":
                schedule_input(msg.t, msg.seats);
                break;
            case "driver":
                (drivers_at[msg.t] = drivers_at[msg.t] || []).push(msg);
                break;
            case "match_end":
                if (self.on_match_end) self.on_match_end(msg);
                break;
        }
    });

    function schedule_input(t, seats) {
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

    this.set_driver = function (seat, driver) {
        transport.send({ type: "driver", seat: seat, driver: driver });
    };

    // The host announces the end; the relay cannot read the simulation, so the final board
    // travels with it (#22, #19).
    this.end_match = function (reason, matrix) {
        transport.send({ type: "match_end", t: tick, reason: reason, matrix: matrix });
    };

    // One tick of the room: apply the driver changes stamped for it, send this client's
    // input frame for every seat it drives, and hand back the frames to simulate now. A
    // seat with no driver at all is one nobody is holding, which is the AI's (#7).
    this.step = function () {
        (drivers_at[tick] || []).forEach(function (change) {
            drivers[change.seat] = change.driver;
        });
        delete drivers_at[tick];

        var seats = {};
        held.forEach(function (seat, scheme) {
            if (drivers[seat] === "local") seats[seat] = read_input(scheme);
        });
        // Every tick, unconditionally, stamped d ahead so the delay is the one-way trip;
        // never echoed back to its sender, so this client schedules its own (#12, #6).
        schedule_input(tick + self.d, seats);
        transport.send({ type: "input", t: tick + self.d, seats: seats });

        var frames = input_at[tick] || {};
        delete input_at[tick];
        // A seat somebody drives but no frame arrived for is all keys released, never the
        // AI -- a missing frame is a missing frame (#6). The first d ticks of every match
        // are exactly this, since the earliest frame anyone stamps is for tick d.
        drivers.forEach(function (driver, seat) {
            if (driver !== "ai" && !frames[seat]) frames[seat] = RELEASED;
        });
        tick++;
        return frames;
    };
}
