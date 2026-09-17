// Seeded replacement for Math.random. xorshift32: int32 ops only, so every engine
// produces the same stream from the same seed, which is what lockstep rests on (#5).
export function make_rnd(seed) {
    "use strict";
    var s = seed | 0 || 1;
    function rnd(max_value) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        s |= 0;
        // ponytail: `%` biases the top of the range by at most 1 part in 2^32 per draw.
        // Upgrade path: rejection-sample the remainder if a draw ever needs to be fair
        // rather than merely identical on every client, which is all lockstep asks.
        return (s >>> 0) % max_value;
    }
    // The whole stream is one int32, which is what lets a snapshot carry it: a client
    // resumed from the host's state draws the numbers the host is about to draw (#40).
    // Called with a value it sets one, called with none it reads one.
    rnd.state = function (value) {
        if (arguments.length) s = value | 0 || 1;
        return s;
    };
    return rnd;
}
