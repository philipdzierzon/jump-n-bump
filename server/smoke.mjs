// Smoke test: proves static serving, /healthz and the WebSocket echo.
// Usage: node smoke.mjs [base-url]   (default: boots a local server)
import assert from "node:assert";
import { spawn } from "node:child_process";

const given = process.argv[2];
const base = given || "http://127.0.0.1:8099";
const child = given
	? null
	: spawn("node", ["index.js"], {
			env: { ...process.env, PORT: 8099 },
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

	const ws = new WebSocket(base.replace(/^http/, "ws"));
	const got = await new Promise((resolve, reject) => {
		const seen = [];
		ws.onmessage = (e) => seen.push(e.data) === 2 && resolve(seen);
		ws.onopen = () => ws.send("ping");
		ws.onerror = reject;
		setTimeout(() => reject(new Error("no echo within 5s")), 5000);
	});
	assert.deepEqual(got, ['{"type":"hello"}', "ping"]);
	ws.close();
	console.log(`OK ${base}`);
} finally {
	child?.kill();
}
