import sys, re
p = sys.argv[1]
s = open(p).read()

# 1. env switch for the deliberate lie
anchor = "// --- the walk ---"
assert anchor in s
s = s.replace(anchor, "const LIE = !process.env.JNB_NO_LIE;\nconst SAMPLES = Number(process.env.JNB_SAMPLES || 3);\n\n" + anchor, 1)

# 2. wrap the lie block (AC2 + after_lie) in `if (LIE) { ... }`
start = s.index("    // And the assertion can fail: one hash the guest gets wrong on purpose.")
endmark = '        "and a client that stops lying is back in step with the host",\n    );\n'
end = s.index(endmark) + len(endmark)
block = s[start:end]
s = s[:start] + "  if (LIE) {\n" + block + "  }\n" + s[end:]

# 3. sample count + debug dump before the final assertion
old = '''    await until(
        "three ticks both pages have hashed since the repair",
        () => paired(host_hashes, guest_hashes, after_repair).length >= 3,
    );
'''
assert old in s
new = '''    await until(
        "ticks both pages have hashed since the repair",
        () => paired(host_hashes, guest_hashes, after_repair).length >= SAMPLES,
    );
    const dbg_pairs = paired(host_hashes, guest_hashes, after_repair).map((t) => [
        t,
        host_hashes.get(t),
        guest_hashes.get(t),
        host_hashes.get(t) === guest_hashes.get(t) ? "same" : "DIFF",
    ]);
    console.log("DEBUG lie=" + LIE + " samples=" + SAMPLES + " after_repair=" + after_repair);
    console.log("DEBUG pairs=" + JSON.stringify(dbg_pairs));
    console.log(
        "DEBUG disagreements=" +
            JSON.stringify(disagreements(host_hashes, guest_hashes, after_repair)),
    );
    console.log(
        "DEBUG host_all=" +
            JSON.stringify([...host_hashes.keys()].sort((a, b) => a - b)) +
            " guest_all=" +
            JSON.stringify([...guest_hashes.keys()].sort((a, b) => a - b)),
    );
    for (const [t] of dbg_pairs.filter((one) => one[3] === "DIFF")) {
        const hp = await host.evaluate((tick) => (window.__packs || {})[tick], t).catch(() => null);
        const gp = await guest.evaluate((tick) => (window.__packs || {})[tick], t).catch(() => null);
        if (hp && gp) console.log("DEBUG pack " + t + " host=" + hp + "\\nDEBUG pack " + t + " guest=" + gp);
    }
'''
s = s.replace(old, new, 1)
open(p, "w").write(s)
print("patched", p)
