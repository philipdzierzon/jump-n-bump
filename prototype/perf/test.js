// PROTOTYPE check (issue #30): the ring is the candidate fix, so it must cap and it must
// keep the NEWEST gore, not the oldest. `node prototype/perf/test.js`
const assert = require("assert");

// mirrors Renderer.add_leftovers under ?maxleftovers=N
function ring_writer(cap) {
    const pobs = [];
    let written = 0, num = 0;
    return {
        add: v => {
            if (cap > 0) { pobs[written++ % cap] = v; num = Math.min(written, cap); }
            else { pobs[num] = v; num++; }
            return num;
        },
        drawn: () => pobs.slice(0, num)
    };
}

const uncapped = ring_writer(0);
for (let i = 0; i < 300; i++) uncapped.add(i);
assert.strictEqual(uncapped.drawn().length, 300, "today: unbounded, 300 drawImage calls per frame");

const capped = ring_writer(50);
for (let i = 0; i < 300; i++) assert.ok(capped.add(i) <= 50);
const drawn = capped.drawn();
assert.strictEqual(drawn.length, 50);
assert.deepStrictEqual(drawn.slice().sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => 250 + i),
    "keeps the last 50 splats; the oldest are the ones that vanish");

console.log("ok");
