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
//
// Three things that are not settings live here for the same reason: the catch-up ceiling,
// the list of drivers and the guess for a missing frame are what the client and the relay
// have to agree on, and one definition is what stops them disagreeing (#82, #141).

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

// The two match-end knobs and their ceilings. Bumps stop at 99 because the in-game counter
// paints a two-digit number; minutes stop at 60 because an hour is already endless in
// practice. Zero is endless for both, which is the game's original behaviour and the
// default (#22, #39). The time limit is minutes here and ticks in the simulation, which is
// the only place it is ever compared against -- a clock is a thing four clients disagree
// about, and a tick count is not.
export var LIMITS = { bump_limit: 99, time_limit: 60 };

// The most ticks a client may be asked, or may ask a room, to catch up by. A minute of them
// costs a few hundred milliseconds to replay; more than that is a host that stopped
// snapshotting rather than a gap worth closing, and a client that replayed it would land
// minutes behind the room and consume every frame late (#51). A gap this size is a match not
// joined, not one joined short: the caller checks `gap()` and stays in the lobby (#40).
//
// Both halves of one ceiling: the client drops a frame stamped further ahead than this
// (#80), and the relay refuses to raise the room's clock to one in the first place (#82).
export var MAX_CATCH_UP = 3600;

// No keys held: what a seat plays when there is no frame to repeat (#6, #42).
var RELEASED = { left: false, right: false, up: false };
// How many ticks in a row a missing frame repeats the seat's last one before it becomes
// RELEASED again: a sixth of a second covers a stall on the wire (#141), and a seat that
// is really gone still stops pressing keys, as #6, #17 and #42 want.
export var PREDICT_TICKS = 10;

// The guess for a seat's missing frame, and the one guess there is: the relay puts it in on
// its deadline and a client steps it while the relay's frame is still in flight, so the two
// agree whenever the keys did not change inside the stall (#141). Shared for the reason the
// config is, since two copies of a guess drift into two guesses.
export function predict(last, missed) {
    return last && missed < PREDICT_TICKS ? last : RELEASED;
}

// Who may be driving a seat: the client holding it, the AI, or nobody at all when the room
// disabled it (#7, #37). An allowlist like `LEVELS` -- it is what stops a peer writing
// something the room has never heard of into the relay's driver table (#82).
export var DRIVERS = ["local", "ai", "off"];

export function default_config() {
    var config = { level: "default", ai_fill: true };
    FLAGS.forEach(function (flag) {
        config[flag] = false;
    });
    Object.keys(LIMITS).forEach(function (key) {
        config[key] = 0;
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
    // Whole numbers inside their ceiling, and anything else dropped rather than clamped: a
    // host typing 900 into a text box means nothing in particular, and a silently clamped
    // 99 is a setting nobody chose (#39). A number field hands over a string, so it is
    // parsed here rather than trusted.
    Object.keys(LIMITS).forEach(function (key) {
        if (!(key in wanted) || wanted[key] === "" || wanted[key] == null) return;
        var value = Number(wanted[key]);
        if (!isFinite(value) || value < 0 || value > LIMITS[key] || value % 1) return;
        if (value !== current[key]) diff[key] = value;
    });
    return diff;
}
