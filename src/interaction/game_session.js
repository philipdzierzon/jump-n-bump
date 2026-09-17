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
export var Game_State = Enum({ Not_Started: 0, Playing: 1, Paused: 2 });

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
    // Room counts this client's seats in the order it holds them; the scheme driving the
    // nth of them is the one that participant pressed the jump key of, which is not the
    // same number (#32, #35).
    var room = new Room(transport, function (nth) {
        return keyboard.input_frame(config.schemes[nth]);
    });

    var game = null;
    var sfx = null;
    var sound_player = null;
    var start_when_ready = false;

    this.scores = ko.observable([[]]);
    this.game_state = ko.observable(Game_State.Not_Started);
    this.on_match_start = null;
    this.on_match_end = null;

    // The relay cannot read the simulation, so the host announces the end and the final
    // board travels with it (#22, #19). It comes back to the announcer too, which is what
    // makes every client leave the match on the same message rather than on its own.
    room.on_match_end = function (msg) {
        if (self.on_match_end) self.on_match_end(msg);
    };
    // A client that stops simulating hands its seats over rather than leaving them frozen.
    this.release_seats = function () {
        room.release();
    };
    this.announce_end = function (reason) {
        room.end_match(
            reason,
            player.map(function (p) {
                return p.bumped;
            }),
        );
    };

    // A socket answers `start` a round trip later than a loopback does, so the whole
    // simulation is built out of what the relay handed down rather than out of `config`
    // (#12, #34).
    room.on_start = function () {
        // A host can start another match while this client is playing one: the outgoing
        // pump loop would go on stepping the `player` array the new one replaces, and its
        // music would go on playing.
        if (game) game.pause();
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

        // Every client in the room holds a session from the moment it reaches the lobby,
        // so the host's `start` never lands on a client that is not listening yet (#35).
        if (self.on_match_start) self.on_match_start();
        if (start_when_ready) self.start();
    };

    // Only the host proposes a match, and it proposes from the lobby rather than from this
    // constructor: a session exists for as long as a client is in the room, and the match
    // begins when the host says so (#35, #37). A joining client plays what it is handed.
    // The seats are the room's to grant, not this client's to claim: `held` here is what a
    // local room runs on, and a networked one is handed its own back on `start` (#36).
    this.propose = function () {
        room.start({ seed: config.seed, settings: config.settings, held: config.held });
    };

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
    // Pause only: starting a match is the lobby's Start button, and a P typed on a flow
    // screen must not jump the queue (#35).
    key_action_mappings["P"] = function () {
        switch (self.game_state()) {
            case Game_State.Paused:
                self.unpause();
                break;
            case Game_State.Playing:
                self.pause();
                break;
        }
    };

    // A focused text field owns the keys: typing a P into the room id must not start a
    // game, an M must not toggle the sound, and WAD must not steer a bunny. The guard
    // lives here rather than in `Keyboard`, which is simulation-side and sees no DOM.
    document.onkeydown = function (evt) {
        if (!is_typing(evt)) keyboard.onKeyDown(evt);
    };
    document.onkeyup = function (evt) {
        if (!is_typing(evt)) keyboard.onKeyUp(evt);
    };
}

// Shared with the flow screens, which have text fields of their own (#35).
export function is_typing(evt) {
    var element = evt.target;
    return (
        !!element &&
        (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable)
    );
}
