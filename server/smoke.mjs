// Smoke test: proves static serving, /healthz and a room over the WebSocket.
// Usage: node smoke.mjs [base-url]   (default: boots a local server)
// The bare form needs `npm run build` first — it serves the built client.
import assert from "node:assert";
import { spawn } from "node:child_process";

const given = process.argv[2];
const base = given || "http://127.0.0.1:8099";
const child = given
    ? null
    : spawn("node", ["index.js"], {
          cwd: import.meta.dirname,
          env: { ...process.env, PORT: 8099, METRICS_PORT: 0 },
          stdio: "inherit",
      });

try {
    for (let i = 0; ; i++) {
        try {
            assert.equal(await (await fetch(`${base}/healthz`)).text(), "ok");
            break;
        } catch (e) {
            if (i > 50) throw e;
            await new Promise((r) => setTimeout(r, 100));
        }
    }

    for (const [path, type] of [
        ["/", "text/html"],
        ["/jump-n-bump.js", "javascript"],
    ]) {
        const res = await fetch(base + path);
        assert.equal(res.status, 200, `${path} was ${res.status}`);
        assert.match(res.headers.get("content-type"), new RegExp(type));
    }

    // One origin: the same base URL that served the client terminates the socket (#34).
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
    // Create a room, then take a seat on it: hosting is a property of a client that holds
    // one, so the handshake alone no longer proves the room works (#36).
    const [joined, seated] = await new Promise((resolve, reject) => {
        let handshake = null;
        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === "joined") {
                handshake = msg;
                ws.send(JSON.stringify({ type: "seats", names: ["Smoke"] }));
            }
            if (msg.type === "room" && msg.held.length) resolve([handshake, msg]);
        };
        ws.onopen = () => ws.send(JSON.stringify({ type: "create" }));
        ws.onerror = reject;
        setTimeout(() => reject(new Error("no room within 5s")), 5000);
    });
    assert.match(joined.id, /^[A-HJ-NP-Z]{5}$/, `${joined.id} is not a room id`);
    assert.deepEqual(seated.seats, ["Smoke", null, null, null], "the seat carries its username");
    assert.equal(seated.host, true, "the client holding the first seat hosts the room");
    ws.close();
    console.log(`OK ${base}`);
} finally {
    child?.kill();
}
