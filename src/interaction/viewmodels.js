import { create_default_level } from "../asset_data/default_levelmap.js";
import { Dat_Level_Loader } from "../resource_loading/dat_level_loader.js";
import { Game_Session, Game_State, is_typing } from "../interaction/game_session.js";
import { Scores_ViewModel, match_result, BUNNY_NAMES } from "../interaction/scores_viewmodel.js";
import { screen_of, FLOW_TEXT, waiting_for } from "../interaction/router.js";
import { jump_scheme } from "../game/keyboard.js";
import { Loopback_Transport } from "../net/loopback_transport.js";
import { WebSocket_Transport } from "../net/websocket_transport.js";
import { normalise_room_id } from "../net/room_id.js";
import { FLAGS, LEVELS, LIMITS, config_diff, default_config } from "../net/room_config.js";
import ko from "knockout";

// There is no query-param configuration path any more, and that is a correctness
// requirement rather than a tidy-up: a `?nogore=1` one client had and another did not
// desynced the RNG stream on the first kill (#5). Settings belong to the room, the host
// configures them, and the relay hands the whole object down on `start` (#38).

// Same origin as the page it was served from, so there is no host to configure and no
// second certificate: wss:// off https://, ws:// off http:// (#11, #34).
function relay_url() {
    return (
        (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host + "/ws"
    );
}

// The four control schemes, labelled as the names screen labels them; the index is the
// scheme (#32).
var SCHEME_NAMES = ["Arrows", "A D W", "NumPad 4 6 8", "J L I"];
var CODE_HINT = "A code is 5 letters, no I and no O.";
// Nobody holds a seat, so nobody is keeping the room waiting: an AI-filled seat is ready
// by definition (#37).
var ALL_READY = [true, true, true, true];
// The settings panel's own wording. The relay validates the keys and never renders them,
// so the labels live here and nowhere near the wire (#38).
var LABELS = {
    level: "Level",
    ai_fill: "AI on the empty seats",
    pogostick: "Pogo stick",
    jetpack: "Jetpack",
    bunnies_in_space: "Bunnies in space",
    flies_enabled: "Lord of the flies",
    blood_is_thicker_than_water: "Blood is thicker than water",
    no_gore: "No gore",
    bump_limit: "Bumps to win",
    time_limit: "Minutes",
};
// A `.dat` loaded from disk. It is not in `LEVELS`, so it never survives the shared
// validator and never reaches a relay: a level nobody else can fetch belongs to a local
// room alone (#16, #38).
var CUSTOM = "a file of your own";

// The token is the relay's to mint; this only remembers it, keyed by room id, so a reload
// reclaims every seat this client held (#7). `sessionStorage` survives a refresh and dies
// with the tab, which is the disconnect worth serving. The schemes ride along because they
// are client-local: which keyboard drives which of this client's seats is nobody else's
// business, and the relay never hears about it.
function remember(id, identity) {
    try {
        // Merged rather than overwritten: the token arrives on the handshake and the
        // schemes when the seats are asked for, and neither knows about the other.
        sessionStorage.setItem("jnb:" + id, JSON.stringify(Object.assign(recall(id), identity)));
    } catch (e) {
        // ponytail: a browser with storage refused cannot reclaim a seat, and is told
        // nothing about it -- which is the pre-#36 behaviour. upgrade path: say so on the
        // lobby screen if anybody ever reports it.
    }
}
function recall(id) {
    try {
        return JSON.parse(sessionStorage.getItem("jnb:" + id)) || {};
    } catch (e) {
        return {};
    }
}

// Stamped into the bundle by webpack at build time, and "dev" when `src/` is run straight
// from node -- which no relay is ever handed, because nothing there opens a socket.
var BUILD = (typeof process !== "undefined" && process.env && process.env.JNB_BUILD) || "dev";

function ViewModel() {
    "use strict";
    var self = this;
    var loader = new Dat_Level_Loader();
    // The promise for every level loaded by name: the room config names a level, and
    // resolving that name is each client's own business (#38).
    var levels = {};

    // Offline play is a room of one over a transport that never opens a socket; an online
    // room is the same room over a WebSocket (#16, #33). The transport outlives the
    // session, so a second match reuses the socket rather than rejoining.
    var transport = new Loopback_Transport();
    var host = true;
    // Whether this client has already asked to be let into the match that is running, and
    // which seats it was in that match with -- empty for a match it has not been in. Both
    // are the room's match rather than this session's, because a session is rebuilt every
    // time this client walks between the lobby and the match, and neither question is
    // answered by the one it happens to hold.
    var resuming = false;
    var in_match_with = "";
    // How long the ask is given before it is called a failure. The relay answers on the
    // host's next snapshot, which is two seconds away at worst, and the level was preloaded
    // in the lobby -- so past this it is an answer that is not coming rather than a slow one.
    var RESUME_MS = 5000;
    var resume_timer = null;
    // The room id this client has already spent its no-password attempt on, so Back onto
    // the same link does not open a second socket to be refused by the same room.
    var attempted_id = null;
    // Whether the id being joined came from a Browse row the list said was unlocked, which
    // is the one case where a refused join means "gone" and not "wrong password" (#43).
    var browsed = false;
    // Whether the names screen is being walked on the way to a Quick Join, which asks for
    // names first: the relay cannot pick a room that fits this client without knowing how
    // many seats it needs (#44).
    var quick = false;
    // Granted by the relay, never assumed: the seats this client holds, in the order it
    // holds them, which is the order its control schemes bind in (#7).
    var granted = ko.observableArray([]);
    var token = null;
    // The reconnect (#42). A socket that dies under a live room does not end the match: the
    // seats stay reserved for this client's token, so the page freezes what it was playing
    // and spends that window asking for them back. `reserve` is how long the relay says the
    // window is, which arrives on the handshake -- guessing at it would either give up on a
    // seat still being held or retry into one somebody else already has.
    // ponytail: 60s until the handshake says otherwise, which is the relay's own default --
    // a client that retried past a shorter window would be asking for a seat somebody else
    // already has. upgrade path: none needed while both numbers are read from one place.
    var reserve = 60000;
    var reconnect_timer = null;
    var reconnect_attempt = 0;
    var reconnect_until = 0;

    this.screen = ko.observable("landing");
    this.code = ko.observable("");
    this.listed = ko.observable(false);
    this.rooms = ko.observableArray([]);
    // A failed fetch and an empty list are the same empty array otherwise, so which one it
    // was is remembered rather than inferred (#88). Its own observable, not `error`: Browse
    // deliberately keeps a refused join's message across a refresh (#43), and a refresh
    // that works has to clear this one without clearing that one.
    this.rooms_error = ko.observable("");
    this.queued = ko.observable(false);
    this.password = ko.observable("");
    this.error = ko.observable("");
    // A connection attempt in flight, which is all three submit buttons' enabled state:
    // nothing visibly changed on the first click, so the player clicked again and got a
    // second socket (#89).
    this.connecting = ko.observable(false);
    this.room_id = ko.observable(null);
    this.pending_id = ko.observable(null);
    this.is_host = ko.observable(true);
    // The seat the room says its host is on, or null in a local room, which has no relay
    // to ask and no host to wait for.
    this.host_seat = ko.observable(null);
    this.participants = ko.observableArray([]);
    // Every seat in the room, by the username of the participant on it -- null for a seat
    // nobody holds, which is the AI's (#36).
    this.seat_names = ko.observableArray([null, null, null, null]);
    // What the board calls each seat: the last username on it, said the way the room sees
    // it now -- `Alice`, `Alice (AI)` or `Alice (left)`. The board is seat-keyed, so a seat
    // keeps its column and its bumps whoever is driving it, and a seat nobody ever took
    // keeps its bunny's name (#13, #39). Empty in a local room, which has no relay to
    // remember anything for it.
    this.seat_labels = ko.observableArray([]);
    // The room's own answer, refreshed on every update: a match that ended, or a host that
    // left and took its announcement with it, must not leave this standing (#36).
    this.match_running = ko.observable(false);
    // Ready is per client and covers every seat it holds: `ready` is this client's own
    // answer, `seat_ready` is the room's, seat by seat, and an AI-filled seat is ready by
    // definition (#7, #37).
    this.ready = ko.observable(false);
    this.seat_ready = ko.observableArray(ALL_READY);
    // Whole seconds left of the host's countdown, or null when none is running.
    this.countdown = ko.observable(null);
    this.current_game = ko.observable(null);
    this.board = ko.observable(null);
    // Why the last match ended, which is what the line above the board says. It belongs to
    // the board and is set with it.
    this.board_reason = ko.observable(null);
    this.loading_level = ko.observable(false);
    // The config the next match runs on, and what the host has staged on top of it. Both
    // are the room's answer online; a local room keeps its own here, because there is no
    // relay under it to hold one (#16, #38).
    this.config = ko.observable(default_config());
    this.staged = ko.observable(null);
    this.notice = ko.observable("");
    this.new_password = ko.observable("");
    // A `.dat` loaded from disk, and the picker's options. `CUSTOM` is offered only in a
    // local room and only once one is loaded: it is not a level any other client could
    // fetch, so an online picker must not offer one the relay is bound to refuse (#38).
    this.custom_level = ko.observable(null);
    this.level_names = ko.computed(function () {
        return !self.room_id() && self.custom_level() ? LEVELS.concat(CUSTOM) : LEVELS;
    });
    this.flag_rows = FLAGS.map(function (flag) {
        return { key: flag, label: LABELS[flag] };
    });
    // One observable per config key, which is what the form edits. Nothing is sent until
    // Apply: a half-typed panel is not a staged change (#38).
    this.form = {};
    FLAGS.concat("level", "ai_fill", Object.keys(LIMITS)).forEach(function (key) {
        self.form[key] = ko.observable(default_config()[key]);
    });

    // The board is not a screen of the flow and not a phase of the room: it is this
    // client's own, drawn over a simulation that keeps running in a networked room and
    // really does stop in a local one (#21, #37).
    this.board_up = ko.computed(function () {
        var game = self.current_game();
        return !!game && game.game_state() === Game_State.Board;
    });
    // Said over the match rather than instead of it: the simulation is still running, still
    // drawn and still this client's to steer -- it is just behind the room, and being
    // repaired (#41, #17).
    this.reconnecting = ko.computed(function () {
        var game = self.current_game();
        return !!game && game.reconnecting();
    });
    // The socket is gone and the seat is being asked for back (#42). Louder than the line
    // above, and said over the lobby as well as over the match, because the room a client
    // cannot reach is a room it cannot do anything in either.
    this.disconnected = ko.observable(false);
    // One line for both, because there is one place to put it: a client being repaired is
    // still playing the room's match, and one whose socket died is not.
    this.connection_text = ko.computed(function () {
        if (self.disconnected()) return "Connection lost. Reconnecting\u2026";
        return self.reconnecting() ? "Reconnecting\u2026" : "";
    });
    // Over the match, like the line above: the relay gave this client's bunny to the AI, and
    // from the inside that reads as a dead keyboard (#76). The line is the way back. Hidden
    // while the socket is down, because the reconnect already asks for the seat back.
    this.ai_text = ko.computed(function () {
        var game = self.current_game();
        if (!game || self.disconnected()) return "";
        // The participant's own name: the room's label would add "(AI)", which is the news.
        var lost = game.ai_seats().map(function (seat) {
            return self.seat_names()[seat];
        });
        if (!lost.length) return "";
        return (
            "The AI is driving " +
            lost.join(" and ") +
            (lost.length > 1 ? ". Take them back" : ". Take it back")
        );
    });

    // Derived from the relay's deadline and this client's clock, never from a count of
    // frames: a hidden tab stops its game loop but not its clock (#51). The ticker runs
    // only while there is a countdown to tick.
    var deadline = null;
    var ticker = null;
    function show_countdown() {
        self.countdown(deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null);
        if (deadline && !ticker) ticker = setInterval(show_countdown, 200);
        if (!deadline && ticker) {
            clearInterval(ticker);
            ticker = null;
        }
    }

    // The room names a level and every client resolves that name for itself, by fetching
    // the `.dat` the relay already serves beside the page -- same origin, so there is no
    // second host and nothing to configure (#34, #38). Cached as promises, so a rematch on
    // the same level refetches nothing.
    function unavailable(name) {
        // Refused, never quietly swapped for the built-in map: a client left on a stale
        // bundle would otherwise play a different ban map from everyone else, and that is
        // a desync rather than a worse picture.
        self.error("This client does not have that level. Reload the page.");
        return Promise.reject(new Error("unknown level: " + name));
    }

    function get_level(name) {
        if (name === CUSTOM)
            return self.custom_level() ? Promise.resolve(self.custom_level()) : unavailable(name);
        if (name === "default") return Promise.resolve(create_default_level());
        if (LEVELS.indexOf(name) < 0) return unavailable(name);
        if (!levels[name])
            levels[name] = fetch("levels/" + name + "/" + name + ".dat")
                .then(function (response) {
                    if (!response.ok) throw new Error(name + ": " + response.status);
                    return response.blob();
                })
                .then(function (blob) {
                    return loader.read(blob);
                })
                .catch(function (err) {
                    // Not remembered as a failure: it is worth another try next match.
                    // And this client stays in the lobby rather than playing the default
                    // map instead -- a differing ban map is a desync, not a worse picture.
                    delete levels[name];
                    self.error("That level would not load. Ask the host for another one.");
                    throw err;
                });
        return levels[name];
    }

    // Fetched the moment the room names it, not when the match starts. A lockstep room
    // cannot wait for one client's download: every other client would step past the ticks
    // it was loading through, fill its seat with released keys and never hear its real
    // frames -- which is a desync, not a stutter. Staging is what buys the time to do this
    // in: the level is named in the lobby and applied a match later (#38).
    // ponytail: a cold cache and an instant start still race. The loser keeps its seat --
    // the relay covers a client that has not sent a first frame yet rather than handing its
    // bunny to the AI (#42) -- but it simulates the ticks it loaded through off its own
    // inputs while the room used the released frames the relay rang, so it desyncs and is
    // repaired (#41). upgrade path: hold `start` until every client says it has the level.
    var preloaded = null;
    function preload() {
        var named = Object.assign({}, self.config(), self.staged()).level;
        // Once per name, because this runs on every room update -- a seat taken, a ready
        // toggled -- and a level that will not load must not be refetched on each of them.
        // The match start asks again anyway, which is the retry.
        if (named === preloaded) return;
        preloaded = named;
        get_level(named).catch(function () {});
    }

    // The form mirrors the config the next match will run on: what is applied, with what
    // the host has staged on top. Refilled only when that answer really changes, so a room
    // update caused by somebody taking a seat does not discard a half-edited panel.
    var form_shows = "";
    function fill_form() {
        var effective = Object.assign({}, self.config(), self.staged());
        if (JSON.stringify(effective) === form_shows) return;
        form_shows = JSON.stringify(effective);
        Object.keys(self.form).forEach(function (key) {
            self.form[key](effective[key]);
        });
    }
    function read_form() {
        var wanted = {};
        Object.keys(self.form).forEach(function (key) {
            wanted[key] = self.form[key]();
        });
        return wanted;
    }

    // The staged banner names the diff *and* what it did, because cleared ready checkboxes
    // on their own read as a bug rather than as a consequence (#10, #38).
    this.staged_text = ko.computed(function () {
        var staged = self.staged();
        if (!staged) return "";
        return (
            "Host staged: " +
            Object.keys(staged)
                .map(function (key) {
                    var value = staged[key];
                    var shown = typeof value === "boolean" ? (value ? "on" : "off") : String(value);
                    return LABELS[key] + " \u2192 " + shown;
                })
                .join(", ") +
            "."
        );
    });

    this.code_chars = ko.computed(function () {
        return (self.pending_id() || "").split("");
    });
    this.scheme_name = function (scheme) {
        return SCHEME_NAMES[scheme];
    };
    // Once the relay has granted the seats, the names on them are the room's: a client's
    // count is fixed and a rename would need a second collision check nobody asked for
    // (#7, #14). The names screen says so rather than accepting edits it would discard.
    // A match is running and this client holds seats in it, but is sitting in the lobby
    // watching: it walked out, or it was in the room before the match began. Either way the
    // way back in is a button rather than nothing at all, because leaving the room and
    // following the link again used to be the only one there was (#42).
    this.can_rejoin = ko.computed(function () {
        return !!self.room_id() && self.match_running() && granted().length > 0;
    });

    this.seated = ko.computed(function () {
        return granted().length > 0;
    });

    // The room's own seat table, so the board names every participant and not only the ones
    // on this keyboard; a seat nobody holds keeps its bunny's name (#13, #36).
    function display_names() {
        return BUNNY_NAMES.map(function (bunny, seat) {
            return self.seat_labels()[seat] || self.seat_names()[seat] || bunny;
        });
    }

    // The lobby shows all four seats, whoever is on them: the username, the bunny, and the
    // control scheme for the seats this keyboard drives (#13, #36).
    this.seat_rows = ko.computed(function () {
        return BUNNY_NAMES.map(function (bunny, seat) {
            var mine = self.participants()[granted().indexOf(seat)];
            return {
                seat: seat,
                name: self.seat_names()[seat] || "AI",
                bunny: bunny,
                scheme: mine ? SCHEME_NAMES[mine.scheme] : "",
                ready: self.seat_ready()[seat] !== false,
                // A seat nobody holds is the AI's, and an AI bunny is not a participant:
                // anybody already in the room can sit down on it, in either phase (#42).
                // A local room has no relay to ask, and its seats are the couch's.
                takeable: !!self.room_id() && !self.seat_names()[seat],
                // Which keys it will answer to, on the button rather than in the row it
                // grows: one keyboard cannot drive two bunnies with the same three keys,
                // and a bunny that ignores the arrows you already hold reads as broken
                // rather than as a second player (#7, #32).
                take_label: "Take seat (" + SCHEME_NAMES[free_scheme()] + ")",
            };
        });
    });

    // Who the lobby is waiting on, by the name the room knows them under -- not the
    // board's label, which would read "Zip (AI) to start" for a host whose socket is out
    // (#88).
    this.waiting_text = ko.computed(function () {
        var seat = self.host_seat();
        return waiting_for(seat == null ? null : self.seat_names()[seat]);
    });

    // The live match's board while one is up, and the board of the last match once it is
    // over: the lobby's session has not been played, so its zeroes are not the answer.
    this.scores_viewmodel = ko.computed(function () {
        var game = self.current_game();
        var played = game && game.game_state() !== Game_State.Not_Started;
        return new Scores_ViewModel(
            (played ? game.scores() : self.board()) || [[]],
            display_names(),
        );
    });

    // One line above the board: who won, or who ended it. A draw is joint winners (#39).
    this.result_text = ko.computed(function () {
        return match_result(self.board(), display_names(), self.board_reason());
    });

    // The match clock and the target, in the top bar rather than on the canvas: chrome
    // costs the wire nothing and the picture nothing (#39). `0` is endless, so there is
    // nothing to say about it.
    this.clock = ko.computed(function () {
        var game = self.current_game();
        return (game && game.clock()) || "";
    });
    this.to_win = ko.computed(function () {
        var limit = self.config().bump_limit;
        return limit ? limit + " to win" : "";
    });

    this.join_link = ko.computed(function () {
        // The bare fragment is the only link this app generates: it stays out of the
        // relay's HTTP logs and out of Referer (#8).
        return self.room_id()
            ? window.location.origin + window.location.pathname + "#" + self.room_id()
            : "";
    });

    // The message a screen change takes with it. Six FLOW_TEXT failures are set on the route
    // *before* the screen that shows them, so this is how `apply_route` tells one of those
    // from an error left over from a route that is already over (#127).
    var carried = "";

    function go(hash, replace) {
        carried = self.error();
        // Navigating to the screen you are already on fires no `hashchange`, so the route
        // has to be applied by hand: a reload lands on `#room`, and the rejoin that follows
        // it would otherwise never build the session the next `start` arrives on.
        if (window.location.hash === "#" + hash) return apply_route();
        // `replace` for a redirect the flow makes on your behalf, so Back skips the screen
        // you were only passing through.
        if (replace) window.location.replace("#" + hash);
        else window.location.hash = hash;
    }

    function leave_room() {
        // Whatever this client was trying to get back into, it is not this room any more.
        clearTimeout(reconnect_timer);
        reconnect_timer = null;
        self.disconnected(false);
        // The last match's frozen frame is held for two seconds before the lobby replaces
        // it, and leaving outranks that hold exactly as starting the next match does: the
        // room is gone, so a `go("room")` two seconds late would route a client that has
        // already walked away -- onto the names screen, because this clears the couch and
        // the remembered room id on the way out (#39).
        clearTimeout(leaving);
        leaving = null;
        // A deliberate Leave frees the seats now; only a dropped connection reserves them
        // for a reload (#17). The relay cannot tell the two apart without being told.
        if (self.room_id() && transport.send) transport.send({ type: "leave" });
        if (transport.close) transport.close();
        if (pending) pending.close();
        pending = null;
        self.connecting(false);
        transport = new Loopback_Transport();
        host = true;
        self.is_host(true);
        self.room_id(null);
        self.pending_id(null);
        self.password("");
        attempted_id = null;
        // A client's seat count is fixed for the room's lifetime, so the next room is named
        // from scratch rather than inheriting this one's couch (#14).
        self.participants([]);
        self.seat_names([null, null, null, null]);
        self.seat_labels([]);
        // The board belongs to the room's last match, and the room died with the last
        // client in it: a room created on the same id later is a different room.
        self.board(null);
        self.board_reason(null);
        self.ready(false);
        self.seat_ready(ALL_READY);
        // The config belonged to the room, so it goes with it: the next room's arrives on
        // its handshake, and a local room starts from the defaults (#38).
        self.config(default_config());
        self.staged(null);
        self.notice("");
        self.new_password("");
        // Forgotten, not merely recomputed: an edit the host never applied belonged to the
        // room it was typed in, and the next room may happen to have the same config.
        form_shows = "";
        fill_form();
        deadline = null;
        show_countdown();
        granted([]);
        token = null;
        // The match in progress belonged to the room, so the next one is asked about from
        // scratch (#40).
        stop_resuming();
        in_match_with = "";
        remember("room", { id: null });
    }

    // The frozen last frame, held for a moment before the lobby replaces it: the match
    // stopped on the tick the whole room agreed on, and how long this client looks at it
    // afterwards is nobody else's business (#39).
    var HOLD_MS = 2000;
    var leaving = null;
    function to_lobby_soon() {
        // Only from the match itself. A client that watched it from the lobby is already
        // there and wants the board now, not in two seconds.
        if (self.screen() !== "play") return go("room");
        clearTimeout(leaving);
        leaving = setTimeout(function () {
            leaving = null;
            go("room");
        }, HOLD_MS);
    }

    // Why the match this client is leaving ended, and the board the host counted for it,
    // from the `match_end` it left on.
    var ended_because = null;
    var announced_board = null;

    // The host's board is another client's input, and the relay cannot check it because it
    // cannot read the simulation (#19). So it is taken only when it really is the matrix:
    // four seats by four seats, numbers throughout, or this client's own count instead.
    function is_matrix(matrix) {
        return (
            Array.isArray(matrix) &&
            matrix.length === BUNNY_NAMES.length &&
            matrix.every(function (row) {
                return (
                    Array.isArray(row) &&
                    row.length === BUNNY_NAMES.length &&
                    row.every(function (count) {
                        return typeof count === "number" && isFinite(count) && count >= 0;
                    })
                );
            })
        );
    }

    function end_match() {
        var game = self.current_game();
        // Only the host ends the match for everyone; anybody else is just leaving it, and
        // their seat goes quiet until the next one (#22). Said here, not on the button:
        // browser Back is the same way out of a match, and used to just tear the session
        // down while the relay went on believing it was running (#87).
        // `game_state() !== Not_Started` guards the window before `build()`: a connected
        // host parked in `start_when_ready` who Backs `#play` -> `#room` here would
        // otherwise announce nothing and strand the match for everyone else, same as the
        // hole this fixes -- microtask-wide in practice, and backstopped by the relay's own
        // `host_left` if the socket goes instead.
        // Above the read below, not beside the button: a local room echoes the announcement
        // back synchronously, and that echo is what names the reason and carries the board.
        if (game && game.in_match && host && game.game_state() !== Game_State.Not_Started)
            game.announce_end("lobby");
        // Read once and forgotten here, before the guard: the reason and the board belong
        // to the match being left, and must not be waiting for the next one.
        var reason = ended_because;
        var announced = announced_board;
        ended_because = null;
        announced_board = null;
        if (!game) return;
        var played = game.game_state() !== Game_State.Not_Started;
        // One rule for every way a client stops simulating -- back to the lobby, out to the
        // landing screen, a level loaded: the seats it drove go to the AI on an agreed tick,
        // so the room sees it leave instead of watching a bunny stand still (#7, #17).
        if (played) game.release_seats();
        // Pause stopped simulating before it became an overlay; leaving the match is what
        // stops it now (#37).
        game.stop();
        // The board of the match you just left is what the lobby shows; it is not a screen
        // of its own (#13, #35). It stands until the next match starts, so the lobby you
        // walk back into still has it (#39).
        if (played) {
            self.board(announced || game.scores());
            self.board_reason(reason);
        }
        self.current_game(null);
    }

    function session() {
        if (self.current_game()) return self.current_game();
        var game = new Game_Session(
            get_level,
            {
                seed: Date.now() | 0,
                // Read at propose time, not held from here: a local room's config is
                // edited inside the lobby this session already exists in (#38).
                settings: self.config,
                // The observable rather than its value: host migrates mid-match, and the
                // snapshot the room is resynced from is whoever holds host at the time
                // (#40, #14).
                host: self.is_host,
                held: granted(),
                // Real pause survives in a local room only: there is nothing to desync
                // from, and nobody to keep waiting (#16, #37).
                local: !self.room_id(),
                // A function, not the list: taking a seat mid-match grows this client's
                // seats, and the session outlives the growth (#42).
                schemes: schemes_of,
            },
            false,
            transport,
        );
        // The host announces the end and every client honours it, so a host walking back
        // to the lobby does not leave the others playing on alone (#22, #11).
        game.on_match_end = function (msg) {
            // Read by `end_match` on the way out, which is where the board it belongs to is
            // counted: the reason and the matrix are one answer, not two.
            ended_because = msg.reason;
            announced_board = is_matrix(msg.matrix) ? msg.matrix : null;
            // A client sitting in the lobby never simulated this match and has no board of
            // its own, which is why the host's travels with the announcement (#19, #39).
            if (announced_board) {
                self.board(announced_board);
                self.board_reason(msg.reason);
            }
            to_lobby_soon();
        };
        // A limit the simulation reached. Every client stops on the same tick; the host is
        // what announces it, exactly as it announces a walk back to the lobby (#22, #39).
        game.on_limit = function (reason) {
            if (host) game.announce_end(reason);
        };
        // Whoever proposed it, the match begins for this client when `start` lands -- and
        // the session that was handed the match is the current one, whichever flow screen
        // this client happens to be sitting on. Without that, a client that had stepped
        // back to the names screen would build the match, bounce off the play route for
        // want of a current session, and rebuild a lobby session that replaces the
        // transport's listener -- orphaning the match it was already in.
        game.on_match_start = function () {
            // In it now, and with these seats, whether it was handed this match or asked to
            // be let into it: walking back to the lobby must not read as a client that
            // never played it, and taking another seat must (#42).
            in_match_with = granted().join(",");
            // Asked and answered: the next ask is a seat this client did not have when the
            // match was handed to it (#42).
            stop_resuming();
            // A match beginning outranks the last one's frozen frame: the hold must not
            // walk this client out of the match it just started.
            clearTimeout(leaving);
            leaving = null;
            // Zeroed at the next start rather than on lobby entry, which is where the last
            // match's board is read (#13, #39). A networked client that is not playing this
            // match hears the same thing from the room instead.
            self.board(null);
            self.board_reason(null);
            // A client with no seats has nothing to steer -- it was vacated at countdown
            // zero, or its seats went while it was away -- so it holds no session for this
            // match and waits in the lobby for the next one (#37; spectating is #40's).
            if (!granted().length) return;
            // Zeroed with them, and below the guard rather than beside them: a failed
            // resume's "did not work" describes a match that is over, and used to still be
            // on screen through this one and into the lobby after it. Below the guard
            // because countdown zero vacates an un-ready client and begins the match in the
            // same breath, and that client's session hears this `start` too -- clearing
            // above would wipe the `vacated` message off the names screen it just landed on
            // (#127, #37).
            self.error("");
            self.current_game(game);
            go("play");
        };
        // A `start` that never became a match: the level would not load, or the state it
        // carried could not be replayed. Both were silent, and a client that had asked to
        // be let into this one is waiting on exactly this answer, and there is no second
        // telling (#89).
        game.on_start_failed = resume_failed;
        self.current_game(game);
        // Built into a room with a match already running: this is the session that will
        // hear the answer, so this is where the asking belongs.
        ask_to_resume();
        return game;
    }

    // Asks the relay to be let into the match the room is running: the host's snapshot, the
    // frames since it and the settings block, which arrive as a `start` (#40). Once per
    // match -- the payload replaces this client's state, and a second one would replace the
    // state the first just built -- and the relay remembers an ask it cannot answer until
    // the host's next snapshot.
    //
    // Four clients ask: one that followed a link into a room mid-match, one that reloaded,
    // one whose socket died under the match (#42), and one that took a free seat while a
    // match ran -- including one already playing it, because the seat it just took is the
    // AI's until the relay hands it the match with that seat in it. A client that walked
    // back to the lobby does not: it keeps its seats and hands its bunnies to the AI (#37),
    // it left on purpose, and walking it back in is the opposite of what it asked for. The
    // two are told apart by the seats it was last in the match with, since the session that
    // knew is gone with it.
    //
    // It asks through the current session rather than building one, and a session built into
    // a room with a match running asks for itself: the ask is a message on the socket, and a
    // `start` that lands before a Room exists is a `start` nobody hears.
    function ask_to_resume() {
        var current = self.current_game();
        if (resuming || !self.match_running() || !granted().length) return;
        if (granted().join(",") === in_match_with) return;
        if (!current) return;
        resuming = true;
        resume_timer = setTimeout(resume_failed, RESUME_MS);
        current.resume();
    }

    // One place the ask stops being in flight, because the timer bounding it has to stop
    // with it: one left running would call the *next* ask a failure.
    function stop_resuming() {
        clearTimeout(resume_timer);
        resume_timer = null;
        resuming = false;
    }

    // It neither landed nor came back. `resuming` is left latched rather than cleared:
    // `apply_room` calls `ask_to_resume` on every room broadcast (a seat taken, ready
    // toggled, countdown, host migration), and clearing it here would re-arm this timer
    // and re-show this error on each one. Only `rejoin_match` re-opens it (#89).
    function resume_failed() {
        if (!resuming) return;
        // A level that would not load already said so (viewmodels.js's own `get_level`
        // catch) -- more specific than this, and "try again" is wrong advice on it, since a
        // retry refetches the same broken level.
        if (!self.error()) self.error("Getting back into the match did not work. Try again.");
    }

    // The relay's picture of the room: which seats exist, who is on them, which ones this
    // client was granted, and whether it hosts. It arrives on the handshake and again on
    // every change, so joining, being seated, someone else being seated and the host
    // migrating are all one code path (#36).
    function apply_room(msg) {
        self.seat_names(msg.seats);
        self.seat_labels(msg.labels || []);
        // The board of the last match stands until the next one begins, which is where it
        // is zeroed -- not on entering the lobby, which is where it is read (#13, #39).
        if (msg.started && !self.match_running()) {
            self.board(null);
            self.board_reason(null);
            // The last match's announcement goes with its board: the ready it was about
            // has been pressed again by now.
            self.notice("");
        }
        // Ready clears for everyone when a match ends, and cleared checkboxes alone read
        // as a bug rather than as the rule they are -- the same reason a staged config
        // change says so (#10, #38, #88). Gated on held seats: a queued client has no
        // Ready button to press for the next one.
        if (self.match_running() && !msg.started && msg.held.length)
            self.notice(FLOW_TEXT.ready_cleared);
        self.match_running(!!msg.started);
        // The match this client was in is over, so the next one is a match it has not been
        // in and has not asked about.
        if (!msg.started) {
            stop_resuming();
            in_match_with = "";
        }
        host = msg.host;
        self.is_host(host);
        self.host_seat(msg.host_seat);
        granted(msg.held);
        self.ready(!!msg.you_ready);
        self.seat_ready(msg.ready || ALL_READY);
        deadline = msg.countdown == null ? null : Date.now() + msg.countdown;
        show_countdown();
        // The room's config is the room's answer, refreshed on every update like the seats
        // are: a staged change, a match that applied one, and a host migrating are all the
        // same code path (#36, #38). The password is in none of them (#8).
        if (msg.config) {
            self.config(msg.config);
            self.staged(msg.staged || null);
            fill_form();
            preload();
        }
        self.queued(!!msg.queued);
        if (!msg.held.length) {
            // Waiting for a seat in a room that had none: the lobby is where it waits, and
            // the names screen is not, because the asking is done and the answer was "not
            // yet" rather than "ask again" (#44).
            if (msg.queued) {
                if (self.screen() === "names") go("room");
                return;
            }
            // Every seat gone: un-ready at countdown zero, which reserves nothing. The
            // client is still in the room, so the names screen is where it asks for seats
            // again rather than the landing page (#37, #17).
            // ponytail: names the countdown because it is the only way a seated client is
            // left holding nothing today; upgrade path is a reason on the room view if a
            // second way ever appears.
            if (
                self.participants().length &&
                (self.screen() === "room" || self.screen() === "play")
            ) {
                self.error(FLOW_TEXT.vacated);
                go("names", true);
            }
            return;
        }
        if (self.participants().length) {
            // The name everyone sees is the relay's, not the one that was typed.
            var grew = false;
            msg.held.forEach(function (seat, nth) {
                // A seat taken since the names screen: a participant this couch did not
                // have, on the first control scheme nobody here is already using (#42).
                if (!self.participants()[nth]) {
                    grew = true;
                    self.participants.push({
                        scheme: free_scheme(),
                        name: ko.observable(msg.seats[seat]),
                    });
                } else self.participants()[nth].name(msg.seats[seat]);
            });
            // So a reload binds the grown couch's keyboards back in the order the relay
            // hands the seats down in (#7).
            if (grew) remember(self.room_id(), { schemes: schemes_of() });
        } else {
            // A reload comes back with the seats but not with the keyboards: schemes are
            // client-local and bind to held seats in join order (#7).
            var schemes = recall(self.room_id()).schemes || [];
            self.participants(
                msg.held.map(function (seat, nth) {
                    return {
                        scheme: schemes[nth] == null ? nth : schemes[nth],
                        name: ko.observable(msg.seats[seat]),
                    };
                }),
            );
        }
        // The grant is what opens the lobby: the seats are the relay's to give, so the
        // names screen waits for them rather than assuming them (#14).
        if (self.screen() === "names") go("room");
        // Last in this function, because a session holds the seats and the control schemes
        // it was built with: one built before the grant above drives nothing at all.
        ask_to_resume();
    }

    // The attempt that has not answered yet. A second one supersedes it rather than racing
    // it: an abandoned socket goes on ponging the relay whether or not it is still the
    // transport, so the room it created stays up -- in the public list, with a host that
    // never leaves, and picked first by Quick Join for having four free seats (#89).
    // ponytail: short of `go_landing` (which now closes it, below), a socket that neither
    // opens nor closes leaves the buttons disabled until the browser gives up on it.
    // upgrade path: a bound of its own if anybody ever sees one -- the page is served by
    // the relay it dials, so an unreachable relay is a page that never loaded.
    var pending = null;

    function connect(entry) {
        if (pending) pending.close();
        self.connecting(true);
        self.error("");
        // Which build of the simulation this page is running. Two builds in one lockstep
        // room desync -- the same seed drawn through different code is a different match --
        // and a page nobody reloaded goes on running the build it was loaded with (#40).
        entry.build = BUILD;

        var leaving = transport;
        var socket = new WebSocket_Transport(
            relay_url(),
            entry,
            function (msg) {
                var reconnected = false;
                if (msg.type === "joined") {
                    // Belt and braces against clearing a successor's state (#89).
                    if (pending === socket) {
                        pending = null;
                        self.connecting(false);
                    }
                    // Only once the new room is in: a refused join leaves this client in the
                    // room it already had, rather than in neither.
                    if (leaving.close) leaving.close();
                    transport = socket;
                    token = msg.token;
                    // The relay's own reservation window: how long a retry is worth making,
                    // and it is a dial on the relay rather than a constant here (#42).
                    if (msg.reserve) reserve = msg.reserve;
                    reconnected = self.disconnected();
                    self.disconnected(false);
                    clearTimeout(reconnect_timer);
                    reconnect_timer = null;
                    self.room_id(msg.id);
                    self.pending_id(msg.id);
                    remember(msg.id, { token: token });
                    // The lobby's own URL is `#room`, which says nothing about which room:
                    // this is what a reload reads to find its way back to one (#36).
                    remember("room", { id: msg.id });
                    // Quick Join is granted its seats on the way in, so the schemes the
                    // names screen fixed are remembered here rather than on an ask that
                    // never happens (#44).
                    if (self.participants().length) remember(msg.id, { schemes: schemes_of() });
                } else if (transport !== socket) return;
                apply_room(msg);
                if (msg.type !== "joined") return;
                // Back in the seat, and in the match it froze in: the session is rebuilt on
                // the new socket and asks to be let back into the match, which is the ask a
                // client joining one mid-match already makes (#40, #42).
                if (reconnected && self.screen() === "play" && msg.started && msg.held.length)
                    return void session();
                // A reload lands back in the lobby, because the token brought the seats
                // back with it; a first arrival goes to the names screen to ask for some.
                go(msg.held.length ? "room" : "names", true);
            },
            function (code) {
                // Belt and braces against clearing a successor's state (#89). Before the
                // retry early return, so a reconnect attempt that fails always re-arms.
                if (pending === socket) {
                    pending = null;
                    self.connecting(false);
                }
                // A retry that did not get in -- the socket died again, or the room would
                // not have it yet -- is answered by the next retry and by nothing on
                // screen: the overlay is already up, and the window is what ends this.
                if (self.disconnected() && transport !== socket) return retry();
                if (code === "DISCONNECTED") {
                    // A live room this client still holds a seat in: the seat is reserved
                    // for its token, so the match freezes and the page spends that window
                    // getting back into it (#42).
                    if (transport === socket && self.room_id()) return lost_connection();
                    // A socket that died with no room behind it -- refused on the way in,
                    // or already left -- has nothing to reconnect into: there is no seat
                    // reserved anywhere and the landing screen is where that ends.
                    if (transport === socket) leave_room();
                    self.error(FLOW_TEXT.dropped);
                    if (self.screen() === "play" || self.screen() === "room") go("landing", true);
                } else if (code === "NAME_TAKEN") {
                    self.error("Somebody in this room already has that name.");
                } else if (code === "BAD_NAME") {
                    self.error("Every name needs 1 to 16 characters.");
                } else if (code === "OUT_OF_DATE") {
                    self.error(
                        "That room is running a different version of the game. Reload this " +
                            "page; if it still will not join, the room's host has the old one.",
                    );
                } else if (code === "SEAT_TAKEN") {
                    // Somebody else sat down first, or its holder is on the way back: a
                    // reservation belongs to one token until it expires (#42).
                    self.error("That seat is not free.");
                } else if (code === "SERVER_FULL") {
                    // The two refusals of a new room, Quick Join's as much as Create's, so
                    // both come before the create branch rather than inside it (#157).
                    self.error(
                        "The server is full right now. You can still join a room that is " +
                            "already open.",
                    );
                } else if (code === "TOO_MANY_ROOMS") {
                    self.error(
                        "Too many rooms are open from your network. Try again when one ends.",
                    );
                } else if (entry.type === "create") {
                    self.error(code === "ID_TAKEN" ? "That code is taken." : CODE_HINT);
                } else if (self.screen() === "room" || self.screen() === "play") {
                    // A reload into a room that will not have it back -- ended, or a
                    // password gained while this client was away, one relay code for both
                    // (#8). Either way there is nothing to reclaim.
                    self.error(FLOW_TEXT.room_gone);
                    go("landing", true);
                } else if (self.screen() === "password") {
                    self.error(FLOW_TEXT.unavailable);
                } else if (browsed) {
                    // The list said this room had no password, so a refusal can only mean
                    // it is gone: a password screen for a password that does not exist is
                    // the wrong place to land. A locked row still lands there, because
                    // there a dead room and a wrong password stay indistinguishable (#8).
                    browsed = false;
                    self.error(FLOW_TEXT.unavailable);
                    go("browse", true);
                } else {
                    // Which of the two it was is exactly what is not said, but that it was
                    // refused is: the password screen is where both answers land, and
                    // silence there reads as a locked room rather than a guess at whether
                    // one exists (#8, #88). No password has been typed yet here, so the
                    // sentence cannot claim the room is gone -- the commonest reason to
                    // land here is a locked room that opens on the very next screen.
                    self.error(FLOW_TEXT.not_accepted);
                    go("password", true);
                }
            },
        );
        pending = socket;
    }

    // 1, 2, 4 and then 5 seconds apart, and it gives up when the reservation window the
    // relay named runs out: past that the seats are free to anyone, so there is nothing
    // left to come back to (#42).
    function retry() {
        clearTimeout(reconnect_timer);
        if (Date.now() >= reconnect_until) return give_up();
        var wait = Math.min(5000, 1000 * Math.pow(2, reconnect_attempt++));
        reconnect_timer = setTimeout(function () {
            // Checked again on the way out, not only on the way in: a wait armed just inside
            // the window lands outside it, and the seats are anybody's by then.
            if (Date.now() >= reconnect_until) return give_up();
            connect({
                type: "join",
                id: self.room_id(),
                password: self.password(),
                token: recall(self.room_id()).token,
            });
        }, wait);
    }

    function give_up() {
        leave_room();
        // Not "the connection dropped": the retries ran the whole reservation window out,
        // and what the player lost is the seats (#42).
        self.error(FLOW_TEXT.gave_up);
        go("landing", true);
    }

    // The socket under a live room died. The match freezes where it is rather than
    // simulating into divergence -- every other seat would read as keys released and every
    // frame would go into a closed socket, which is not the room's match any more (#41
    // found it, #42 owns it) -- and the page says so and starts asking for the seat back.
    function lost_connection() {
        self.disconnected(true);
        reconnect_attempt = 0;
        reconnect_until = Date.now() + reserve;
        var game = self.current_game();
        if (game) game.stop();
        self.current_game(null);
        // The match is the room's, and this client is being let back into it rather than
        // one it remembers having played and must not be walked back into (#40).
        stop_resuming();
        in_match_with = "";
        retry();
    }

    function enter(id) {
        self.pending_id(id);
        self.code(id);
        if (self.room_id() === id) return go("room", true);
        if (attempted_id === id) return go("password", true);
        attempted_id = id;
        connect({ type: "join", id: id, token: recall(id).token });
    }

    // A reload, or a Forward into a screen the flow has not walked to, arrives with none
    // of the state that screen is about: no participants, and no room to rejoin, since the
    // only thing that survives a reload is the hash. Each of those falls back one step
    // rather than rendering a screen with nothing behind it (#42 is what would change it).

    // Focus follows the screen, or a keyboard player tabs down from the top of the page after
    // every transition (#90). No table of screens: the panes are in document order and
    // Knockout hides the ones it is not showing, so the first control still laid out belongs
    // to the screen just routed to. A pane with a `tabindex` of its own is taken instead of
    // its first control -- the names screen's form *is* the keyboard, and `is_typing`
    // (game_session.js:511) would swallow the jump keys into a focused text box. The match
    // screen has no control inside a `.kiosk`, so this is a no-op there, which is what the
    // issue's "in-game controls are out of scope" asks for.
    function focus_screen() {
        // Only when focus has nowhere to be. The screen that went took its control's focus
        // with it, so this is the transition case; a route onto the screen already showing
        // (`go("room")` from a match that ended) must not steal the box somebody is typing in.
        // `checkVisibility()`, not `offsetParent`: a closed `<details>` keeps an offset parent
        // in Chromium (`content-visibility: hidden`) but fails this check, so a route that
        // lands the loop on a control inside the collapsed room settings does not silently
        // leave focus on `<body>`.
        var here = document.activeElement;
        if (here && here !== document.body && here.checkVisibility()) return;
        var targets = document.querySelectorAll(
            ".kiosk[tabindex], .kiosk input, .kiosk select, .kiosk button",
        );
        for (var i = 0; i < targets.length; i++)
            if (targets[i].checkVisibility() && !targets[i].matches(":disabled"))
                return targets[i].focus();
    }

    function apply_route() {
        var route = screen_of(window.location.hash);
        if (route.screen !== "play") end_match();
        if (route.screen === "landing" || route.screen === "browse") leave_room();
        // A room-code hash is a join route, not one of the two screen names above, so
        // following somebody else's link while seated used to leave the old room holding an
        // empty bunny for the whole reservation window (#87). `self.room_id()` keeps a cold
        // load off this path -- it holds no relay seat and needs no leave -- and `!==` keeps
        // re-following your own link the no-op `enter()` already makes of it.
        if (route.room_id && self.room_id() && route.room_id !== self.room_id()) leave_room();
        self.screen(route.screen);
        // Six FLOW_TEXT messages (dropped/room_gone/gave_up -> landing, vacated -> names,
        // both unavailable/not_accepted refusals -> browse/password) are set one route
        // before this line, so their `role="alert"`/`role="status"` region is still
        // `display: none` when the text lands -- measured in reload_into_a_dead_room():
        // `offsetParent` is false at the exact moment `room_gone` writes. Re-touching the
        // observable now that the pane is up re-fires the live region -- but only for the
        // message this navigation carried, so an unrelated route no longer re-announces an
        // error that did not change.
        // Anything else on screen belongs to the route it was set on, and that route is
        // over: the buttons out of an error all clear it (`go_landing` and its neighbours,
        // below) and the browser's own Back did not, so Back used to land on a screen still
        // holding the last one's failure (#127).
        // ponytail: `go` carries whatever happens to be on screen, so a redirect fired while
        // an unrelated error stands keeps it one route longer. upgrade path: pass the
        // message to `go` at the six sites that mean it, if a seventh ever gets it wrong.
        if (self.error() !== carried) self.error("");
        else if (carried) self.error.valueHasMutated();
        carried = "";
        // The lobby's own line gets the same re-touch, for the client walking out of the
        // match it played: that board is counted by `end_match` above, one route before the
        // pane that reports it, so the text lands behind the match screen where no live
        // region can be heard. (A client that watched the match end from the lobby takes no
        // route at all and is already looking at the region -- that one is the markup's to
        // answer, jnb.html.) `result_text` is a computed whose value has not changed by now,
        // so the notification is the whole of what this does: there is nothing new to write,
        // and re-writing the same text is what re-fires the region (#90, #128).
        if (route.screen === "room" && self.board())
            self.result_text.notifySubscribers(self.result_text());
        if (route.screen === "browse") self.refresh_rooms();
        if (route.screen === "password" && !self.pending_id()) return go("landing", true);
        if (route.screen === "room" || route.screen === "play")
            if (!self.participants().length) {
                // A reload arrives with the hash and nothing else. The room id and the
                // token outlived it in `sessionStorage`, so the seats can be reclaimed
                // rather than asked for again (#7); with neither, the names screen is one
                // step back rather than a screen with nothing behind it.
                var last = recall("room").id;
                if (last && !self.room_id()) return enter(last);
                return go("names", true);
            }
        // A session from the lobby on, so the host's `start` lands on a client that is
        // already listening for it.
        // Never on a socket that has gone: the session built here would hold the dead
        // transport, and the one the reconnect builds would never replace it (#42).
        if (route.screen === "room" && !self.disconnected()) session();
        if (route.screen === "play") {
            // A session exists from the lobby on (line above), so "there is a game" never
            // meant "a match is running": `in_match` is a `start` having landed on this
            // session and not yet ended (#40, #87). Without it the lobby's own session made
            // the match screen reachable, drawing a clock and a Back link over a blank canvas.
            if (!self.current_game() || !self.current_game().in_match) return go("room", true);
            self.current_game().start();
        }
        if (route.room_id) enter(route.room_id);
        // Queued, not immediate: this function also runs once from the constructor (below),
        // before `ko.applyBindings` has hidden a single pane.
        queueMicrotask(focus_screen);
    }

    window.addEventListener("hashchange", apply_route);

    // The flow's Back is the browser's, which the hash router already answers; this is the
    // way out of it, so it replaces rather than pushes and the trail does not grow.
    this.go_landing = function () {
        self.error("");
        go("landing", true);
    };
    this.go_create = function () {
        self.code("");
        self.error("");
        go("create");
    };
    this.go_join = function () {
        self.code("");
        self.error("");
        go("join");
    };
    // Cleared on the way in, like every other screen the flow walks to deliberately --
    // and not in `refresh_rooms`, because the one message worth keeping there is the one a
    // refused join put up on its way back here (#43).
    // Names first, room second. It leaves whatever room this client was in: Quick Join is
    // an answer to "put me somewhere", and somewhere is not where it already is (#44).
    this.go_quick = function () {
        leave_room();
        quick = true;
        self.error("");
        go("names");
    };
    this.go_browse = function () {
        self.error("");
        go("browse");
    };
    // A snapshot, never a subscription: once on entry, again on the button, and again when
    // a join is refused. Nothing polls, because the list is not what decides whether a
    // room will have you -- the join is (#43).
    this.refresh_rooms = function () {
        // `no-store`, because the response carries `max-age=10` for the cache in front of
        // the relay and a default `fetch` would honour it here too: a room that died would
        // sit in the list until the ten seconds ran out, and the button would do nothing
        // about it (#29, #43).
        fetch("api/rooms", { cache: "no-store" })
            .then(function (res) {
                return res.json();
            })
            .then(function (list) {
                self.rooms_error("");
                self.rooms(list);
            })
            .catch(function () {
                self.rooms([]);
                self.rooms_error(FLOW_TEXT.rooms_failed);
            });
    };
    // Clicking a row is the same join as typing the code.
    this.join_listed = function (row) {
        browsed = !row.locked;
        attempted_id = null;
        go(row.id);
    };
    // A route and nothing else: what leaving a match tells the room is `end_match`'s job now,
    // so this button and the browser's own Back say the same thing (#87).
    this.go_lobby = function () {
        go("room");
    };
    // Offline is the same flow over the loopback: names, lobby, match, board (#16).
    this.play_offline = function () {
        leave_room();
        go("names");
    };

    // `create` with a blank id asks the relay to generate one, and is refused honestly if
    // the id the host chose is already taken (#8).
    this.create_room = function () {
        // The in-flight guard #89 spelled as a binding on the button. Here rather than
        // there because a `disabled` button is out of the tab order, and leaving it there
        // cost the keyboard player the focus mid-connect (#120); the room above still only
        // ever gets one socket per press.
        if (self.connecting()) return;
        var id = self.code() ? normalise_room_id(self.code()) : "";
        if (self.code() && !id) return self.error(CODE_HINT);
        connect({ type: "create", id: id, listed: self.listed() });
    };
    this.join_room = function () {
        var id = normalise_room_id(self.code());
        if (!id) return self.error(CODE_HINT);
        attempted_id = null;
        browsed = false;
        go(id);
    };
    this.submit_password = function () {
        if (self.connecting()) return;
        connect({
            type: "join",
            id: self.pending_id(),
            password: self.password(),
            token: recall(self.pending_id()).token,
        });
    };

    function add_participant(scheme) {
        // Fixed at the names screen and granted all-or-nothing, so Back onto it changes
        // nothing: the seats are already held (#14).
        if (granted().length) return;
        var taken = self.participants().map(function (participant) {
            return participant.name();
        });
        var free = BUNNY_NAMES.find(function (bunny) {
            return taken.indexOf(bunny) < 0;
        });
        var held = self.participants().some(function (participant) {
            return participant.scheme === scheme;
        });
        if (held || !free) return;
        self.participants.push({ scheme: scheme, name: ko.observable(free) });
    }
    this.drop_participant = function (participant) {
        if (granted().length) return;
        self.participants.remove(participant);
    };
    // Offline the seats are simply the ones on this keyboard; online they are the relay's
    // to grant, all-or-nothing, against names it checks for collisions (#7, #14).
    this.take_seats = function () {
        if (self.connecting()) return;
        // Back onto the names screen and forward again: the seats are already granted, and
        // a client's count is fixed for the room's lifetime (#14).
        if (granted().length) return go("room");
        var participants = self.participants();
        var names = participants.map(function (participant) {
            return participant.name();
        });
        if (!self.room_id() && !quick) {
            granted(
                participants.map(function (_, seat) {
                    return seat;
                }),
            );
            self.seat_names(
                BUNNY_NAMES.map(function (_, seat) {
                    return names[seat] || null;
                }),
            );
            return go("room");
        }
        self.error("");
        // One round trip: the names go with the ask, and the relay answers with the room it
        // picked and the seats already taken in it (#44).
        if (quick) {
            quick = false;
            return connect({ type: "quick", names: names });
        }
        remember(self.room_id(), { schemes: schemes_of() });
        transport.send({ type: "seats", names: names });
    };

    // The first control scheme nobody on this couch is already using, for a seat taken
    // after the names screen fixed the rest (#42).
    function free_scheme() {
        var used = schemes_of();
        for (var scheme = 0; scheme < SCHEME_NAMES.length; scheme++)
            if (used.indexOf(scheme) < 0) return scheme;
        return 0;
    }

    // Names are room-unique, so a seat taken from the AI is named after the first bunny
    // nobody in the room is called (#7).
    function free_name() {
        var taken = self.seat_names().map(function (name) {
            return (name || "").toLowerCase();
        });
        return BUNNY_NAMES.find(function (bunny) {
            return taken.indexOf(bunny.toLowerCase()) < 0;
        });
    }

    // Walking back into the match this client walked out of. The ask refuses a client that
    // left a match it still holds seats in -- the answer would drag it straight back in the
    // moment it left, which is the opposite of what Back to the lobby means -- so pressing
    // this is the client saying it wants exactly that. Forgetting which seats it was last in
    // the match with is the whole of it: the relay hands its bunnies back off the AI on the
    // same `resume` a mid-match joiner asks for (#40, #42).
    //
    // The one place `resuming`'s latch re-opens after a failure (#89): `apply_room`'s own
    // calls to `ask_to_resume` must not, or a failed ask would retry itself on every room
    // broadcast.
    this.rejoin_match = function () {
        self.error("");
        stop_resuming();
        in_match_with = "";
        ask_to_resume();
    };

    // The other way into a seat: one the AI is driving, taken by somebody already in the
    // room. It works in the lobby and in a running match alike, and it can grow this client
    // past the seat count it fixed at the names screen (#42).
    this.take_seat = function (row) {
        self.error("");
        transport.send({ type: "take", seat: row.seat, name: free_name() });
    };

    // Which keyboard drives each of this client's seats, in the order the relay hands them
    // down: read live, because a seat taken mid-match adds one (#7, #42).
    function schemes_of() {
        return self.participants().map(function (participant) {
            return participant.scheme;
        });
    }

    // The keyboard is the form: a couch player is added by pressing that control scheme's
    // jump key, never by a fourth text box (#7, #35).
    window.addEventListener("keydown", function (evt) {
        if (self.screen() !== "names" || is_typing(evt)) return;
        var scheme = jump_scheme(evt.keyCode);
        if (scheme < 0) return;
        add_participant(scheme);
        evt.preventDefault();
    });

    // The top bar is bound before a session exists, so pause goes through the view model
    // rather than through `current_game()` directly.
    this.show_board = function () {
        if (self.current_game()) self.current_game().show_board();
    };
    this.hide_board = function () {
        if (self.current_game()) self.current_game().hide_board();
    };
    this.start_match = function () {
        session().propose();
    };
    // Declared for the whole client at once, and the relay is what holds it: a second
    // player on this couch has no key of its own to press (#7, #37).
    this.toggle_ready = function () {
        transport.send({ type: "ready", ready: !self.ready() });
        // Only its own instruction, not an unrelated confirmation still on screen (a
        // password just set) -- otherwise "Press Ready for the next one." stands until
        // the match after this one.
        if (self.notice() === FLOW_TEXT.ready_cleared) self.notice("");
    };
    this.cancel_countdown = function () {
        transport.send({ type: "cancel" });
    };

    // Staged, never immediate: the match being played is never reconfigured under the
    // people playing it, and the relay applies the diff when the next one begins (#38).
    this.apply_config = function () {
        self.error("");
        self.notice("");
        var wanted = read_form();
        if (!self.room_id()) {
            // A local room has no relay to stage against and nobody to keep waiting, so
            // the change lands here and the next match runs on it (#16).
            var next = Object.assign({}, self.config(), config_diff(self.config(), wanted));
            // `CUSTOM` is not in `LEVELS`, so the shared validator drops it -- which is
            // exactly what must happen to it on the wire, and not here.
            if (wanted.level === CUSTOM && self.custom_level()) next.level = CUSTOM;
            self.config(next);
            fill_form();
            preload();
            return;
        }
        transport.send({ type: "config", config: wanted });
    };

    // Write-only, and the host is not exempt: nothing ever sends a password back, so this
    // is a blind replacement and an empty box is how a room's password is removed (#8).
    // It takes effect at once rather than at the next match -- it guards the door, not the
    // match -- which is why it is its own button and not part of Apply.
    this.set_password = function () {
        self.error("");
        transport.send({ type: "config", password: self.new_password() });
        self.notice(self.new_password() ? "Password set." : "Password removed.");
        self.new_password("");
    };
    this.copy_link = function () {
        if (navigator.clipboard) navigator.clipboard.writeText(self.join_link());
    };

    // A level of your own, in a local room: it cannot be shared, because the other clients
    // in a room resolve a level by fetching its name and there is nothing to fetch (#38).
    this.load_level = function (vm, evt) {
        var files = evt.target.files;
        if (!files.length) return;
        self.loading_level(true);
        loader.read(files[0]).then(
            function (level) {
                self.custom_level(level);
                self.loading_level(false);
                self.form.level(CUSTOM);
                self.apply_config();
            },
            function () {
                self.loading_level(false);
                self.error("That file is not a level.");
            },
        );
    };

    apply_route();
}

ko.applyBindings(new ViewModel());
