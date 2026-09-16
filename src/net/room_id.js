// Room ids: 5 characters, uppercase A-Z minus I and O, so a room can be read aloud over
// voice chat without spelling it (#8). Shared by the client and the relay, because the
// client uppercases what it shows and the relay re-uppercases and validates what it is
// sent -- one alphabet, one regex, one place.
//
// Not a secret. It identifies a room; it does not protect one.
var ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
var VALID = /^[A-HJ-NP-Z]{5}$/;

// Null for anything that is not a room id, so callers get one guard instead of two.
export function normalise_room_id(id) {
    id = String(id == null ? "" : id).toUpperCase();
    return VALID.test(id) ? id : null;
}

// `taken` is the rooms map. 24^5 is 8M ids against a handful of live rooms, so a
// collision retry is a formality rather than a loop worth bounding.
export function generate_room_id(taken) {
    for (;;) {
        var id = "";
        for (var i = 0; i < 5; i++) id += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
        if (!taken[id]) return id;
    }
}
