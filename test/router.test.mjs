// The pure pieces of the kiosk flow (#35): which screen a hash names, which control
// scheme a jump key belongs to, and the shape of the board both the lobby and the
// in-match overlay render. Everything else in the flow is Knockout bindings against a
// real DOM, which this repo verifies by opening the page.
import assert from "node:assert/strict";

import { screen_of } from "../src/interaction/router.js";
import { jump_scheme } from "../src/game/keyboard.js";
import {
    Scores_ViewModel,
    match_result,
    BUNNY_NAMES,
    BUNNY_COLOURS,
} from "../src/interaction/scores_viewmodel.js";

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

// The board is a table, so every row has to be as wide as its header: a row one cell short
// renders as a cell that is not there, with the borders missing around it (#13).
var board = new Scores_ViewModel(
    [
        [0, 1, 0, 0],
        [2, 0, 0, 1],
        [0, 0, 0, 0],
        [1, 0, 3, 0],
    ],
    BUNNY_NAMES,
);
assert.equal(board.player_row.length, 6, "a seat column each, plus the heading and the row total");
assert.deepEqual(
    board.player_row.map((cell) => cell.colour),
    [null, ...BUNNY_COLOURS, null],
    "the seat columns are headed by the bunny's own colour, the other two by their labels (#39)",
);
assert.deepEqual(
    board.player_row.map((cell) => cell.label),
    ["", ...BUNNY_NAMES, "Total kills"],
    "and every head carries its name, swatch or not: a colour on its own names nobody",
);
assert.deepEqual(
    board.score_rows.map((row) => row.length),
    [6, 6, 6, 6, 6],
    "and a row per seat plus the totals row, none of them short",
);
assert.deepEqual(
    board.score_rows[4],
    ["Total deaths", 3, 1, 3, 1, 8],
    "the totals row totals the row-totals column too: as many kills as there were deaths",
);

// The one line above the board. A draw is joint winners, because sudden death would be a
// phase the room does not have (#37, #39).
const won = [
    [0, 3, 0, 0],
    [1, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
];
// The one match end only the client it happened to hears about: the relay stopped repairing
// this client's simulation, so the match went on without it. It says both halves -- what
// went wrong, and that the room is still its to play the next match in (#41).
assert.match(
    match_result(null, BUNNY_NAMES, "desync"),
    /fell out of step .* can play the next one\.$/,
    "a client dropped for being out of step is told why, and that it is still in the room",
);
assert.equal(match_result(won, BUNNY_NAMES, "bumps"), "Dott wins with 3 bumps.");
assert.equal(match_result(won, BUNNY_NAMES, "time"), "Dott wins with 3 bumps.");
assert.equal(
    match_result(won, ["Alice", "Bob", "Fizz", "Miji"], "bumps"),
    "Alice wins with 3 bumps.",
    "under the name the seat is played by, which is what the board's rows are headed with",
);
const drawn = [
    [0, 2, 0, 0],
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [2, 0, 0, 0],
];
assert.equal(
    match_result(drawn, BUNNY_NAMES, "time"),
    "Dott, Jiffy and Miji draw at 2 bumps.",
    "a draw is joint winners, however many of them there are",
);
assert.equal(
    match_result(
        [
            [0, 1, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
        ],
        BUNNY_NAMES,
        "bumps",
    ),
    "Dott wins with 1 bump.",
);
assert.equal(
    match_result(
        [
            [0, 0],
            [0, 0],
        ],
        BUNNY_NAMES,
        "time",
    ),
    "Nobody scored.",
    "a time limit can run out on a match nobody scored in",
);
assert.equal(match_result(won, BUNNY_NAMES, "lobby"), "The host ended the match.");
assert.equal(match_result(won, BUNNY_NAMES, "host_left"), "The host left.");
assert.equal(match_result(null, BUNNY_NAMES, null), "", "and a match that never ran says nothing");

console.log("router: ok");
