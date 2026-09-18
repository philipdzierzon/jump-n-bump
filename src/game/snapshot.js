import { env } from "./env.js";
import { player } from "./game.js";

// The whole simulation, packed into one Int32Array (#40). Everything a tick reads and
// writes is in here -- the players, the objects and the RNG's own state -- and nothing
// else is: the level, the settings and the driver table are the room's, and arrive with
// the `start` this rides on.
//
// It is the simulation's serializer, so it lives beside the simulation and touches no DOM:
// a snapshot is taken between ticks on the host and replayed into a sim that has none of
// the host's browser around it. #41's checksum is FNV-1a over this same output rather than
// a field list of its own, which is why the field order below is the format.
//
// Booleans pack as 0/1 and unpack as numbers. Every reader of them is a truth test, and a
// number is what both sides pack from, so a client that has been resynced and one that
// never was still serialize to the same bytes.

// Flat per-player fields. `x`/`y` are the only nested ones, packed after these.
var PLAYER_KEYS = [
    "action_left",
    "action_right",
    "action_up",
    "enabled",
    "dead_flag",
    "bumps",
    "direction",
    "jump_ready",
    "jump_abort",
    "in_water",
    "anim",
    "frame",
    "frame_tick",
];
var PLAYER_VECTOR_KEYS = ["pos", "velocity"];
var OBJECT_KEYS = ["used", "type", "anim", "frame", "ticks", "image"];
// Objects accelerate and players do not, which is the one difference between the two.
var OBJECT_VECTOR_KEYS = ["pos", "velocity", "acceleration"];

// An unused object slot has nothing but `used: false` on it, and a fixed-size record is
// what makes the snapshot a fixed size.
var EMPTY = {};

var PLAYER_INTS =
    PLAYER_KEYS.length + 2 * PLAYER_VECTOR_KEYS.length + env.JNB_MAX_PLAYERS; /* bumped */
var OBJECT_INTS = OBJECT_KEYS.length + 2 * OBJECT_VECTOR_KEYS.length;

// Tick and RNG state, then the players, then every object slot. ~10 KB, which is what the
// wire was sized for (#12, #19).
export var SNAPSHOT_INTS = 2 + env.JNB_MAX_PLAYERS * PLAYER_INTS + env.MAX_OBJECTS * OBJECT_INTS;

function write(out, at, holder, keys) {
    for (var i = 0; i < keys.length; i++) out[at++] = holder[keys[i]] | 0;
    return at;
}

function read(ints, at, holder, keys) {
    for (var i = 0; i < keys.length; i++) holder[keys[i]] = ints[at++];
    return at;
}

export function pack_snapshot(rnd, objects, tick) {
    var out = new Int32Array(SNAPSHOT_INTS);
    var at = 0;
    out[at++] = tick;
    out[at++] = rnd.state();
    for (var i = 0; i < env.JNB_MAX_PLAYERS; i++) {
        var p = player[i];
        at = write(out, at, p, PLAYER_KEYS);
        at = write(out, at, p.x, PLAYER_VECTOR_KEYS);
        at = write(out, at, p.y, PLAYER_VECTOR_KEYS);
        for (var j = 0; j < env.JNB_MAX_PLAYERS; j++) out[at++] = p.bumped[j] | 0;
    }
    for (var c1 = 0; c1 < env.MAX_OBJECTS; c1++) {
        var obj = objects.objects[c1];
        at = write(out, at, obj, OBJECT_KEYS);
        at = write(out, at, obj.x || EMPTY, OBJECT_VECTOR_KEYS);
        at = write(out, at, obj.y || EMPTY, OBJECT_VECTOR_KEYS);
    }
    return out;
}

// Replaces this client's state with the packed one and hands back the tick it was taken
// on. The `player` array is the one the running Game built, so this writes into it rather
// than replacing it: importers read `player[i]` at call time and a new array would leave
// the sim steering the old one.
export function unpack_snapshot(ints, rnd, objects) {
    var at = 0;
    var tick = ints[at++];
    rnd.state(ints[at++]);
    for (var i = 0; i < env.JNB_MAX_PLAYERS; i++) {
        var p = player[i];
        at = read(ints, at, p, PLAYER_KEYS);
        at = read(ints, at, p.x, PLAYER_VECTOR_KEYS);
        at = read(ints, at, p.y, PLAYER_VECTOR_KEYS);
        for (var j = 0; j < env.JNB_MAX_PLAYERS; j++) p.bumped[j] = ints[at++];
    }
    for (var c1 = 0; c1 < env.MAX_OBJECTS; c1++) {
        var obj = objects.objects[c1];
        obj.x = obj.x || {};
        obj.y = obj.y || {};
        at = read(ints, at, obj, OBJECT_KEYS);
        at = read(ints, at, obj.x, OBJECT_VECTOR_KEYS);
        at = read(ints, at, obj.y, OBJECT_VECTOR_KEYS);
    }
    return tick;
}

// The plaintext half of the snapshot message: who bumped whom, which is the board (#13).
// Flat, because the relay reads it without decoding anything and 16 numbers is the whole
// of it.
export function bump_matrix() {
    var matrix = [];
    for (var i = 0; i < env.JNB_MAX_PLAYERS; i++)
        for (var j = 0; j < env.JNB_MAX_PLAYERS; j++) matrix.push(player[i].bumped[j] | 0);
    return matrix;
}

// base64, because the body travels inside the same JSON envelope every other message uses
// and the relay never decodes it -- it is a string it stores and hands on (#12).
//
// ponytail: little-endian, which is every platform a browser runs on. Upgrade path: a
// DataView with an explicit byte order if that ever stops being true.
export function encode_snapshot(ints) {
    var bytes = new Uint8Array(ints.buffer);
    var chars = "";
    for (var i = 0; i < bytes.length; i++) chars += String.fromCharCode(bytes[i]);
    return btoa(chars);
}

// Another client's bytes, so a body that is not one is refused rather than unpacked into
// the simulation: null means this client has no snapshot to resume from.
export function decode_snapshot(body) {
    if (typeof body !== "string") return null;
    var chars;
    try {
        chars = atob(body);
    } catch (e) {
        return null;
    }
    if (chars.length !== SNAPSHOT_INTS * 4) return null;
    var bytes = new Uint8Array(chars.length);
    for (var i = 0; i < chars.length; i++) bytes[i] = chars.charCodeAt(i);
    return new Int32Array(bytes.buffer);
}
