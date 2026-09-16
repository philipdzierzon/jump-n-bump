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
import ko from "knockout";

function Enum(obj) {
    return Object.freeze ? Object.freeze(obj) : obj;
}
var Game_State = Enum({ Not_Started: 0, Playing: 1, Paused: 2 });

// `config` is this client's half of the match: the seed and the settings it proposes if it
// is the host, and nothing at all if it is not. What the match actually runs on arrives on
// `start`, from the relay -- settings are never read from a client's own environment, since
// a differing no_gore desyncs the RNG stream on the first kill (#5). `muted` is not in it:
// it is this client's preference and nobody else's business.
//
// The transport is handed in: a loopback for a local room, a socket for a networked one,
// and nothing below this line knows which it got (#16).
export function Game_Session(level, config, muted, transport) {
    "use strict";
    var self = this;

    var key_action_mappings = [];
    var keyboard = new Keyboard(key_action_mappings);
    var room = new Room(transport, function (scheme) {
        return keyboard.input_frame(scheme);
    });

    var game = null;
    var sfx = null;
    var sound_player = null;
    var start_when_ready = false;

    this.scores = ko.observable([[]]);
    this.game_state = ko.observable(Game_State.Not_Started);

    // A socket answers `start` a round trip later than a loopback does, so the whole
    // simulation is built out of what the relay handed down rather than out of `config`
    // (#12, #34).
    room.on_start = function () {
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
        sound_player = new Sound_Player(muted);
        sfx = new Sfx(sound_player);
        var movement = new Movement(sfx, objects, settings, rnd);
        game = new Game(movement, ai, animation, renderer, objects, room, level, true, rnd);

        if (start_when_ready) self.start();
    };

    // Only the host proposes a match: a joining client plays the one the relay hands it.
    // ponytail: one client holding every seat, which is what hot-seat play is. upgrade
    // path: the room hands down the seats this client was actually given (#36).
    if (config.host)
        room.start({ seed: config.seed, settings: config.settings, held: [0, 1, 2, 3] });

    this.pause = function () {
        if (!game) return;
        self.game_state(Game_State.Paused);
        sound_player.set_muted(true);
        game.pause();
        self.scores(
            player.map(function (p) {
                return p.bumped;
            }),
        );
    };
    this.unpause = function () {
        if (!game) return;
        self.game_state(Game_State.Playing);
        sound_player.set_muted(muted);
        game.start();
    };
    // Pressed before `start` has come back, which is a round trip on a socket: remembered
    // rather than dropped, so the button works the moment the room does.
    this.start = function () {
        if (!game) {
            start_when_ready = true;
            return;
        }
        sfx.music();
        self.unpause();
    };

    key_action_mappings["M"] = function () {
        if (self.game_state() === Game_State.Playing) {
            muted = !muted;
            sound_player.toggle_sound();
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
