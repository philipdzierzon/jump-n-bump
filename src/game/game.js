import { env } from "./env.js";
import { Player } from "../game/player.js";
import { SET_BAN_MAP } from "../game/level.js";

export let player = [];

export function Game(movement, ai, animation, renderer, objects, room, level, is_server, rnd) {
    "use strict";
    var next_time = 0;
    var playing = false;
    reset_players();
    reset_level();

    function reset_players() {
        player = [
            new Player(0, is_server, rnd),
            new Player(1, is_server, rnd),
            new Player(2, is_server, rnd),
            new Player(3, is_server, rnd),
        ];
    }

    function reset_level() {
        SET_BAN_MAP(level.ban_map);
        objects.reset_objects();

        for (var c1 = 0; c1 < env.JNB_MAX_PLAYERS; c1++) {
            if (player[c1].enabled) {
                player[c1].bumps = 0;
                for (var c2 = 0; c2 < env.JNB_MAX_PLAYERS; c2++) {
                    player[c1].bumped[c2] = 0;
                }
                player[c1].position_player(c1);
            }
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

    function game_iteration() {
        renderer.clear_pobs();
        steer_players();
        movement.collision_check();
        animation.update_object();
    }

    // One simulation tick, no clock and no drawing: the headless entry point a
    // replay or a server sim steps by hand (#5).
    this.step = game_iteration;

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
        next_time = timeGetTime() + 1000;
        playing = true;
        pump();
    };

    this.pause = function () {
        playing = false;
    };
}
