// The determinism check (#31): the same seed and the same input log must replay to the
// same state, and the replay runs with no DOM -- which is the point, since a server or
// a peer has none either. Run with `npm test`.
import assert from "node:assert";

import { Game, player } from "../src/game/game.js";
import { Objects } from "../src/game/objects.js";
import { Keyboard } from "../src/game/keyboard.js";
import { AI } from "../src/game/ai.js";
import { Animation } from "../src/game/animation.js";
import { Movement } from "../src/game/movement.js";
import { make_rnd } from "../src/game/rnd.js";
import { env } from "../src/game/env.js";
import { default_ban_map } from "../src/asset_data/default_levelmap.js";
import { Renderer } from "../src/interaction/renderer.js";

const TICKS = 3600; // one minute at 60 Hz -- long enough that bunnies collide

function fnv1a(hash, value) {
	value = value | 0;
	for (let byte = 0; byte < 4; byte++) {
		hash ^= (value >>> (byte * 8)) & 0xff;
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

// The whole simulation, hashed field by field: picking a subset would silently
// un-detect whatever was left out (#19).
function checksum(objects) {
	let hash = 2166136261;
	const fold = (...values) => values.forEach((v) => (hash = fnv1a(hash, v === true ? 1 : v === false ? 0 : v)));
	for (const p of player) {
		fold(p.x.pos, p.y.pos, p.x.velocity, p.y.velocity, p.direction, p.enabled, p.dead_flag,
			p.jump_ready, p.jump_abort, p.in_water, p.anim, p.frame, p.frame_tick, p.bumps);
		for (let i = 0; i < env.JNB_MAX_PLAYERS; i++) fold(p.bumped[i]);
	}
	for (const o of objects) {
		fold(o.used, o.type, o.anim, o.frame, o.ticks, o.image);
		if (o.used) fold(o.x.pos, o.y.pos, o.x.velocity, o.y.velocity);
	}
	return hash;
}

// Three keys per seat per tick, from a PRNG of its own -- drawing them from the
// simulation's `rnd` would change the stream it is being tested on.
function input_log(seed) {
	const draw = make_rnd(seed);
	const log = [];
	for (let tick = 0; tick < TICKS; tick++) {
		const frame = [];
		for (let seat = 0; seat < env.JNB_MAX_PLAYERS; seat++) {
			frame.push([draw(2) === 1, draw(2) === 1, draw(4) === 1]);
		}
		log.push(frame);
	}
	return log;
}

const no_renderer = { add_pob() { }, add_leftovers() { }, clear_pobs() { }, draw() { } };
const no_sfx = { jump() { }, death() { }, spring() { }, splash() { }, fly() { }, music() { } };

function replay(seed, log, settings = { no_gore: false }) {
	const rnd = make_rnd(seed);
	const objects = new Objects(rnd);
	const keyboard = new Keyboard([]);
	const game = new Game(
		new Movement(no_sfx, objects, settings, rnd),
		new AI(keyboard),
		new Animation(no_renderer, {}, objects, rnd),
		no_renderer, objects, keyboard.key_pressed,
		{ ban_map: default_ban_map() }, true, rnd);

	for (const frame of log) {
		for (let seat = 0; seat < env.JNB_MAX_PLAYERS; seat++) {
			frame[seat].forEach((held, key) => {
				const event = { keyCode: player[seat].keys[key], altKey: false };
				held ? keyboard.onKeyDown(event) : keyboard.onKeyUp(event);
			});
		}
		game.step();
	}
	return checksum(objects.objects);
}

const log = input_log(99);
assert.equal(replay(1234, log), replay(1234, log), "same seed and inputs must replay identically");
assert.notEqual(replay(1234, log), replay(4321, log), "a different seed must reach a different state");
assert.notEqual(replay(1234, log), replay(1234, log, { no_gore: true }),
	"no_gore changes the state, which is why settings are shared and not per-client");

// The leftovers ring: bounded at 50, keeping the newest (#30). Renderer needs a 2d
// context and a window, and nothing else -- add_leftovers itself touches no DOM.
const drawn = [];
global.window = { innerWidth: 400, innerHeight: 256 };
const renderer = new Renderer(
	{ getContext: () => ({ drawImage: (image) => drawn.push(image), scale() { } }) },
	{}, { image: { width: 400, height: 256 }, mask: {} });
for (let i = 0; i < 60; i++) renderer.add_leftovers(0, 0, i, {});
renderer.draw();
const splats = drawn.filter((image) => typeof image === "number");
// Unsorted: the order is the assertion. The newest splat has to paint last, which the
// ring only does if it is walked from its oldest entry rather than from index 0.
assert.deepEqual(splats, [...Array(50).keys()].map((i) => i + 10),
	"the leftovers ring holds the newest 50 splats, oldest painted first");

console.log("OK replay is deterministic, headless, and the leftovers ring is bounded");
