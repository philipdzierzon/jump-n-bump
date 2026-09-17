// The two pure pieces of the kiosk flow (#35): which screen a hash names, and which
// control scheme a jump key belongs to. Everything else in the flow is Knockout bindings
// against a real DOM, which this repo verifies by opening the page.
import assert from "node:assert/strict";

import { screen_of } from "../src/interaction/router.js";
import { jump_scheme } from "../src/game/keyboard.js";

assert.deepEqual(screen_of(""), { screen: "landing", room_id: null });
assert.deepEqual(screen_of("#"), { screen: "landing", room_id: null });
assert.deepEqual(screen_of("#nonsense"), { screen: "landing", room_id: null });
assert.deepEqual(screen_of("#create"), { screen: "create", room_id: null });
assert.deepEqual(screen_of("#room"), { screen: "room", room_id: null });
assert.deepEqual(screen_of("#landing"), { screen: "landing", room_id: null });

// The bare fragment is the only link the app generates, and it is the join route (#8).
assert.deepEqual(screen_of("#QMFTX"), { screen: "join", room_id: "QMFTX" });
assert.deepEqual(screen_of("#qmftx"), { screen: "join", room_id: "QMFTX" });
// I and O are not in the alphabet, so this is not a room id and not a screen either.
assert.deepEqual(screen_of("#QMFTI"), { screen: "landing", room_id: null });
// `names` uppercases into a perfectly legal room id: the screen wins.
assert.deepEqual(screen_of("#names"), { screen: "names", room_id: null });
assert.deepEqual(screen_of("#NAMES"), { screen: "join", room_id: "NAMES" });

// Jump keys, in scheme order: up arrow, W, numpad 8, I.
assert.equal(jump_scheme(38), 0);
assert.equal(jump_scheme(87), 1);
assert.equal(jump_scheme(104), 2);
assert.equal(jump_scheme(73), 3);
// Left, right and every other key add nobody.
assert.equal(jump_scheme(37), -1);
assert.equal(jump_scheme(65), -1);

console.log("router: ok");
