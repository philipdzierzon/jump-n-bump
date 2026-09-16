// The in-tab stub that stands in for the relay in a local room (#16, #33). It emulates
// the whole relay -- echo, driver stamping, match end, the final board -- so nothing
// above it branches on whether the room is local.
//
// A local room has no room id: it is never listed, never password-protected, and nothing
// here records a statistic. Those are all absences, which is the point.
export function Loopback_Transport() {
    "use strict";
    var listener = null;
    var current_tick = 0;

    // d = 0: the floor of 2 is jitter insurance, and there is no jitter in the same tab
    // (#16 amends #12).
    var d = 0;

    function to_client(msg) {
        if (listener) listener(msg);
    }

    // A driver change is the one thing the relay stamps itself, at currentTick + 2d (#12).
    // `current_tick` is the first tick not yet simulated: stamping the tick a client has
    // already stepped past would lose the change, since that tick never comes round again.
    function stamp_driver(seat, driver) {
        to_client({ type: "driver", t: current_tick + 2 * d, seat: seat, driver: driver });
    }

    this.receive = function (fn) {
        listener = fn;
    };

    this.send = function (msg) {
        switch (msg.type) {
            case "start":
                current_tick = 0;
                to_client({
                    type: "start",
                    t: 0,
                    d: d,
                    seed: msg.seed,
                    settings: msg.settings,
                    held: msg.held,
                });
                // Initial drivers are stamped like any other change rather than riding on
                // `start`: one mechanism, and at tick 0 it stamps 0.
                // ponytail: AI-fill is on, which is the room default and the only local
                // room there is. upgrade path: room config turns it off and a seat nobody
                // holds goes enabled = false instead (#7, #38).
                for (var seat = 0; seat < 4; seat++)
                    stamp_driver(seat, msg.held.indexOf(seat) >= 0 ? "local" : "ai");
                break;
            case "input":
                // Echoed to every other client and never to its sender (#12). There is no
                // other client, so this is the whole of it.
                current_tick = msg.t + 1;
                break;
            case "driver":
                stamp_driver(msg.seat, msg.driver);
                break;
            case "match_end":
                // Broadcast exactly as the host sent it, final board included (#22, #13).
                // A local room is never recorded (#16).
                to_client(msg);
                break;
        }
    };
}
