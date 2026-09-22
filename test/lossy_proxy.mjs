// A TCP proxy that makes a loopback link behave like a lossy one, as far as the game can tell
// (#136 §3). It sits above TCP, so it cannot lose a byte. What it reproduces is what a real
// kernel does with a loss, measured in docs/research/loss-and-jitter.md §4: the stream stalls
// for about one repair round, and then everything behind the gap arrives at once.
//
// ponytail: one read is treated as one packet. That holds for 60 Hz WebSocket frames, and it
// undercounts loss on a large HTTP response, which nothing here measures. upgrade path: split
// reads at 1448 bytes if page loads ever need to see loss.
import net from "node:net";
import { performance } from "node:perf_hooks";

import { make_rnd } from "../src/game/rnd.js";

const TICK = 1000 / 60;

// `one_way` is the configured delay in ms, each way. `loss` is the chance per packet (0.01 is
// 1 %). Each direction of each connection draws from its own stream, derived from `seed`, so
// the same seed makes the same decisions whichever direction happens to read first.
export async function lossy_proxy(target_port, { one_way = 0, loss = 0, seed = 1 } = {}) {
    const rtt = 2 * one_way;
    // At a short RTT, the next frame, a tick later, is what exposes the hole (§1).
    const repair = Math.max(1.33 * rtt, rtt + TICK);
    const pipes = new Set();
    const sockets = new Set();
    let streams = 0;
    let losses = 0;

    function pipe(from, to, direction) {
        const rnd = make_rnd(seed * 7919 + ++streams);
        const chance = (p) => rnd(1000000) < p * 1000000;
        const between = (lo, hi) => lo + (rnd(1001) / 1000) * (hi - lo);
        const queue = [];
        const aftershocks = [];
        let gate = 0;
        let last = 0;
        let timer = null;
        const self = {
            direction,
            // Everything read from now on is held until `ms` past its normal arrival. The CI
            // regression uses this directly, so its stall does not depend on a seed.
            stall(ms) {
                gate = Math.max(gate, performance.now() + one_way + ms);
            },
        };
        const flush = () => {
            timer = null;
            const now = performance.now();
            while (queue.length && queue[0][0] <= now) {
                const [, chunk] = queue.shift();
                if (chunk === null) to.end();
                else to.write(chunk);
            }
            if (queue.length) timer = setTimeout(flush, queue[0][0] - now);
        };
        const push = (chunk) => {
            const at = Math.max(performance.now() + one_way, gate, last);
            queue.push([(last = at), chunk]);
            if (!timer) flush();
        };
        from.on("data", (chunk) => {
            const now = performance.now();
            for (let i = aftershocks.length - 1; i >= 0; i--)
                if (aftershocks[i].at <= now) self.stall(aftershocks.splice(i, 1)[0].ms);
            if (loss && chance(loss)) {
                losses++;
                // A second loss, on the retransmit, needs a second repair round. One repair in
                // ten runs long, which is the spread between the kernel's p90 and p99 (§1).
                self.stall(
                    chance(loss)
                        ? between(3, 4.2) * rtt
                        : chance(0.1)
                          ? between(1.5, 2) * rtt
                          : repair * between(1, 1.15),
                );
                // The congestion window, cut after the loss, holds 1-3 later reads back a
                // little, within one RTT of the repair.
                for (let n = 1 + rnd(3); n--;)
                    aftershocks.push({
                        at: gate - one_way + between(0, rtt),
                        ms: between(0.2, 0.35) * rtt,
                    });
            }
            push(chunk);
        });
        from.on("end", () => push(null));
        return self;
    }

    const server = net.createServer((near) => {
        const far = net.connect(target_port, "127.0.0.1");
        for (const socket of [near, far]) sockets.add(socket.setNoDelay(true));
        const up = pipe(near, far, "up");
        const down = pipe(far, near, "down");
        pipes.add(up).add(down);
        const done = () => {
            for (const socket of [near, far]) sockets.delete(socket.destroy());
            pipes.delete(up);
            pipes.delete(down);
        };
        for (const socket of [near, far]) socket.on("close", done).on("error", done);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    return {
        port: server.address().port,
        // `up` is client to relay, `down` is relay to client.
        stall(direction, ms) {
            for (const p of pipes) if (p.direction === direction) p.stall(ms);
        },
        losses: () => losses,
        close: () =>
            new Promise((resolve) => {
                server.close(resolve);
                for (const socket of sockets) socket.destroy();
            }),
    };
}
