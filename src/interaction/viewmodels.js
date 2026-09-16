import { create_default_level } from "../asset_data/default_levelmap.js";
import { Dat_Level_Loader } from "../resource_loading/dat_level_loader.js";
import { Game_Session } from "../interaction/game_session.js";
import { Scores_ViewModel } from "../interaction/scores_viewmodel.js";
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

function ViewModel() {
    "use strict";
    var self = this;
    var loader = new Dat_Level_Loader();
    var url = read_url(new URLSearchParams(window.location.search));
    var muted = url.muted;
    delete url.muted;

    // A fresh seed per match; the settings are the page's, shared across matches.
    // ponytail: a local seed is the whole room while the room is one client. Upgrade
    // path: the server hands the seed down in `start` (#12), and this line goes away.
    function new_session(level) {
        // Stop the outgoing session first: its pump loop would go on stepping the
        // `player` array the new one just replaced, and its music would go on playing.
        if (self.current_game) self.current_game().pause();
        return new Game_Session(level, { seed: Date.now() | 0, settings: url }, muted);
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
