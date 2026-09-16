import { Renderer } from "../interaction/renderer.js";
import { Objects } from "../game/objects.js";
import { Keyboard } from "../game/keyboard.js";
import { AI } from "../game/ai.js";
import { Animation } from "../game/animation.js";
import { Sound_Player } from "../resource_loading/sound_player.js";
import { Sfx } from "../game/sfx.js";
import { Movement } from "../game/movement.js";
import { Game, player } from "../game/game.js";
import { make_rnd } from "../game/rnd.js";
import { Room } from "../net/room.js";
import { Loopback_Transport } from "../net/loopback_transport.js";
import ko from "knockout";

function Enum(obj) {
    return Object.freeze ? Object.freeze(obj) : obj;
}
var Game_State = Enum({ Not_Started: 0, Playing: 1, Paused: 2 });

// `config` is the match's shared state: the PRNG seed and the settings every client
// must agree on. Settings are never read from this client's environment -- a differing
// no_gore desyncs the RNG stream on the first kill (#5). `muted` is not in it: it is
// this client's preference and nobody else's business.
export function Game_Session(level, config, muted) {
    "use strict";
    var self = this;

    // Offline play is a local room: one client, always the host, over a transport that
    // never opens a socket (#16). Nothing below this line knows which transport it got.
    var key_action_mappings = [];
    var keyboard = new Keyboard(key_action_mappings);
    var transport = new Loopback_Transport();
    var room = new Room(transport, function (scheme) {
        return keyboard.input_frame(scheme);
    });
    // ponytail: one client holding every seat, which is what hot-seat play is. upgrade
    // path: the room hands down the seats this client was actually given (#36).
    room.start({ seed: config.seed, settings: config.settings, held: [0, 1, 2, 3] });

    // Read back off `start` rather than out of `config`: the match's shared state is what
    // the relay handed down (#12).
    // ponytail: read on the line after `start`, which only a transport that answers
    // in-call can satisfy. upgrade path: a socket answers later, so #34 moves everything
    // below into an `on_start` callback.
    var rnd = make_rnd(room.seed);
    var settings = room.settings;

    var canvas = document.getElementById("screen");
    var img = {
        rabbits: document.getElementById("rabbits"),
        objects: document.getElementById("objects"),
        numbers: document.getElementById("numbers"),
    };

    var renderer = new Renderer(canvas, img, level);
    var objects = new Objects(rnd);
    var ai = new AI();
    var animation = new Animation(renderer, img, objects, rnd);
    this.sound_player = new Sound_Player(muted);
    var sfx = new Sfx(this.sound_player);
    var movement = new Movement(sfx, objects, settings, rnd);
    var game = new Game(movement, ai, animation, renderer, objects, room, level, true, rnd);

    this.scores = ko.observable([[]]);
    this.game_state = ko.observable(Game_State.Not_Started);

    this.pause = function () {
        self.game_state(Game_State.Paused);
        self.sound_player.set_muted(true);
        game.pause();
        self.scores(
            player.map(function (p) {
                return p.bumped;
            }),
        );
    };
    this.unpause = function () {
        self.game_state(Game_State.Playing);
        self.sound_player.set_muted(muted);
        game.start();
    };
    this.start = function () {
        sfx.music();
        self.unpause();
    };

    key_action_mappings["M"] = function () {
        if (self.game_state() === Game_State.Playing) {
            muted = !muted;
            self.sound_player.toggle_sound();
        }
    };
    key_action_mappings["P"] = function () {
        switch (self.game_state()) {
            case Game_State.Not_Started:
                self.start();
                break;
            case Game_State.Paused:
                self.unpause();
                break;
            case Game_State.Playing:
                self.pause();
                break;
        }
    };

    document.onkeydown = keyboard.onKeyDown;
    document.onkeyup = keyboard.onKeyUp;
}
