import { env } from "./env.js";
import { Player } from "../game/player.js";
import { SET_BAN_MAP } from "../game/level.js";

export let player = [];

export function Game(movement, ai, animation, renderer, objects, room, level, is_server, rnd) {
    "use strict";
    var self = this;
    var next_time = 0;
    var playing = false;
    var ended = false;
    // Both limits are fixed at match start, from the settings the relay handed down -- the
    // only configuration path there is (#5, #38). Zero is endless, for both.
    var bump_limit = room.settings.bump_limit || 0;
    var tick_limit = (room.settings.time_limit || 0) * env.TICKS_PER_MINUTE;
    // Announced by the host, honoured by everyone; the simulation stops here either way
    // (#22, #39).
    this.on_end = null;
    reset_players();
    reset_level();

    function reset_players() {
        player = [
            new Player(0, is_server, rnd),
            new Player(1, is_server, rnd),
            new Player(2, is_server, rnd),
            new Player(3, is_server, rnd),
        ];
        // A seat the room disabled has no bunny: with AI-fill off, a seat nobody holds is
        // left out of the match rather than handed to the CPU (#7, #37).
        for (var i = 0; i < player.length; i++) player[i].enabled = room.enabled_seat(i);
    }

    function reset_level() {
        SET_BAN_MAP(level.ban_map);
        objects.reset_objects();

        for (var c1 = 0; c1 < env.JNB_MAX_PLAYERS; c1++) {
            // Zeroed for every seat, disabled ones included: a disabled seat still has a
            // row on the scoreboard, and a row shorter than the others draws a table with
            // cells missing (#37). Only a bunny that is in the match gets placed in it.
            player[c1].bumps = 0;
            for (var c2 = 0; c2 < env.JNB_MAX_PLAYERS; c2++) {
                player[c1].bumped[c2] = 0;
            }
            if (player[c1].enabled) player[c1].position_player(c1);
        }
    }

    function timeGetTime() {
        return new Date().getTime();
    }

    // Who drives a seat: whoever the room delivers a frame for this tick, the AI if nobody
    // does (#32, #7). Input reaches the simulation only through the room, so a local room
    // and a networked one steer identically -- only the transport under the room differs
    // (#16). That one rule also replaces the `alt+1-4` toggles: four humans on one keyboard
    // is a client holding four seats, and a seat it lets go is AI-filled.
    function update_player_actions() {
        var frames = room.step();
        for (var i = 0; i != player.length; ++i) {
            var frame = frames[i];
            player[i].ai = !frame;
            if (!frame) continue;
            player[i].action_left = frame.left;
            player[i].action_right = frame.right;
            player[i].action_up = frame.up;
        }
    }

    function steer_players() {
        update_player_actions();
        ai.cpu_move(); // writes the same frame for every seat left to it
        for (var playerIndex = 0; playerIndex != player.length; ++playerIndex) {
            var p = player[playerIndex];
            if (p.enabled) {
                if (!p.dead_flag) {
                    movement.steer_player(p);
                }
                p.update_player_animation();
            }
        }
    }

    // Whichever limit fires first, tested at the end of the tick it first holds so that
    // every client leaves the match on the same one. The time limit is ticks and the bump
    // limit is the killer's own tally, which is the number the in-game counter shows (#39).
    function limit_reached() {
        if (tick_limit && room.now() >= tick_limit) return "time";
        if (bump_limit)
            for (var i = 0; i < player.length; i++)
                if (player[i].bumps >= bump_limit) return "bumps";
        return null;
    }

    function game_iteration() {
        renderer.clear_pobs();
        steer_players();
        movement.collision_check();
        animation.update_object();
        var reason = ended ? null : limit_reached();
        if (reason) {
            ended = true;
            // The tick that ended it is the one worth seeing: the pump draws once per
            // catch-up batch and breaks out of the loop here, so without this the killing
            // blow is simulated and never painted (#39).
            renderer.draw();
            self.pause();
            if (self.on_end) self.on_end(reason);
        }
    }

    // One simulation tick, no clock and no drawing: the headless entry point a
    // replay or a server sim steps by hand (#5).
    this.step = game_iteration;

    // Ticks left of the time limit, or null when there is none. Read by the top bar, which
    // is chrome rather than canvas and costs the wire nothing (#39).
    this.ticks_left = function () {
        return tick_limit ? Math.max(0, tick_limit - room.now()) : null;
    };

    function pump() {
        while (playing) {
            game_iteration();
            var now = timeGetTime();
            var time_diff = next_time - now;
            next_time += 1000 / 60;

            if (time_diff > 0) {
                // We have time left, so the backlog is cleared: draw once for the whole
                // catch-up batch. Catch-up itself stays uncapped and no tick is ever
                // skipped -- a slow client loses frames, never simulation state (#30).
                renderer.draw();
                setTimeout(pump, time_diff);
                break;
            }
        }
    }

    this.start = function () {
        // Already pumping: a second loop would step the same simulation twice a frame,
        // and every way into the match calls this. A match that reached its limit is over
        // for good -- restarting it would step past the tick the room ended on (#39).
        if (playing || ended) return;
        // One tick, not one second. A second of nothing before the first tick is the port's
        // own -- the C original paces on its timer interrupt and has no such pause -- and it
        // cost every client the same 60 ticks at match start, so it never showed. A client
        // resumed into a match already running is the one it shows on: it lands on the tick
        // the room is on and then hands the room a one-second head start, which is 60 ticks
        // of a delay budget worth two (#40).
        next_time = timeGetTime() + 1000 / 60;
        playing = true;
        pump();
    };

    this.pause = function () {
        playing = false;
    };
}
