// Seeded replacement for Math.random. xorshift32: int32 ops only, so every engine
// produces the same stream from the same seed, which is what lockstep rests on (#5).
export function make_rnd(seed) {
    "use strict";
    var s = (seed | 0) || 1;
    return function (max_value) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        s |= 0;
        return (s >>> 0) % max_value;
    };
}
