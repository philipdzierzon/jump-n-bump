import { create_default_level } from "../asset_data/default_levelmap.js";
import { Dat_Level_Loader } from "../resource_loading/dat_level_loader.js";
import { Game_Session, Game_State, is_typing } from "../interaction/game_session.js";
import { Scores_ViewModel, BUNNY_NAMES } from "../interaction/scores_viewmodel.js";
import { screen_of } from "../interaction/router.js";
import { jump_scheme } from "../game/keyboard.js";
import { Loopback_Transport } from "../net/loopback_transport.js";
import { WebSocket_Transport } from "../net/websocket_transport.js";
import { normalise_room_id } from "../net/room_id.js";
import ko from "knockout";

// Read once for the page, not once per match: settings belong to the room, and every
// client in it must hold the same object (#5).
// ponytail: the URL is the only way to configure the one client there is. Upgrade path:
// host-staged room config over the wire (#3), which retires these query params entirely.
function read_url(q) {
    return {
        pogostick: q.get("pogostick") === "1",
        jetpack: q.get("jetpack") === "1",
        bunnies_in_space: q.get("space") === "1",
        flies_enabled: q.get("lordoftheflies") === "1",
        blood_is_thicker_than_water: q.get("bloodisthickerthanwater") === "1",
        no_gore: q.get("nogore") === "1",
        muted: q.get("nosound") === "1",
    };
}

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
// One answer for a wrong password and for a room that is not there: telling them apart is
// what would make an unlisted room's id worth guessing at (#8).
var UNAVAILABLE = "That room is not available. Check the code, and the password if it has one.";

