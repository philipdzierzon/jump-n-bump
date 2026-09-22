// The room flow is a sequence of screens and the hash says which one you are on, so Back
// inside the flow is the browser's Back and nothing has to reimplement history (#35).
//
// Screens are named in lowercase; a bare `/#QMFTX` is the only link this app ever
// generates, and it is an alias for the join route carrying its room id (#8). Names are
// matched before ids, because `names` uppercases into a perfectly legal room id.
import { normalise_room_id } from "../net/room_id.js";

var SCREENS = ["landing", "create", "join", "password", "names", "room", "play", "browse"];

export function screen_of(hash) {
    var raw = String(hash == null ? "" : hash).replace(/^#/, "");
    if (SCREENS.indexOf(raw) >= 0) return { screen: raw, room_id: null };
    var id = normalise_room_id(raw);
    if (id) return { screen: "join", room_id: id };
    return { screen: "landing", room_id: null };
}

// The flow's own sentences, beside the routes rather than in the view model: `viewmodels.js`
// applies its bindings to a DOM at module scope, so a node test can never import it (#88).
export var FLOW_TEXT = {
    // One answer for a wrong password and for a room that is not there -- telling them
    // apart is what would make an unlisted room's id worth guessing at (#8). True of the
    // two places it still lands: a wrong password just typed, and a browsed row the list
    // said was open but no longer is.
    unavailable: "That room is not available. Check the code, and the password if it has one.",
    // Set before any password has ever been typed, so it cannot claim the room is gone:
    // the commonest reason to land here is a locked room that opens on the next screen.
    // Still one answer for both, which is all #8 asks (#8, #88).
    not_accepted: "That code was not accepted on its own. Enter the password, or check the code.",
    // The socket went and there was no room behind it to reconnect into.
    dropped: "The connection dropped.",
    // The reservation window ran out with the retries still going: the seats are anybody's
    // now, which is the half worth saying (#42).
    gave_up: "The connection did not come back in time, so your seats were given up.",
    // A reload into a room that refused it. One relay code covers both a missing room and a
    // wrong password (#8), so this names both and picks neither -- "need", not "now": a
    // password already typed once was not gained while this client was away.
    room_gone: "That room would not let you back in. It may have ended, or it may need a password.",
    // Countdown zero frees the seats of anyone who never readied, back to the names screen
    // to ask for some again (#17, #37).
    vacated:
        "The countdown ran out before you were ready, so your seats went back to the room. " +
        "Take them again if they are still free.",
    // Ready clears for the whole room when a match ends, same as a staged config change --
    // and cleared checkboxes on their own read as a bug (#10, #38). The curly apostrophe
    // matches the banner's "Everyone’s" (jnb.html) -- the only other user-facing text
    // this line shares a screen with.
    ready_cleared:
        "The match ended and everyone’s ready was cleared. Press Ready for the next one.",
    // A failed fetch and an empty list are the same empty array otherwise (#88).
    rooms_failed: "The room list would not load. Refresh to try again.",
};

// Who the lobby is waiting on. The relay names the seat; a client's own `host` flag names
// nobody, so with no name this is the sentence the lobby has always said (#88).
export function waiting_for(name) {
    return name ? "Waiting for " + name + " to start." : "Waiting for the host to start.";
}
