// The room's config (#38): the level, the six flags that used to be reversed-string cheats
// in the C original and query params here, and AI-fill. Shared by the client and the relay,
// like `room_id.js`: the client renders it and the relay validates it, and one list of keys
// in one place is what stops the two disagreeing.
//
// It is the *only* configuration path. A query param that set `no_gore` for one client and
// not another desynced the RNG stream on the first kill (#5), which is why the relay hands
// the whole object down on `start` and never reads a client's own (#12).
//
// The password is not in here. It is write-only, never in a room view and never on a link,
// so it is the one setting that has no place in an object the relay broadcasts (#8).

// The levels shipped in `game/levels/`, each one `<name>/<name>.dat` beside the page --
// except `default`, which is the built-in map and its two <img> tags. A name is resolved
// by fetching, so this list is also the allowlist: it is what stops a host staging a path
// of its own for every other client to fetch.
export var LEVELS = [
    "default",
    "caves",
    "cocaine",
    "green",
    "jump2",
    "kingofthehill",
    "mario",
    "sgeneral",
    "spring",
    "swamp",
    "thomas",
    "topsy",
    "waterfall",
];

// The six. `ai_fill` is a room rule rather than a simulation setting, so it rides in the
// same object but is not one of these.
export var FLAGS = [
    "pogostick",
    "jetpack",
    "bunnies_in_space",
    "flies_enabled",
    "blood_is_thicker_than_water",
    "no_gore",
];

export function default_config() {
    var config = { level: "default", ai_fill: true };
    FLAGS.forEach(function (flag) {
        config[flag] = false;
    });
    return config;
}

// Host input, so every key is checked here and anything else is dropped. Returns only the
// keys that really differ from `current`, which is what the staged banner names and what
// decides whether a change happened at all: staging a value it already has must not clear
// everyone's ready (#38, #10).
export function config_diff(current, wanted) {
    var diff = {};
    if (!wanted || typeof wanted !== "object") return diff;
    if (LEVELS.indexOf(wanted.level) >= 0 && wanted.level !== current.level)
        diff.level = wanted.level;
    FLAGS.concat("ai_fill").forEach(function (key) {
        if (key in wanted && !!wanted[key] !== current[key]) diff[key] = !!wanted[key];
    });
    return diff;
}
