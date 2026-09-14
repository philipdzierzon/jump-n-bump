// PROTOTYPE check (issue #9): the one thing the touch layer must never get wrong is
// jump-while-moving. Runs the overlay's script in a stub DOM. `node prototype/touch/test.js`
const assert = require("assert"), fs = require("fs");

const src = fs.readFileSync(__dirname + "/overlay.html", "utf8").split("<script>")[1].split("</script>")[0];
const el = () => ({ innerHTML: "", textContent: "", style: {}, onclick: null });
const document = {
  getElementById: el, querySelector: () => ({ style: { display: "" } }), addEventListener() {}
};
const window = { innerWidth: 800, innerHeight: 400, addEventListener() {} };
const module_ = { exports: {} };
new Function("document", "window", "location", "history", "setInterval", "module", src)(
  document, window, { search: "", hash: "" }, { replaceState() {} }, () => {}, module_);
const pt = module_.exports;
const t = (id, x, y = 300) => ({ identifier: id, clientX: x, clientY: y });

// A: left quarter steers left, second quarter right, right half jumps — and both at once
assert.deepStrictEqual(pt.readHalves([t(1, 100)]), { left: true, right: false, up: false });
assert.deepStrictEqual(pt.readHalves([t(1, 300)]), { left: false, right: true, up: false });
assert.deepStrictEqual(pt.readHalves([t(1, 100), t(2, 600)]), { left: true, right: false, up: true });
pt.setSwap(true);
assert.deepStrictEqual(pt.readHalves([t(1, 100), t(2, 500)]), { left: true, right: false, up: true });
pt.setSwap(false);

// B: anchor is where the thumb landed; dead zone either side; sliding steers without lifting
assert.deepStrictEqual(pt.readAnchor([t(1, 200)]), { left: false, right: false, up: false });
assert.deepStrictEqual(pt.readAnchor([t(1, 230), t(2, 600)]), { left: false, right: true, up: true });
assert.deepStrictEqual(pt.readAnchor([t(1, 170)]), { left: true, right: false, up: false });
assert.deepStrictEqual(pt.readAnchor([t(9, 200)]), { left: false, right: false, up: false }); // re-anchors

// C: only the buttons do anything, and the jump button coexists with a steer button
const b = pt.buttons();
assert.deepStrictEqual(pt.readButtons([t(1, b.left.x, b.left.y), t(2, b.up.x, b.up.y)]),
  { left: true, right: false, up: true });
assert.deepStrictEqual(pt.readButtons([t(1, 400, 200)]), { left: false, right: false, up: false });
// swapping moves the pair across, it never reverses ◀ and ▶
for (const s of [false, true]) {
  pt.setSwap(s);
  const c = pt.buttons();
  assert.ok(c.left.x < c.right.x, "left button stays left of right button, swapped=" + s);
  assert.ok(Math.abs(c.up.x - c.right.x) > 2 * c.r, "jump button stays clear of the pair");
}
pt.setSwap(false);

console.log("ok");