function ViewModel() {
    "use strict";
    var self = this;
    var loader = new Dat_Level_Loader();
    var url = read_url(new URLSearchParams(window.location.search));
    var muted = url.muted;
    delete url.muted;

    // Offline play is a room of one over a transport that never opens a socket; an online
    // room is the same room over a WebSocket (#16, #33). The transport outlives the
    // session, so a second match reuses the socket rather than rejoining.
    var transport = new Loopback_Transport();
    var host = true;
    // The room id this client has already spent its no-password attempt on, so Back onto
    // the same link does not open a second socket to be refused by the same room.
    var attempted_id = null;

    this.screen = ko.observable("landing");
    this.code = ko.observable("");
    this.password = ko.observable("");
    this.error = ko.observable("");
    this.room_id = ko.observable(null);
    this.pending_id = ko.observable(null);
    this.is_host = ko.observable(true);
    this.participants = ko.observableArray([]);
    this.current_game = ko.observable(null);
    this.board = ko.observable(null);
    this.current_level = create_default_level();
    this.loading_level = ko.observable(false);

    // Pause is not a screen of the flow, it is where the match goes when you pause it.
    this.view = ko.computed(function () {
        var game = self.current_game();
        if (self.screen() !== "play") return self.screen();
        return game && game.game_state() === Game_State.Paused ? "scores" : "play";
    });

    this.code_chars = ko.computed(function () {
        return (self.pending_id() || "").split("");
    });
    this.scheme_name = function (scheme) {
        return SCHEME_NAMES[scheme];
    };

    // ponytail: the board names the seats this client holds and calls the rest by their
    // bunny, because nothing tells it who is on the others yet. upgrade path: room-wide
    // usernames, which arrive with the seats (#36).
    function display_names() {
        return BUNNY_NAMES.map(function (bunny, seat) {
            var participant = self.participants()[seat];
            return participant && participant.name() ? participant.name() : bunny;
        });
    }

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

    this.join_link = ko.computed(function () {
        // The bare fragment is the only link this app generates: it stays out of the
        // relay's HTTP logs and out of Referer (#8).
        return self.room_id()
            ? window.location.origin + window.location.pathname + "#" + self.room_id()
            : "";
    });

    function go(hash, replace) {
        // `replace` for a redirect the flow makes on your behalf, so Back skips the screen
        // you were only passing through.
        if (replace) window.location.replace("#" + hash);
        else window.location.hash = hash;
    }

    function leave_room() {
        if (transport.close) transport.close();
        transport = new Loopback_Transport();
        host = true;
        self.is_host(true);
        self.room_id(null);
        self.pending_id(null);
        self.password("");
        attempted_id = null;
    }

    function end_match() {
        var game = self.current_game();
        if (!game) return;
        var played = game.game_state() !== Game_State.Not_Started;
        game.pause();
        // The board of the match you just left is what the lobby shows; it is not a screen
        // of its own (#13, #35).
        if (played) self.board(game.scores());
        self.current_game(null);
    }

    function session() {
        if (self.current_game()) return self.current_game();
        var participants = self.participants();
        var game = new Game_Session(
            self.current_level,
            {
                seed: Date.now() | 0,
                settings: url,
                host: host,
                held: participants.map(function (_, seat) {
                    return seat;
                }),
                schemes: participants.map(function (participant) {
                    return participant.scheme;
                }),
            },
            muted,
            transport,
        );
        // Whoever proposed it, the match begins for this client when `start` lands.
        game.on_match_start = function () {
            go("play");
        };
        self.current_game(game);
        return game;
    }

    function connect(entry) {
        self.error("");
        var leaving = transport;
        var socket = new WebSocket_Transport(
            relay_url(),
            entry,
            function (joined) {
                // Only once the new room is in: a refused join leaves this client in the
                // room it already had, rather than in neither.
                if (leaving.close) leaving.close();
                transport = socket;
                host = joined.host;
                self.is_host(host);
                self.room_id(joined.id);
                self.pending_id(joined.id);
                // The host started before this client arrived, so there is nothing to join
                // until the next match -- which this session picks up when it comes (#40).
                self.error(
                    joined.started ? "A match is in progress; you are in for the next one." : "",
                );
                go("names", true);
            },
            function (code) {
                if (code === "DISCONNECTED") {
                    // A socket that died under a live room leaves this client with no
                    // transport at all: falling back to a local one keeps the game playable
                    // without a reload. upgrade path: reconnect into the seat (#42).
                    if (transport === socket) leave_room();
                    self.error("The connection dropped.");
                } else if (entry.type === "create") {
                    self.error(code === "ID_TAKEN" ? "That code is taken." : CODE_HINT);
                } else if (self.screen() === "password") {
                    self.error(UNAVAILABLE);
                } else {
                    // Which of the two it was is exactly what is not said: the password
                    // screen is where both answers land (#8).
                    go("password", true);
                }
            },
        );
    }

    function enter(id) {
        self.pending_id(id);
        self.code(id);
        if (self.room_id() === id) return go("room", true);
        if (attempted_id === id) return go("password", true);
        attempted_id = id;
        connect({ type: "join", id: id });
    }

    // A reload, or a Forward into a screen the flow has not walked to, arrives with none
    // of the state that screen is about: no participants, and no room to rejoin, since the
    // only thing that survives a reload is the hash. Each of those falls back one step
    // rather than rendering a screen with nothing behind it (#42 is what would change it).
    function apply_route() {
        var route = screen_of(window.location.hash);
        if (route.screen !== "play") end_match();
        if (route.screen === "landing" || route.screen === "browse") leave_room();
        self.screen(route.screen);
        if (route.screen === "password" && !self.pending_id()) return go("landing", true);
        if (route.screen === "room" || route.screen === "play")
            if (!self.participants().length) return go("names", true);
        // A session from the lobby on, so the host's `start` lands on a client that is
        // already listening for it.
        if (route.screen === "room") session();
        if (route.screen === "play") {
            if (!self.current_game()) return go("room", true);
            self.current_game().start();
        }
        if (route.room_id) enter(route.room_id);
    }

    window.addEventListener("hashchange", apply_route);

    // The flow's Back is the browser's, which the hash router already answers; this is the
    // way out of it, so it replaces rather than pushes and the trail does not grow.
    this.go_landing = function () {
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
    this.go_browse = function () {
        go("browse");
    };
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
        var id = self.code() ? normalise_room_id(self.code()) : "";
        if (self.code() && !id) return self.error(CODE_HINT);
        connect({ type: "create", id: id });
    };
    this.join_room = function () {
        var id = normalise_room_id(self.code());
        if (!id) return self.error(CODE_HINT);
        attempted_id = null;
        go(id);
    };
    this.submit_password = function () {
        connect({ type: "join", id: self.pending_id(), password: self.password() });
    };

    function add_participant(scheme) {
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
        self.participants.remove(participant);
    };
    this.take_seats = function () {
        go("room");
    };

    // The keyboard is the form: a couch player is added by pressing that control scheme's
    // jump key, never by a fourth text box (#7, #35).
    window.addEventListener("keydown", function (evt) {
        if (self.view() !== "names" || is_typing(evt)) return;
        var scheme = jump_scheme(evt.keyCode);
        if (scheme < 0) return;
        add_participant(scheme);
        evt.preventDefault();
    });

    // The top bar is bound before a session exists, so pause goes through the view model
    // rather than through `current_game()` directly.
    this.pause = function () {
        if (self.current_game()) self.current_game().pause();
    };
    this.unpause = function () {
        if (self.current_game()) self.current_game().unpause();
    };
    this.start_match = function () {
        session().propose();
    };
    this.copy_link = function () {
        if (navigator.clipboard) navigator.clipboard.writeText(self.join_link());
    };

    this.load_level = function (vm, evt) {
        var files = evt.target.files;
        if (!files.length) return;
        self.loading_level(true);
        document.addEventListener(loader.on_loaded_event_text, function () {
            self.current_level = loader.read_level();
            // The next match is the one that runs on it: the session bakes its level in.
            end_match();
            self.loading_level(false);
        });
        loader.load(files[0]);
    };

    apply_route();
}

ko.applyBindings(new ViewModel());
