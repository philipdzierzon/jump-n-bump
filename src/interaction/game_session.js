import { Renderer } from "../interaction/renderer.js";
import { Objects } from "../game/objects.js";
import { Keyboard } from "../game/keyboard.js";
import { AI } from "../game/ai.js";
import { Animation } from "../game/animation.js";
import { shared_sound_player } from "../resource_loading/sound_player.js";
import { Sfx } from "../game/sfx.js";
import { Movement } from "../game/movement.js";
import { Game, player } from "../game/game.js";
import {
    bump_matrix,
    checksum_ban_map,
    checksum_snapshot,
    decode_snapshot,
    encode_snapshot,
    pack_snapshot,
    unpack_snapshot,
} from "../game/snapshot.js";
import { make_rnd } from "../game/rnd.js";
import { MAX_CATCH_UP } from "../net/room_config.js";
import { Room } from "../net/room.js";
import ko from "knockout";

// How often the host packs its simulation and hands it to the relay, which caches the
// latest one for the next client to join the match (#40).
var SNAPSHOT_MS = 2000;

// How long a repair keeps the message up. Longer than the relay's two-second repair
// cooldown, and longer than the gaps a real episode showed -- a 6x-throttled client was
// repaired every two to four and a half seconds -- so a client being repeatedly repaired
// says so continuously rather than blinking between repairs (#41).
// ponytail: it therefore lingers up to five seconds after the last repair, saying
// "reconnecting" about a client that already has. upgrade path: the relay could say when it
// stops repairing, which is a message for a thing that is over.
var RECONNECTING_MS = 5000;

// How far behind the room this client has to be before it says so on its own account.
// `Room.gap()` is its tick against the newest one anybody has stamped a frame for, and it
// catches the other way a client stops being in step: one whose loop is not running at all.
// `pump` catches up to the wall clock in a `while` loop, so a client that is merely slow
// loses drawn frames rather than ticks and its gap stays nothing -- but a backgrounded tab's
// `setTimeout` is throttled to about once a second, and that one really does fall behind
// (#51). Half a second, which is well past the tick or two of normal jitter.
var BEHIND_TICKS = 30;

// How long a match that reached its limit stays frozen on the tick it ended before the host
// announces it: the room's one second of rewind, in which a late frame can still undo the
// killing bump and the match plays on (#141).
var SETTLE_MS = 1000;

function Enum(obj) {
    return Object.freeze ? Object.freeze(obj) : obj;
}
// `Board` is this client's scoreboard being up, which is all the P key does in a lockstep
// room: the simulation keeps running under it and nobody else hears about it. Only a local
// room really stops, because there is nothing there to desync from (#21, #37).
export var Game_State = Enum({ Not_Started: 0, Playing: 1, Board: 2 });

