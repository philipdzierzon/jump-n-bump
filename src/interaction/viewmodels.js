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
    // Granted by the relay, never assumed: the seats this client holds, in the order it
    // holds them, which is the order its control schemes bind in (#7).
    var granted = ko.observableArray([]);
    var token = null;

    this.screen = ko.observable("landing");
    this.code = ko.observable("");
    this.password = ko.observable("");
    this.error = ko.observable("");
    this.room_id = ko.observable(null);
    this.pending_id = ko.observable(null);
    this.is_host = ko.observable(true);
    this.participants = ko.observableArray([]);
    // Every seat in the room, by the username of the participant on it -- null for a seat
    // nobody holds, which is the AI's (#36).
    this.seat_names = ko.observableArray([null, null, null, null]);
    // The room's own answer, refreshed on every update: a match that ended, or a host that
    // left and took its announcement with it, must not leave this standing (#36).
    this.match_running = ko.observable(false);
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
    // Once the relay has granted the seats, the names on them are the room's: a client's
    // count is fixed and a rename would need a second collision check nobody asked for
    // (#7, #14). The names screen says so rather than accepting edits it would discard.
    this.seated = ko.computed(function () {
        return granted().length > 0;
    });

    // The room's own seat table, so the board names every participant and not only the ones
    // on this keyboard; a seat nobody holds keeps its bunny's name (#13, #36).
    function display_names() {
        return BUNNY_NAMES.map(function (bunny, seat) {
            return self.seat_names()[seat] || bunny;
        });
    }

    // The lobby shows all four seats, whoever is on them: the username, the bunny, and the
    // control scheme for the seats this keyboard drives (#13, #36).
    this.seat_rows = ko.computed(function () {
        return BUNNY_NAMES.map(function (bunny, seat) {
            var mine = self.participants()[granted().indexOf(seat)];
            return {
                name: self.seat_names()[seat] || "AI",
                bunny: bunny,
                scheme: mine ? SCHEME_NAMES[mine.scheme] : "",
            };
        });
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

    this.join_link = ko.computed(function () {
        // The bare fragment is the only link this app generates: it stays out of the
        // relay's HTTP logs and out of Referer (#8).
        return self.room_id()
            ? window.location.origin + window.location.pathname + "#" + self.room_id()
            : "";
    });

    function go(hash, replace) {
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
        // A deliberate Leave frees the seats now; only a dropped connection reserves them
        // for a reload (#17). The relay cannot tell the two apart without being told.
        if (self.room_id() && transport.send) transport.send({ type: "leave" });
        if (transport.close) transport.close();
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
        granted([]);
        token = null;
        remember("room", { id: null });
    }

    function end_match() {
        var game = self.current_game();
        if (!game) return;
        var played = game.game_state() !== Game_State.Not_Started;
        // One rule for every way a client stops simulating -- back to the lobby, out to the
        // landing screen, a level loaded: the seats it drove go to the AI on an agreed tick,
        // so the room sees it leave instead of watching a bunny stand still (#7, #17).
        if (played) game.release_seats();
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
                held: granted(),
                schemes: participants.map(function (participant) {
                    return participant.scheme;
                }),
            },
            muted,
            transport,
        );
        // The host announces the end and every client honours it, so a host walking back
        // to the lobby does not leave the others playing on alone (#22, #11).
        game.on_match_end = function () {
            go("room");
        };
        // Whoever proposed it, the match begins for this client when `start` lands -- and
        // the session that was handed the match is the current one, whichever flow screen
        // this client happens to be sitting on. Without that, a client that had stepped
        // back to the names screen would build the match, bounce off the play route for
        // want of a current session, and rebuild a lobby session that replaces the
        // transport's listener -- orphaning the match it was already in.
        game.on_match_start = function () {
            self.current_game(game);
            go("play");
        };
        self.current_game(game);
        return game;
    }

    // The relay's picture of the room: which seats exist, who is on them, which ones this
    // client was granted, and whether it hosts. It arrives on the handshake and again on
    // every change, so joining, being seated, someone else being seated and the host
    // migrating are all one code path (#36).
    function apply_room(msg) {
        self.seat_names(msg.seats);
        self.match_running(!!msg.started);
        host = msg.host;
        self.is_host(host);
        granted(msg.held);
        if (!msg.held.length) return;
        if (self.participants().length) {
            // The name everyone sees is the relay's, not the one that was typed.
            msg.held.forEach(function (seat, nth) {
                self.participants()[nth].name(msg.seats[seat]);
            });
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
    }

    function connect(entry) {
        self.error("");
        var leaving = transport;
        var socket = new WebSocket_Transport(
            relay_url(),
            entry,
            function (msg) {
                if (msg.type === "joined") {
                    // Only once the new room is in: a refused join leaves this client in the
                    // room it already had, rather than in neither.
                    if (leaving.close) leaving.close();
                    transport = socket;
                    token = msg.token;
                    self.room_id(msg.id);
                    self.pending_id(msg.id);
                    remember(msg.id, { token: token });
                    // The lobby's own URL is `#room`, which says nothing about which room:
                    // this is what a reload reads to find its way back to one (#36).
                    remember("room", { id: msg.id });
                } else if (transport !== socket) return;
                apply_room(msg);
                // A reload lands back in the lobby, because the token brought the seats
                // back with it; a first arrival goes to the names screen to ask for some.
                if (msg.type === "joined") go(msg.held.length ? "room" : "names", true);
            },
            function (code) {
                if (code === "DISCONNECTED") {
                    // A socket that died under a live room leaves this client with no
                    // transport at all: falling back to a local one keeps the game playable
                    // without a reload. upgrade path: reconnect into the seat (#42).
                    if (transport === socket) leave_room();
                    self.error("The connection dropped.");
                } else if (code === "NAME_TAKEN") {
                    self.error("Somebody in this room already has that name.");
                } else if (code === "BAD_NAME") {
                    self.error("Every name needs 1 to 16 characters.");
                } else if (code === "ROOM_FULL") {
                    self.error("Not enough free seats in that room for everyone here.");
                } else if (entry.type === "create") {
                    self.error(code === "ID_TAKEN" ? "That code is taken." : CODE_HINT);
                } else if (self.screen() === "room" || self.screen() === "play") {
                    // A reload into a room that has since gone: there is nothing to reclaim
                    // and no password worth asking for.
                    go("landing", true);
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
        connect({ type: "join", id: id, token: recall(id).token });
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
        // Only the host ends the match for everyone; anybody else is just leaving it, and
        // their seat goes quiet until the next one (#22).
        var game = self.current_game();
        if (host && game && game.game_state() !== Game_State.Not_Started)
            game.announce_end("lobby");
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
        // Back onto the names screen and forward again: the seats are already granted, and
        // a client's count is fixed for the room's lifetime (#14).
        if (granted().length) return go("room");
        var participants = self.participants();
        var names = participants.map(function (participant) {
            return participant.name();
        });
        if (!self.room_id()) {
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
        remember(self.room_id(), {
            schemes: participants.map(function (participant) {
                return participant.scheme;
            }),
        });
        transport.send({ type: "seats", names: names });
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
