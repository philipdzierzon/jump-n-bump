// PROTOTYPE (#30) — throwaway instrumentation for the mobile performance budget.
// Not for master. Knobs are query params:
//   ?perf=1          overlay on, all four seats driven by AI (hands-free load)
//   ?drawlast=1      draw once per catch-up batch instead of once per tick
//   ?maxleftovers=N  bound the leftovers buffer to N (ring); 0 = today's unbounded
//   ?noresize=1      resize the canvas on the resize event only, not every frame
function q(name) {
    return new URLSearchParams(location.search).get(name);
}

function ring(n) {
    var a = [], i = 0;
    return {
        push: function (v) { a[i++ % n] = v; },
        p: function (frac) {
            var s = a.slice().sort(function (x, y) { return x - y; });
            return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * frac))] : 0;
        }
    };
}

export const perf = {
    on: q("perf") === "1",
    draw_last: q("drawlast") === "1",
    max_leftovers: parseInt(q("maxleftovers") || "0", 10),
    lazy_resize: q("noresize") === "1",
    sim: ring(600),
    draw: ring(600),
    ticks: 0,
    batch: 0,       // worst catch-up depth since the last report
    leftovers: 0,
    now: function () { return performance.now(); }
};

if (perf.on) {
    var el = document.createElement("div");
    el.style.cssText = "position:fixed;bottom:0;left:0;z-index:99;background:#000000cc;" +
        "color:#0f0;font:11px monospace;padding:4px;white-space:pre";
    document.body.appendChild(el);

    var last = perf.now(), last_ticks = 0;
    setInterval(function () {
        var secs = (perf.now() - last) / 1000;
        last = perf.now();
        var tps = (perf.ticks - last_ticks) / secs;
        last_ticks = perf.ticks;
        el.textContent = [
            "tick/s   " + tps.toFixed(1) + "   target 60",
            "sim  ms  p50 " + perf.sim.p(0.5).toFixed(2) + "  p95 " + perf.sim.p(0.95).toFixed(2),
            "draw ms  p50 " + perf.draw.p(0.5).toFixed(2) + "  p95 " + perf.draw.p(0.95).toFixed(2),
            "catchup  " + perf.batch + " ticks/batch worst",
            "leftover " + perf.leftovers,
            "knobs    drawlast=" + (perf.draw_last ? 1 : 0) +
                " maxleftovers=" + perf.max_leftovers +
                " noresize=" + (perf.lazy_resize ? 1 : 0)
        ].join("\n");
        perf.batch = 0;
    }, 500);
}
