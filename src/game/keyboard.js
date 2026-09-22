// The client-local input layer (#32). A control scheme belongs to this client, not to a
// seat: scheme 0 is the arrows, 1 is ADW, 2 the numpad, 3 JLI. The caller binds them to
// the seats it holds, in join order -- so a client holding global seats 2 and 3 drives
// them with schemes 0 and 1. Keycodes never reach a Player.
export const CONTROL_SCHEMES = [
    [37, 39, 38], // left, right, up
    [65, 68, 87], // A, D, W
    [100, 102, 104], // numpad 4, 6, 8
    [74, 76, 73], // J, L, I
];

export function Keyboard(key_function_mappings) {
    "use strict";
    var keys_pressed = {};
    // A key that went down since this scheme last handed a frame to a tick, whether or not
    // it is still down now. `Room.step` samples `keys_pressed` live once per tick, but a
    // catch-up batch is N synchronous ticks with no DOM event between them, so a tap that
    // begins and ends inside one leaves `keys_pressed` exactly as it found it -- the jump
    // that never happens during a stutter (#86). Cleared by the read, not by a clock.
    var tapped = {};

    // One input frame, the wire format: 3 bits, unconditionally, whether or not anything
    // changed. Null for a scheme this client does not have -- the one guard, so callers
    // can hand it an unbound seat's index without checking first.
    this.input_frame = function (scheme) {
        var keys = CONTROL_SCHEMES[scheme];
        if (!keys) return null;
        var frame = {
            left: !!(keys_pressed[keys[0]] || tapped[keys[0]]),
            right: !!(keys_pressed[keys[1]] || tapped[keys[1]]),
            up: !!(keys_pressed[keys[2]] || tapped[keys[2]]),
        };
        // Cleared per scheme, not wholesale: couch play is one client holding up to four
        // seats, so one tick makes up to four `input_frame` calls, and a latch the first
        // call wiped would eat the other seats' taps (#32).
        // ponytail: a latch, not a count -- two taps of the same key inside one batch
        // deliver as one. upgrade path: a per-key pending count, if that ever matters.
        keys.forEach(function (key) {
            tapped[key] = false;
        });
        return frame;
    };

    this.onKeyDown = function (evt) {
        keys_pressed[evt.keyCode] = true;
        tapped[evt.keyCode] = true;
    };

    this.onKeyUp = function (evt) {
        keys_pressed[evt.keyCode] = false;
        var action = key_function_mappings[String.fromCharCode(evt.keyCode)];
        if (action != null) action();
    };

    // Every key up at once, for a window that stopped being told about keyups at all: a tab
    // switched away from never delivers the keyup for the key that was held, and the map
    // would go on reporting it pressed for every tick of it (#85). Not a loop of `onKeyUp`,
    // which would fire M's and P's actions -- a flush is the keys being let go of, not the
    // player pressing them. The latch goes with it: a tap that landed a moment before the
    // blur must not steer the bunny for a tick after it (#86).
    this.release_all = function () {
        keys_pressed = {};
        tapped = {};
    };

    // The latch alone, for a boundary that must not deliver a stale tap but must not
    // strand a held key either: a match start or an unpause has no tick before it for a
    // pre-boundary tap to land on, but a held key is real input this tick and
    // `release_all` would wipe it with no keydown left to set it again (#86).
    this.clear_taps = function () {
        tapped = {};
    };
}

// The jump key of a scheme, which is how a couch player is added on the names screen
// (#35). -1 for a key that is nobody's jump.
export function jump_scheme(keyCode) {
    return CONTROL_SCHEMES.findIndex(function (keys) {
        return keys[2] === keyCode;
    });
}