// `config` is this client's half of the match: the seed and the settings it proposes if it
// is the host, and nothing at all if it is not. `config.host` is read live rather than held
// -- host migrates, and the reference state the room resyncs from migrates with it (#40,
// #14). What the match actually runs on arrives on
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
        // Read live rather than held: a client can take a seat while the match is running,
        // which grows the seats it drives and the schemes bound to them (#42).
        return keyboard.input_frame(config.schemes()[nth]);
    });
    // The room keeps a second of this client's states to rewind to when a frame lands late,
    // and hashes the oldest of them every 30 ticks for the relay to compare against the
    // host's; a mismatch is answered with the resync payload the join path already has
    // (#41, #141). A local room is a room of one, with no late frames and nothing to disagree
    // with, so it keeps none (#16). The host hashes too -- its own is the reference.
    if (!config.local)
        room.history = {
            save: function () {
                return { state: pack_snapshot(rnd, objects, room.now()), ended: game.ended() };
            },
            load: function (saved) {
                unpack_snapshot(saved.state, rnd, objects);
                game.ended(saved.ended);
            },
            hash: function (saved) {
                return checksum_snapshot(saved.state, level_hash);
            },
            step: function () {
                game.step();
                return !game.ended();
            },
        };
    // A rewind that undid the tick the match ended on: it plays on (#141).
    room.on_rewound = function () {
        if (!limit_timer || game.ended()) return;
        clearTimeout(limit_timer);
        limit_timer = null;
        game.start();
    };

    var game = null;
    var sfx = null;
    // The page's, not this session's. The six elements hold nothing to do with a match, so
    // `build` making a set per match left the outgoing set paused, decoded and alive --
    // ninety of them a minute on a client being repaired every two seconds, which is exactly
    // the client that could least afford them (#30, #91). They hold nothing to do with a
    // room either, and a session is rebuilt on every room entry and on every walk between
    // the lobby and the match (`viewmodels.js`): owning them here left a set behind for each
    // of those, so a browse in, a match and a browse out cost two (#123).
    var sound_player = shared_sound_player();
    // The two halves of the simulation a snapshot is packed from and unpacked into: the
    // objects and the RNG's own state. The players are the `player` array, which is the
    // module's rather than this session's (#5).
    var objects = null;
    var rnd = null;
    // The ban map this match is being played on, hashed once when the level is built and
    // chained into every tick's checksum. The level crosses the wire as a name and each
    // client fetches the bytes behind it for itself, so two clients that resolved one name
    // to two different `.dat` bodies disagree on every hash from tick 0 rather than on the
    // first tick a bunny happens to touch the tile that differs (#95). Zero until a level
    // is built, which is before any tick is stepped.
    //
    // ponytail: the relay cannot tell a wrong ban map from a determinism bug, so a client
    // on a stale level is repaired five times from a snapshot that cannot fix it -- about
    // twelve seconds -- before it is dropped from the match. upgrade path: a `level`
    // message of its own that the relay compares at match start and answers with one
    // refusal, if that window ever turns up in a log.
    var level_hash = 0;
    var snapshot_timer = null;
    var start_when_ready = false;
    var board_timer = null;
    var clock_timer = null;
    var limit_timer = null;
    // Which `start` the pending level load belongs to. The host can start another match
    // while this client is still fetching the last one's level, and the loser of that race
    // must not build a simulation over the winner's.
    var starting = 0;
    // When the relay last replaced this client's simulation with the host's. A client that
    // is late cannot see it from the inside -- its own tick keeps up, its own inputs are its
    // own, and what went wrong is that its frames reached everybody else after the tick they
    // were stamped for (#6, #68). The repair landing is the only local evidence there is.
    var repaired_at = 0;
    // Whether the state about to be unpacked is replacing one this client was playing, or
    // filling one it has not got: the same payload, two triggers (#40), and two different
    // things to have measured.
    var repairing = false;

    this.scores = ko.observable([[]]);
    this.game_state = ko.observable(Game_State.Not_Started);
    // Time left of a time-limited match, mm:ss, or null when the match is endless. It is
    // sampled off the simulation's own tick rather than a clock, and it is chrome: no wire
    // bytes and no canvas pixels (#39).
    this.clock = ko.observable(null);
    // Whether this client is behind the room, which is the one thing about a desync it can
    // work out for itself: the relay decides when to repair it, but how far behind it is is
    // true between repairs and before the first one, and it is what the player is looking at
    // when the bunnies jump (#41).
    this.reconnecting = ko.observable(false);
    // Seats this client holds that the AI is driving, as the simulation last applied them
    // (#76). Sampled with the line above.
    this.ai_seats = ko.observable([]);
    this.on_match_start = null;
    // A `start` that never became a match: the level would not load, or the state it
    // carried could not be replayed. Both were silent, and a client that had asked to be
    // let into this match was waiting on exactly this answer (#89).
    this.on_start_failed = null;
    // Whether a `start` has landed on this session: it is playing a match, or building
    // one, rather than sitting in the lobby waiting for the next (#40).
    this.in_match = false;
    this.on_match_end = null;
    // A limit the simulation reached. Every client reaches it on the same tick and stops
    // there; only the host announces it, which is what the others leave the match on (#22).
    this.on_limit = null;
    // The match this client last watched end, by the room's own count of its matches
    // (#122). Zero until one does, which is a number no `start` ever carries. `room.match`
    // is not cleared by `match_end` -- it outlives the match it names, which is the whole
    // reason it can be read here at all -- so a `start` arriving with this number, or with
    // one below it, is for a match this client has already seen out (#124).
    //
    // Kept on the transport rather than in this session, because it has to outlive the
    // session: `viewmodels.js` builds a fresh one for the lobby when the end-of-match hold
    // walks this client back, and a repair `start` still in flight from the match that just
    // ended can land on that one. A session counting from zero built it and put the client
    // back on the match screen of a match nobody else was in (#150). The transport is the
    // room's connection and lives exactly as long as the relay's count of that room's
    // matches does -- a loopback counts its own -- so a new room starts from zero with it.
    if (!transport.ended_match) transport.ended_match = 0;

    // The relay cannot read the simulation, so the host announces the end and the final
    // board travels with it (#22, #19). It comes back to the announcer too, which is what
    // makes every client leave the match on the same message rather than on its own.
    room.on_match_end = function (msg) {
        // Where a session stops being one that is in a match. Every client hears the same
        // message, so this is the one place both readers of the flag agree on: the way out
        // of the match screen, and the announcement that way out makes (#87).
        self.in_match = false;
        // Read at the end and not at the next `start`, because a `start` is where the
        // number is overwritten: by the time `build` runs, `room.match` is already the
        // arriving payload's (#124).
        transport.ended_match = room.match;
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

    // A `start` that never became a match, said once regardless of which of the two ways
    // it failed (#89).
    function start_failed() {
        if (self.on_start_failed) self.on_start_failed();
    }

    // A socket answers `start` a round trip later than a loopback does, so the whole
    // simulation is built out of what the relay handed down rather than out of `config`
    // (#12, #34).
    room.on_start = function (msg) {
        // A state landing on a client that is already playing: the relay found this one's
        // checksum disagreeing with the host's and repaired it (#41). A mid-match join
        // carries a state too, but never onto a match this client was already in.
        repairing = self.in_match && !!msg.snapshot;
        if (repairing) repaired_at = Date.now();
        // Set before the level is fetched, not after the simulation is built: a client
        // that has been handed this match is in it from the moment `start` lands, and
        // asking to be let into a match it is already playing would replace the state it
        // is playing with the host's, for nothing (#40).
        self.in_match = true;
        // A host can start another match while this client is playing one: the outgoing
        // pump loop would go on stepping the `player` array the new one replaces, and its
        // music would go on playing.
        if (game) game.pause();
        // The simulation about to be replaced must not be heard over the gap: the pump is
        // paused above, the level is still to resolve, and a load that fails leaves the
        // match here. `play` un-mutes it again, from where the track had got to rather than
        // from the top (#28, #40, #91).
        sound_player.set_muted(true);
        // A new match starts its music from the top; a repair is the same match, and picks
        // it up where it was (#91, #146). Every match begins here, a local room's included.
        if (!repairing) sound_player.rewind();
        // With it goes its snapshot timer: the tick counter belongs to the match that is
        // starting and the simulation still in these variables belongs to the last one, so
        // a snapshot taken between here and `build` would be the old match's state under
        // the new match's tick. `play` arms it again (#40).
        clearInterval(snapshot_timer);
        snapshot_timer = null;
        clearTimeout(limit_timer);
        limit_timer = null;
        var mine = ++starting;
        // The level is the room's, named in the settings the relay handed down, and a
        // `.dat` has to be fetched and decoded before anything can be built on it (#38).
        // A client that cannot load it stays where it is rather than playing a different
        // map: a differing ban map is a desync, not a degraded picture.
        get_level(room.settings.level).then(
            function (level) {
                if (mine === starting) build(level);
            },
            function () {
                if (mine === starting) start_failed();
            },
        );
    };

    // What a repair costs the machine least able to pay it, split three ways: building the
    // object graph, unpacking the state into it, and replaying the gap between that state
    // and now -- all of it synchronous, on a client that is already short of CPU (#70).
    function report_repair(gap, decoded, built, unpacked, caught_up) {
        console.log(
            "%s at tick %d: gap %d ticks, decode %dms, graph %dms, unpack %dms, catch-up %dms",
            repairing ? "repair" : "joined",
            room.now(),
            gap,
            Math.round(decoded),
            Math.round(built),
            Math.round(unpacked),
            Math.round(caught_up),
        );
    }

    // The one number a client can put on its own lateness, at the moment the match it
    // belongs to ends (#70). A client that is late cannot see it from the inside, so this
    // reads nothing like a problem on the machine that has one -- it is the room's other
    // clients whose counts go up.
    //
    // ponytail: it goes to the console and nowhere else, so a desync is diagnosed by asking
    // a player to paste a line. upgrade path: hand it to the relay, which is the only thing
    // that sees every client's, if a room ever needs a verdict nobody was watching for.
    function report_match() {
        var stats = room.stats();
        console.log(
            "match over at tick %d: %d frames substituted, %d of %d arrived late, " +
                "worst margin %d ticks (d %d), %d holes, late by %s",
            room.now(),
            stats.substituted,
            stats.late,
            stats.arrived,
            stats.worst_margin,
            room.d,
            // Ticks this client left its own seats no frame for, which is its own doing
            // rather than the room's -- the hole a repair digs, today (#72).
            stats.holes,
            // Every late frame, by how many ticks: the distribution a bigger d would have
            // to cover, which one worst case cannot say (#70, #71).
            Object.keys(stats.late_by)
                .sort(function (a, b) {
                    return b - a;
                })
                .map(function (margin) {
                    return margin + ":" + stats.late_by[margin];
                })
                .join(" ") || "nothing",
        );
    }

    function build(level) {
        // Three ways a match already running cannot be joined: a body that does not decode,
        // a gap too big to replay, and a match that is not running any more. The first two
        // mean this client would be playing a state it knows is wrong; the third means
        // there is nothing left to join. All three leave it in the lobby to play the next
        // match rather than half-joining this one (#40).
        //
        // The third is #124. The relay serves no resume for a match that is over
        // (`server/index.js`'s `if (!room.started || !room.snapshot) return`), so a payload
        // naming a match this client has watched end was sent before it ended -- whether it
        // crossed the `match_end` on the wire or was still fetching its level when it
        // landed. Building it anyway put the client back on the match screen of a match
        // nobody else was in, and `on_match_start` cancelled the walk to the lobby that
        // `match_end` had armed, which was the only thing left to route it out (#39). The
        // gap guard beside it cannot catch this: #84 made `gap()` return 0 past a match end
        // on purpose, so it reads 0 here and always will. A `start` that begins the next
        // match carries a higher number and is refused by none of this (#122).
        //
        // A `match_end` does not always mean the room's match is over, mind: the relay sends
        // one to a single client when it gives up repairing it (`desync` in
        // `server/index.js`), while everybody else plays on. Refusing that client a resume
        // for this match is right anyway -- it is the one the relay has stopped repairing,
        // and `resume()` returns early for it from then on -- so the number outliving the
        // session it walks back to the lobby with refuses nothing the relay would send (#41,
        // #150).
        var t0 = performance.now();
        var resumed = room.resume ? decode_snapshot(room.resume) : null;
        var gap = room.gap();
        if (room.resume && (!resumed || gap > MAX_CATCH_UP || room.match <= transport.ended_match))
            return start_failed();
        // A key tapped in the lobby has no tick to be read on yet -- it would otherwise sit
        // latched and land on this match's first tick, a spurious jump/step nobody pressed
        // just then (#86). `clear_taps`, not `release_all`: a key held into the countdown
        // is this match's real tick-0 input (a level sample, not a latch), and wiping
        // `keys_pressed` too would strand it with no keydown left to set it again --
        // including on a repair, where the player never stopped holding it.
        //
        // It is the mid-match seat boundary as well, and the only call needed for it: a
        // `Room` is handed a seat list nowhere but `start` (`room.js`'s `held = msg.held`),
        // so a seat granted while a match runs -- by the Take-seat button, or off the
        // waitlist -- is driven no earlier than the `start` that answers the resume it asks
        // for, which is this build. A spectator's stray keypress therefore cannot reach the
        // bunny it is handed (#119, #42).
        //
        // The invariant to keep is "cleared exactly when the seat becomes drivable", not
        // "cleared on every start": the two guards above return before this line, and a
        // client that refuses the `start` drives nothing, so the latch it keeps is a latch
        // no tick will read. Moving this call above them would clear taps for a match this
        // client never joins, and moving it below the build would clear the tick-0 input.
        keyboard.clear_taps();
        var t1 = performance.now();
        // After the guards above: a `start` this client refuses to build must leave the
        // hash on the level its simulation is still running (#95).
        level_hash = checksum_ban_map(level.ban_map);
        rnd = make_rnd(room.seed);
        var settings = room.settings;

        var canvas = document.getElementById("screen");
        var img = {
            rabbits: document.getElementById("rabbits"),
            objects: document.getElementById("objects"),
            numbers: document.getElementById("numbers"),
        };

        var renderer = new Renderer(canvas, img, level);
        objects = new Objects(rnd);
        var ai = new AI();
        var animation = new Animation(renderer, img, objects, rnd);
        sfx = new Sfx(sound_player, room.replaying);
        var movement = new Movement(sfx, objects, settings, rnd);
        game = new Game(movement, ai, animation, renderer, objects, room, level, true, rnd);
        game.on_end = function (reason) {
            show_clock();
            clearTimeout(limit_timer);
            limit_timer = null;
            if (config.local) return void (self.on_limit && self.on_limit(reason));
            limit_timer = setTimeout(function () {
                limit_timer = null;
                if (self.on_limit) self.on_limit(reason);
            }, SETTLE_MS);
        };

        // The host's state, and every input frame the relay rang since it, replace the
        // tick-0 simulation just built, and the gap between the two is replayed at once.
        if (resumed) {
            var t2 = performance.now();
            var packed_t = unpack_snapshot(resumed, rnd, objects);
            // Two numbers for one tick: the packed state carries the tick it was taken on,
            // and the relay carried the same tick in plaintext beside the body because it
            // never decodes one (#12). Until now the packed one was read out of the buffer
            // and thrown away, so a body and a tick from different moments would have
            // replayed the gap from the wrong end of it with nothing to say so (#92).
            //
            // ponytail: reported and then played anyway -- nobody has ever seen one, and
            // refusing would put a client out of a match over a log line. upgrade path:
            // refuse the payload, the way a body that will not decode is refused above, if
            // one ever turns up.
            if (packed_t !== room.now())
                console.log("snapshot packed at tick %d arrived as tick %d", packed_t, room.now());
            // Hundreds of ticks of history must not replay as a burst of deaths and
            // splashes, so the catch-up is silent and `play` is what un-mutes it (#28).
            sound_player.set_muted(true);
            var t3 = performance.now();
            room.catch_up(game.step);
            report_repair(gap, t1 - t0, t2 - t1, t3 - t2, performance.now() - t3);
        }

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

    // The host's simulation, packed and handed to the relay every two seconds: it is the
    // reference state by definition, so this is read live and a migrated host starts
    // sending them the moment it holds the room (#40, #19). A local room has nobody to
    // join it and nothing to resync, so it sends none (#16).
    //
    // The oldest state in the ring and not the live one, which may still be rewound: a joiner
    // seeded from a guess would be the only client in the room playing it (#141).
    // ponytail: the board beside it is the live one, up to a second newer than the body, and
    // only read when a host leaves without announcing an end. upgrade path: pack the matrix
    // out of the saved state if that second ever shows on a board.
    function push_snapshot() {
        if (!game || config.local || !config.host()) return;
        var at = room.settled();
        if (at) room.send_snapshot(at.t, bump_matrix(), encode_snapshot(at.saved.state));
    }

    // Asks the relay for the match in progress: the host's snapshot, the frames since it
    // and the settings block, which arrive as a `start` like any other (#40).
    this.resume = function () {
        room.request_resume();
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

    // The chrome over the match: the clock and whether this client has fallen behind. Both
    // are sampled on a wall clock rather than on a tick, because nothing in the loop knows
    // either of them is there.
    function sample_chrome() {
        show_clock();
        self.reconnecting(Date.now() - repaired_at < RECONNECTING_MS || room.gap() > BEHIND_TICKS);
        // Written only on a change: a fresh array is a change to Knockout every time.
        var lost = self.in_match ? room.ai_seats() : [];
        if (lost.join() !== self.ai_seats().join()) self.ai_seats(lost);
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
        if (!clock_timer) clock_timer = setInterval(sample_chrome, 250);
        // On a wall clock, so it lands between ticks: the pump steps its whole catch-up
        // batch synchronously, and a state packed halfway through one is a state no tick
        // ever had.
        if (!snapshot_timer) snapshot_timer = setInterval(push_snapshot, SNAPSHOT_MS);
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
        if (!game) return;
        // A local board pauses the sim (`show_board` above): no tick runs while it is up,
        // so a tap on it would otherwise latch and land on the tick that unpauses (#86).
        keyboard.clear_taps();
        play();
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
        clearInterval(snapshot_timer);
        snapshot_timer = null;
        clearTimeout(limit_timer);
        limit_timer = null;
        self.clock(null);
        self.ai_seats([]);
        // Counted here, because the lobby reads this board the moment the match is left and
        // the overlay's own refresh is the only other thing that ever fills it: leaving a
        // match nobody pressed P on handed the lobby the empty matrix this starts life as,
        // which draws two rows of one cell instead of the grid (#13, #37).
        if (game) {
            snapshot();
            report_match();
        }
        // The match is over for this client, so its music is over with it: muting used to
        // ride along with the board, and the board stopped pausing anything (#37).
        sound_player.set_muted(true);
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

    // Alt-tab with right held and the browser never sends the keyup: the map stays pressed,
    // and `Room.step` re-reads it and re-stamps it 60 times a second, so the bunny runs
    // right forever on every client in the room and not just this one (#85). Both events,
    // because neither covers the other: switching applications blurs a window whose tab
    // Chrome still calls visible, and a phone backgrounding the browser can hide it without
    // a blur anybody promises.
    // Assigned rather than added, exactly like the key handlers above: a session is built on
    // every entry to the lobby and again on every reconnect, and `addEventListener` would
    // pile one listener per session onto keyboards that are already gone.
    window.onblur = keyboard.release_all;
    document.onvisibilitychange = keyboard.release_all;
}

// Shared with the flow screens, which have text fields of their own (#35).
export function is_typing(evt) {
    var element = evt.target;
    return (
        !!element &&
        (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable)
    );
}
