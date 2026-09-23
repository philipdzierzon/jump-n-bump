// Calibrates the stall model for the loss/jitter proxy (#136 §3): what a real kernel TCP does to
// a 60 Hz stream of small frames when netem delays, jitters and drops its packets.
//
// Runs inside the container this directory's Dockerfile builds, with NET_ADMIN, and shapes the
// container's own loopback -- so both ends share one clock and every frame's one-way latency is
// exact. Writes calibration.json (raw) and calibration.md (tables) to /out.
//
// ponytail: plain TCP with fixed 72-byte frames, not WebSocket. A WS header is 2-6 more bytes and
// TCP neither knows nor cares; both `ws` and Chrome turn Nagle off, as this does. upgrade path:
// run the real relay and two browsers under the same netem if these numbers look too clean.

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const TICK = 1000 / 60;
const FRAME = 72;
const SECONDS = Number(process.env.CELL_SECONDS) || 60;
const OUT = process.env.OUT || "/out";
const ONE_WAY = [10, 20, 50]; // ms per direction; netem on lo delays data and ACKs alike, so RTT = 2x
const JITTER = [0, 5];
const LOSS = [0, 0.5, 1, 3]; // percent, applied to every packet on lo, ACKs included
const COUNTERS = [
    "RetransSegs",
    "TCPFastRetrans",
    "TCPLossProbes",
    "TCPLossProbeRecovery",
    "TCPTimeouts",
    "TCPSlowStartRetrans",
    "TCPSpuriousRTOs",
    "TCPSACKReorder",
    "TCPRenoRecovery",
    "TCPSackRecovery",
];

const tc = (...args) => execFileSync("tc", args, { stdio: "pipe" }).toString();

function counters() {
    const all = {};
    for (const file of ["/proc/net/snmp", "/proc/net/netstat"]) {
        const lines = fs.readFileSync(file, "utf8").trim().split("\n");
        for (let i = 0; i < lines.length; i += 2) {
            const keys = lines[i].split(/\s+/).slice(1);
            const values = lines[i + 1].split(/\s+/).slice(1);
            keys.forEach((k, j) => (all[k] = Number(values[j])));
        }
    }
    return Object.fromEntries(COUNTERS.map((k) => [k, all[k] ?? null]));
}

const sysctl = (name) => {
    try {
        return fs.readFileSync("/proc/sys/" + name.replaceAll(".", "/"), "utf8").trim();
    } catch {
        return null;
    }
};

// One direction of the stream: sends a frame per tick, and on the far end records each frame's
// one-way latency by sequence number.
function stream(tx, rx, arrivals) {
    let seq = 0;
    let next = performance.now();
    let timer;
    const send = () => {
        const buf = Buffer.alloc(FRAME);
        buf.writeUInt32LE(seq++, 0);
        buf.writeDoubleLE(performance.now(), 4);
        tx.write(buf);
        next += TICK;
        timer = setTimeout(send, Math.max(0, next - performance.now()));
    };
    let pending = Buffer.alloc(0);
    rx.on("data", (chunk) => {
        const now = performance.now();
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= FRAME) {
            arrivals[pending.readUInt32LE(0)] = now - pending.readDoubleLE(4);
            pending = pending.subarray(FRAME);
        }
    });
    send();
    return { stop: () => (clearTimeout(timer), seq) };
}

function pct(sorted, p) {
    return sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
        : null;
}

function summarise(arrivals, sent, one_way) {
    const excess = [];
    const stalls = [];
    let run = null;
    for (let s = 0; s < sent; s++) {
        const e = arrivals[s] === undefined ? Infinity : arrivals[s] - one_way;
        excess.push(e);
        // A stall is a maximal run of consecutive frames each more than a tick late: one event as
        // the game would feel it, however many packets TCP lost inside it.
        if (e > TICK) {
            if (!run) stalls.push((run = { at_frame: s, frames: 0, peak_ms: 0 }));
            run.frames++;
            run.peak_ms = Math.max(run.peak_ms, e);
        } else run = null;
    }
    const sorted = excess.filter(Number.isFinite).sort((a, b) => a - b);
    const ticks_late = { 0: 0, 1: 0, 2: 0, 3: 0, "4-7": 0, "8-15": 0, "16-29": 0, "30+": 0 };
    for (const e of sorted) {
        const t = Math.max(0, Math.floor(e / TICK));
        ticks_late[t < 4 ? t : t < 8 ? "4-7" : t < 16 ? "8-15" : t < 30 ? "16-29" : "30+"]++;
    }
    const r = (x) => (x === null ? null : Math.round(x * 10) / 10);
    return {
        sent,
        undelivered: sent - sorted.length,
        excess_ms: {
            p50: r(pct(sorted, 0.5)),
            p90: r(pct(sorted, 0.9)),
            p99: r(pct(sorted, 0.99)),
            p999: r(pct(sorted, 0.999)),
            max: r(sorted.at(-1) ?? null),
        },
        ticks_late,
        stalls_per_minute: r((stalls.length * 60) / SECONDS),
        stalls: stalls.map((s) => ({ ...s, peak_ms: r(s.peak_ms) })),
    };
}

