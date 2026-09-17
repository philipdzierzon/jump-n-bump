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

function noop() {}

function Enum(obj) {
    return Object.freeze ? Object.freeze(obj) : obj;
}
// `Board` is this client's scoreboard being up, which is all the P key does in a lockstep
// room: the simulation keeps running under it and nobody else hears about it. Only a local
// room really stops, because there is nothing there to desync from (#21, #37).
export var Game_State = Enum({ Not_Started: 0, Playing: 1, Board: 2 });

// `config` is this client's half of the match: the seed and the settings it proposes if it
// is the host, and nothing at all if it is not. What the match actually runs on arrives on
// `start`, from the relay -- settings are never read from a client's own environment, since
// a differing no_gore desyncs the RNG stream on the first kill (#5). `muted` is not in it:
// it is this client's preference and nobody else's business.
//
// `get_level(name)` resolves the level the room named, which is why it is a promise and not
// a level: a `.dat` is fetched and decoded, and the name only arrives on `start` (#38).
//
// The transport is handed in: a loopback for a local room, a socket for a networked one,
// and nothing below this line knows which it got (#16).
export function Game_Session(get_level, config, muted, transport) {
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
    var board_timer = null;
    var clock_timer = null;
    // Which `start` the pending level load belongs to. The host can start another match
    // while this client is still fetching the last one's level, and the loser of that race
    // must not build a simulation over the winner's.
    var starting = 0;

    this.scores = ko.observable([[]]);
    this.game_state = ko.observable(Game_State.Not_Started);
    // Time left of a time-limited match, mm:ss, or null when the match is endless. It is
    // sampled off the simulation's own tick rather than a clock, and it is chrome: no wire
    // bytes and no canvas pixels (#39).
    this.clock = ko.observable(null);
    this.on_match_start = null;
    this.on_match_end = null;
    // A limit the simulation reached. Every client reaches it on the same tick and stops
    // there; only the host announces it, which is what the others leave the match on (#22).
    this.on_limit = null;

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
        var mine = ++starting;
        // The level is the room's, named in the settings the relay handed down, and a
        // `.dat` has to be fetched and decoded before anything can be built on it (#38).
        // A client that cannot load it stays where it is rather than playing a different
        // map: a differing ban map is a desync, not a degraded picture.
        get_level(room.settings.level).then(function (level) {
            if (mine === starting) build(level);
        }, noop);
    };

    function build(level) {
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
        game.on_end = function (reason) {
            show_clock();
            if (self.on_limit) self.on_limit(reason);
        };

        // Every client in the room holds a session from the moment it reaches the lobby,
        // so the host's `start` never lands on a client that is not listening yet (#35).
        if (self.on_match_start) self.on_match_start();
        if (start_when_ready) self.start();
    }

    // Only the host proposes a match, and it proposes from the lobby rather than from this
    // constructor: a session exists for as long as a client is in the room, and the match
    // begins when the host says so (#35, #37). A joining client plays what it is handed.
    // The seats are the room's to grant, not this client's to claim: `held` here is what a
    // local room runs on, and a networked one is handed its own back on `start` (#36).
    // `settings` is read at propose time rather than held from construction: a session
    // lives for as long as this client is in the lobby, and a local room's config is edited
    // inside it (#38). A networked room's relay ignores what is proposed here anyway.
    this.propose = function () {
        room.start({ seed: config.seed, settings: config.settings(), held: config.held });
    };

    function snapshot() {
        self.scores(
            player.map(function (p) {
                return p.bumped;
            }),
        );
    }

    function forget_board() {
        clearInterval(board_timer);
        board_timer = null;
    }

    // Sampled on a wall clock like the board's refresh is, because nothing in the loop
    // knows the top bar is there -- but what it reads is the simulation's own tick, so the
    // number the bar shows and the tick the match ends on are the same count (#39).
    function show_clock() {
        var left = game ? game.ticks_left() : null;
        if (left == null) return self.clock(null);
        var seconds = Math.ceil(left / 60);
        self.clock(Math.floor(seconds / 60) + ":" + ("0" + (seconds % 60)).slice(-2));
    }

    // Simulating, with no board up. `Game.start` is a no-op while it is already pumping,
    // which is what lets every way back into the match share this.
    function play() {
        forget_board();
        self.game_state(Game_State.Playing);
        sound_player.set_muted(muted);
        game.start();
        show_clock();
        // ponytail: the bar's clock is up to 250ms behind the tick it counts, which nobody
        // can see on a clock that shows seconds. upgrade path: a per-frame callback out of
        // the pump loop if anything ever needs the tick itself.
        if (!clock_timer) clock_timer = setInterval(show_clock, 250);
    }

    // The board, over a simulation that carries on scoring behind it. Its refresh is on a
    // wall clock rather than on a tick, because nothing in the loop knows the board is up
    // -- and a local room needs none, since the sim really does stop under it (#37).
    this.show_board = function () {
        if (!game) return;
        self.game_state(Game_State.Board);
        snapshot();
        if (config.local) {
            sound_player.set_muted(true);
            game.pause();
            return;
        }
        board_timer = setInterval(snapshot, 250);
    };
    this.hide_board = function () {
        if (game) play();
    };
    // The way out of the match, whichever screen it is leaving for. The board is not that
    // any more: in a networked room it never stopped the simulation (#37).
    this.stop = function () {
        // Any level still loading belongs to a match this client is no longer in, so the
        // build it would land in is cancelled with the same counter a second `start` uses.
        starting++;
        forget_board();
        clearInterval(clock_timer);
        clock_timer = null;
        self.clock(null);
        // Counted here, because the lobby reads this board the moment the match is left and
        // the overlay's own refresh is the only other thing that ever fills it: leaving a
        // match nobody pressed P on handed the lobby the empty matrix this starts life as,
        // which draws two rows of one cell instead of the grid (#13, #37).
        if (game) snapshot();
        // The match is over for this client, so its music is over with it: muting used to
        // ride along with the board, and the board stopped pausing anything (#37).
        if (sound_player) sound_player.set_muted(true);
        if (game) game.pause();
    };
    // Pressed before `start` has come back, which is a round trip on a socket: remembered
    // rather than dropped, so the button works the moment the room does.
    this.start = function () {
        if (!game) {
            start_when_ready = true;
            return;
        }
        sfx.music();
        play();
    };

    key_action_mappings["M"] = function () {
        // The simulation is still running behind a networked room's board, so the sound is
        // still playing and M still means something there (#37). A local room really is
        // stopped, and is muted for as long as it is.
        if (self.game_state() === Game_State.Not_Started) return;
        if (config.local && self.game_state() === Game_State.Board) return;
        muted = !muted;
        sound_player.toggle_sound();
    };
    // The board only: starting a match is the lobby's Start button, and a P typed on a
    // flow screen must not jump the queue (#35).
    key_action_mappings["P"] = function () {
        switch (self.game_state()) {
            case Game_State.Board:
                self.hide_board();
                break;
            case Game_State.Playing:
                self.show_board();
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
