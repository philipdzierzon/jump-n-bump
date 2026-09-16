import { create_default_level } from "../asset_data/default_levelmap.js";
import { Dat_Level_Loader } from "../resource_loading/dat_level_loader.js";
import { Game_Session } from "../interaction/game_session.js";
import { Scores_ViewModel } from "../interaction/scores_viewmodel.js";
import { Loopback_Transport } from "../net/loopback_transport.js";
import { WebSocket_Transport } from "../net/websocket_transport.js";
import { normalise_room_id } from "../net/room_id.js";
import ko from "knockout";

function Enum(obj) {
    return Object.freeze ? Object.freeze(obj) : obj;
}

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

function ViewModel() {
    "use strict";
    var self = this;
    var loader = new Dat_Level_Loader();
    var url = read_url(new URLSearchParams(window.location.search));
    var muted = url.muted;
    delete url.muted;

    // Offline play is a room of one over a transport that never opens a socket; an online
    // room is the same room over a WebSocket (#16, #33). The transport outlives the
    // session, so restarting a match reuses the socket rather than rejoining.
    var transport = new Loopback_Transport();
    var host = true;

    // The host proposes a fresh seed per match; a joining client plays the seed the relay
    // hands down. The settings are the page's, shared across matches.
    // ponytail: the host's URL params are the whole room config. upgrade path: host-staged
    // room config over the wire, which retires the query params entirely (#38).
    function new_session(level) {
        // Stop the outgoing session first: its pump loop would go on stepping the
        // `player` array the new one just replaced, and its music would go on playing.
        if (self.current_game) self.current_game().pause();
        return new Game_Session(
            level,
            { seed: Date.now() | 0, settings: url, host: host },
            muted,
            transport,
        );
    }

    this.Page = Enum({ Instructions: 0, Game: 1, Scores: 2 });
    this.loading_level = ko.observable(true);
    this.current_level = create_default_level();
    this.current_game = ko.observable(new_session(this.current_level));

    this.current_page = ko.computed(function () {
        return self.current_game().game_state();
    });
    this.scores_viewmodel = ko.computed(function () {
        return new Scores_ViewModel(self.current_game().scores());
    });

    // The room id is uppercased everywhere it is shown, and re-uppercased and validated by
    // the relay regardless -- a client is not what makes an id legal (#8).
    this.room_id = ko.observable(normalise_room_id(window.location.hash.slice(1)) || "");
    this.room_error = ko.observable("");

    function connect(entry) {
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
                // The bare fragment is the only link ever generated: it stays out of the
                // relay's HTTP logs and out of Referer (#8).
                window.location.hash = joined.id;
                self.room_id(joined.id);
                // The host started before this client arrived, so there is nothing to
                // join until the next match -- which this session picks up when it comes
                // (#37, #40).
                self.room_error(joined.started ? "match in progress, waiting" : "");
                self.restart();
            },
            function (code) {
                self.room_error(code);
                // A socket that died under a live room leaves this client with no
                // transport at all: falling back to a local one keeps the game playable
                // without a reload. upgrade path: reconnect into the seat (#42).
                if (code === "DISCONNECTED" && transport === socket) {
                    transport = new Loopback_Transport();
                    host = true;
                }
            },
        );
    }

    // `create` with a blank id asks the relay to generate one, and is refused honestly if
    // the id the host chose is already taken.
    this.host_online = function () {
        connect({ type: "create", id: self.room_id() });
    };
    // A `/#ABCDE` link is a join, and nothing about it needs routing config.
    if (this.room_id()) connect({ type: "join", id: this.room_id() });

    this.restart = function () {
        self.current_game(new_session(self.current_level));
        self.current_game().start();
    };

    this.load_level = function (self) {
        this.loading_level(true);
        var files = document.getElementById("level_input").files;
        if (files.length) {
            var file = files[0];

            document.addEventListener(loader.on_loaded_event_text, function () {
                self.current_level = loader.read_level();
                self.current_game(new_session(self.current_level));
                self.loading_level(false);
            });

            loader.load(file);
        }
    };
}

ko.applyBindings(new ViewModel());
