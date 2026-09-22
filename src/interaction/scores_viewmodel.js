// The bunnies, in seat order. A seat with a participant on it is shown under that
// participant's name instead (#13).
export var BUNNY_NAMES = ["Dott", "Jiffy", "Fizz", "Miji"];
// Each bunny's own coat, sampled from `game/sprites/rabbit.png`. The column heads are
// swatches rather than a second copy of the names, which is what lets six columns fit a
// 390px phone with nothing truncated -- the names are on the rows (#39).
export var BUNNY_COLOURS = ["#dbdbdb", "#dfbf8b", "#8f8f8f", "#b78f77"];

// A seat's bumps: the row it killed along, which is the row total the board shows.
function row_sum(values) {
    if (values == undefined || values.length == 0) return 0;
    return values.reduce(function (prev, cur) {
        return prev + cur;
    });
}

export function Scores_ViewModel(raw_scores, names) {
    "use strict";
    var row_headings = names.concat(["Total deaths"]);
    // A cell is a swatch when it has a colour and its label alone when it has not; the
    // label is on both, since a swatch with no name on it is a colour and nothing else.
    this.player_row = [{ label: "", colour: null }]
        .concat(
            names.map(function (name, seat) {
                return { label: name, colour: BUNNY_COLOURS[seat] };
            }),
        )
        .concat([{ label: "Total kills", colour: null }]);
    var scores = raw_scores.map(with_row_sum);
    scores = with_totals_row(scores);
    this.score_rows = row_headings.map(get_row_contents);

    // One total per column of the rows above it, which is one more than there are rows:
    // the per-row "Total kills" column needs a total too, and without it the table's
    // bottom-right cell simply is not there to draw a border on.
    function with_totals_row(score_grid) {
        if (score_grid == undefined || score_grid.length == 0) return 0;
        var totals_row = [];
        for (var index = 0; index < score_grid[0].length; index++) {
            totals_row.push(column_sum(score_grid, index));
        }
        return score_grid.concat([totals_row]);
    }
    function column_sum(grid, col_index) {
        return grid.reduce(function (prev, cur) {
            return prev + cur[col_index];
        }, 0);
    }
    function with_row_sum(raw_score_row) {
        return raw_score_row.concat([row_sum(raw_score_row)]);
    }
    function get_row_contents(row_heading, index) {
        var score_row = scores[index];
        return [row_heading].concat(score_row);
    }
}

// The one banner line above the board: who won, or who ended it. A draw is joint winners
// and never a sudden-death round, which would be the third phase the room does not have
// (#37, #39). The matrix is the board's own, so the line is derived rather than announced.
export function match_result(matrix, names, reason) {
    "use strict";
    if (reason === "lobby") return "The host ended the match.";
    if (reason === "host_left") return "The host left.";
    // The one match-end only the client it happened to hears about: the relay repaired this
    // client's simulation as often as it is willing to and it kept falling out of step, so
    // the match went on without it. It is still in the room and plays the next one, which is
    // the half of it worth saying out loud (#41).
    //
    // And a way out, because one cause of this does not clear by itself: a level fetched
    // into a stale cache is held as a resolved promise for the tab's lifetime, so the next
    // match rebuilds from the same wrong ban map and ejects this client again, forever
    // (#95). A reload is the only thing that refetches it -- the same instruction an
    // unavailable level already gives.
    if (reason === "desync")
        return (
            "Your game fell out of step with the room and could not catch up, so the " +
            "match carried on without you. You are still in the room and can play the next one. " +
            "If it keeps happening, reload the page."
        );
    if (reason !== "bumps" && reason !== "time") return "";
    var bumps = (matrix || []).map(row_sum);
    var most = Math.max.apply(null, bumps.concat([0]));
    if (!most) return "Nobody scored.";
    var winners = names.filter(function (_, seat) {
        return bumps[seat] === most;
    });
    var joined = winners.length > 1 ? winners.slice(0, -1).join(", ") + " and " : "";
    joined += winners[winners.length - 1];
    return winners.length > 1
        ? joined + " draw at " + most + " bumps."
        : joined + " wins with " + most + (most === 1 ? " bump." : " bumps.");
}
