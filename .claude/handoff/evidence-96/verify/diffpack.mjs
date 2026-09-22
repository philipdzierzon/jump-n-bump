import { readFileSync } from "node:fs";
import { decode_snapshot, checksum_snapshot } from "/tmp/check96/clean/src/game/snapshot.js";
const log = readFileSync(process.argv[2], "utf8");
const grab = (who) => {
    const m = log.match(new RegExp("DEBUG pack (\\d+) " + who + "=([A-Za-z0-9+/=]+)"));
    return m && { t: +m[1], b64: m[2] };
};
globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
const h = grab("host"), g = grab("guest");
const hi = decode_snapshot(h.b64), gi = decode_snapshot(g.b64);
const lh = +log.match(/DEBUG level_hash host=(-?\d+)/)[1];
console.log("tick", h.t, "ints", hi.length);
console.log("host hash", checksum_snapshot(hi, lh), "guest hash", checksum_snapshot(gi, lh));
const P = 4, PK = ["action_left","action_right","action_up","enabled","dead_flag","bumps","direction","jump_ready","jump_abort","in_water","anim","frame","frame_tick"];
const PVK = ["pos","velocity"], OK = ["used","type","anim","frame","ticks","image"], OVK = ["pos","velocity","acceleration"];
const PLAYER_INTS = PK.length + 2*PVK.length + P; // 21
function name(i) {
    if (i === 0) return "tick";
    if (i === 1) return "rnd.state";
    const p0 = 2, pend = p0 + P*PLAYER_INTS;
    if (i < pend) {
        const k = i - p0, pi = Math.floor(k/PLAYER_INTS), o = k % PLAYER_INTS;
        if (o < PK.length) return `player[${pi}].${PK[o]}`;
        let r = o - PK.length;
        if (r < 2) return `player[${pi}].x.${PVK[r]}`;
        r -= 2;
        if (r < 2) return `player[${pi}].y.${PVK[r]}`;
        r -= 2;
        return `player[${pi}].bumped[${r}]`;
    }
    const k = i - pend, oi = Math.floor(k/12), o = k % 12;
    if (o < 6) return `object[${oi}].${OK[o]}`;
    let r = o - 6;
    if (r < 3) return `object[${oi}].x.${OVK[r]}`;
    r -= 3;
    return `object[${oi}].y.${OVK[r]}`;
}
let n = 0;
for (let i = 0; i < hi.length; i++)
    if (hi[i] !== gi[i]) { console.log(`DIFF [${i}] ${name(i)}: host=${hi[i]} guest=${gi[i]}`); n++; }
console.log("total differing ints:", n);
// how many object slots are used on each side
const pend = 2 + P*PLAYER_INTS;
const used = (a) => { let c=0; for (let o=0;o<200;o++) if (a[pend+o*12]) c++; return c; };
console.log("objects used host=", used(hi), "guest=", used(gi));
