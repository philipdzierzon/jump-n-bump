import sys
p = sys.argv[1]
s = open(p).read()

old = '''function record_checksums(root) {
    const hashes = new Map();
    root.on("websocket", (ws) =>
        ws.on("framesent", ({ payload }) => {
            const text = String(payload);
            if (!text.includes('"checksum"')) return;
            const msg = JSON.parse(text);
            // First hash wins. Overwrite on a re-emission would let a later, correct hash
            // for an already-lied tick mask the lie -- AC2 below needs exact.
            if (msg.type === "checksum" && !hashes.has(msg.t)) hashes.set(msg.t, msg.h);
        }),
    );
    return hashes;
}'''
assert old in s
new = '''let seq = 0;
const timelines = {};
function record_checksums(root, who) {
    const hashes = new Map();
    const line = (timelines[who] = timelines[who] || []);
    root.on("websocket", (ws) => {
        ws.on("framesent", ({ payload }) => {
            const text = String(payload);
            if (!text.includes('"checksum"')) return;
            const msg = JSON.parse(text);
            if (msg.type !== "checksum") return;
            line.push([++seq, "-> checksum t=" + msg.t + " h=" + msg.h]);
            if (!hashes.has(msg.t)) hashes.set(msg.t, msg.h);
        });
        ws.on("framereceived", ({ payload }) => {
            const text = String(payload);
            if (!text.includes('"start"') && !text.includes('"driver"')) return;
            let msg;
            try {
                msg = JSON.parse(text);
            } catch (e) {
                return;
            }
            if (msg.type === "start")
                line.push([
                    ++seq,
                    "<- start t=" + msg.t + " until=" + msg.until + " d=" + msg.d +
                        " snapshot=" + !!msg.snapshot + " held=" + JSON.stringify(msg.held) +
                        " drivers=" + JSON.stringify(msg.drivers) +
                        " changes=" + JSON.stringify(msg.changes) +
                        " inputs=" + (msg.inputs || []).length +
                        " input_ticks=" + JSON.stringify((msg.inputs || []).map((f) => f.t)),
                ]);
            if (msg.type === "driver")
                line.push([++seq, "<- driver t=" + msg.t + " seat=" + msg.seat + " " + msg.driver]);
        });
    });
    return hashes;
}'''
s = s.replace(old, new, 1)

s = s.replace("const host_hashes = record_checksums(host);", 'const host_hashes = record_checksums(host, "host");', 1)
s = s.replace("const guest_hashes = record_checksums(guest);", 'const guest_hashes = record_checksums(guest, "guest");', 1)

mark = '''    console.log(
        "DEBUG host_all="'''
assert mark in s
extra = '''    for (const who of ["host", "guest"])
        for (const [n, what] of timelines[who]) console.log("DEBUG timeline " + who + " #" + n + " " + what);
'''
s = s.replace(mark, extra + mark, 1)
open(p, "w").write(s)
print("patched timeline", p)
