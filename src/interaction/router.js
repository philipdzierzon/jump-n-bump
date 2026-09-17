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
