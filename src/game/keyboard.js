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

    // One input frame, the wire format: 3 bits, unconditionally, whether or not anything
    // changed. Null for a scheme this client does not have -- the one guard, so callers
    // can hand it an unbound seat's index without checking first.
    this.input_frame = function (scheme) {
        var keys = CONTROL_SCHEMES[scheme];
        if (!keys) return null;
        return {
            left: !!keys_pressed[keys[0]],
            right: !!keys_pressed[keys[1]],
            up: !!keys_pressed[keys[2]],
        };
    };

    this.onKeyDown = function (evt) {
        keys_pressed[evt.keyCode] = true;
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
    // player pressing them.
    this.release_all = function () {
        keys_pressed = {};
    };
}

// The jump key of a scheme, which is how a couch player is added on the names screen
// (#35). -1 for a key that is nobody's jump.
export function jump_scheme(keyCode) {
    return CONTROL_SCHEMES.findIndex(function (keys) {
        return keys[2] === keyCode;
    });
}