async function cell(one_way, jitter, loss) {
    const shape = ["delay", `${one_way}ms`];
    if (jitter) shape.push(`${jitter}ms`);
    if (loss) shape.push("loss", `${loss}%`);
    tc("qdisc", "replace", "dev", "lo", "root", "netem", ...shape);

    const server = net.createServer();
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    const accepted = new Promise((ok) => server.once("connection", ok));
    const client = net.connect(server.address().port, "127.0.0.1");
    const relay = await accepted;
    for (const s of [client, relay]) s.setNoDelay(true);

    const before = counters();
    const up = {}; // client -> relay
    const down = {}; // relay -> client
    const a = stream(client, relay, up);
    const b = stream(relay, client, down);
    await new Promise((ok) => setTimeout(ok, SECONDS * 1000));
    const sent_up = a.stop();
    const sent_down = b.stop();
    // Drain: a backed-off RTO can hold the tail for seconds.
    const deadline = performance.now() + 15000;
    while (
        performance.now() < deadline &&
        (Object.keys(up).length < sent_up || Object.keys(down).length < sent_down)
    )
        await new Promise((ok) => setTimeout(ok, 50));
    const after = counters();
    client.destroy();
    relay.destroy();
    server.close();

    const tcp = Object.fromEntries(
        COUNTERS.map((k) => [k, before[k] === null ? null : after[k] - before[k]]),
    );
    return {
        one_way,
        jitter,
        loss,
        netem: shape.join(" "),
        tcp,
        up: summarise(up, sent_up, one_way),
        down: summarise(down, sent_down, one_way),
    };
}

function markdown(report) {
    const rows = report.cells.flatMap((c) =>
        ["up", "down"].map((dir) => {
            const d = c[dir];
            const t = d.ticks_late;
            return (
                `| ${c.one_way} | ${c.jitter} | ${c.loss} | ${dir} | ${d.excess_ms.p50} | ` +
                `${d.excess_ms.p99} | ${d.excess_ms.p999} | ${d.excess_ms.max} | ` +
                `${t[1] + t[2] + t[3]} | ${t["4-7"]} | ${t["8-15"]} | ${t["16-29"]} | ${t["30+"]} | ` +
                `${d.undelivered} | ${d.stalls_per_minute} | ` +
                `${Math.max(0, ...d.stalls.map((s) => s.frames))} |`
            );
        }),
    );
    const tcp = report.cells.map(
        (c) =>
            `| ${c.one_way} | ${c.jitter} | ${c.loss} | ` +
            COUNTERS.map((k) => c.tcp[k] ?? "–").join(" | ") +
            " |",
    );
    return [
        "# Loss calibration",
        "",
        "```json",
        JSON.stringify(report.env, null, 2),
        "```",
        "",
        `${SECONDS} s per cell. Excess is one-way latency over the configured delay, in ms. ` +
            "Ticks late counts frames, a stall is a run of consecutive frames each over a tick late.",
        "",
        "| one-way ms | jitter ms | loss % | dir | p50 | p99 | p99.9 | max | 1-3 ticks | 4-7 | 8-15 | 16-29 | 30+ | lost | stalls/min | longest stall (frames) |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...rows,
        "",
        "## Which repair path TCP took (counter deltas per cell, both directions)",
        "",
        `| one-way ms | jitter ms | loss % | ${COUNTERS.join(" | ")} |`,
        `| --- | --- | --- | ${COUNTERS.map(() => "---").join(" | ")} |`,
        ...tcp,
        "",
    ].join("\n");
}

try {
    tc("qdisc", "replace", "dev", "lo", "root", "netem", "delay", "0ms");
} catch (e) {
    console.error(
        "tc could not attach netem to lo. Run with --cap-add NET_ADMIN; on a Linux host the " +
            "sch_netem module must be loadable (sudo modprobe sch_netem).\n" +
            e.stderr,
    );
    process.exit(1);
}

const report = {
    env: {
        started: new Date().toISOString(),
        kernel: os.release(),
        node: process.version,
        cpus: os.cpus().length,
        seconds_per_cell: SECONDS,
        tcp_congestion_control: sysctl("net.ipv4.tcp_congestion_control"),
        tcp_early_retrans: sysctl("net.ipv4.tcp_early_retrans"),
        tcp_recovery: sysctl("net.ipv4.tcp_recovery"),
        tcp_sack: sysctl("net.ipv4.tcp_sack"),
        tcp_thin_linear_timeouts: sysctl("net.ipv4.tcp_thin_linear_timeouts"),
    },
    cells: [],
};
// CELLS="50/0/1,50/0/3" runs only those one-way/jitter/loss cells, so the rare tail (a second
// loss doubling the RTO past AI_AFTER's 30 ticks) can get long runs without the whole matrix.
const cells = process.env.CELLS
    ? process.env.CELLS.split(",").map((c) => c.split("/").map(Number))
    : ONE_WAY.flatMap((o) => JITTER.flatMap((j) => LOSS.map((l) => [o, j, l])));
report.env.cells = cells.map((c) => c.join("/"));
for (const [one_way, jitter, loss] of cells) {
    console.log(
        `[${report.cells.length + 1}/${cells.length}] one-way ${one_way} ms, jitter ${jitter} ms, loss ${loss}%`,
    );
    report.cells.push(await cell(one_way, jitter, loss));
}
tc("qdisc", "del", "dev", "lo", "root");
report.env.finished = new Date().toISOString();

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/calibration.json`, JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(`${OUT}/calibration.md`, markdown(report));
console.log(`\nWrote ${OUT}/calibration.json and ${OUT}/calibration.md`);
