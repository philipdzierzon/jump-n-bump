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

    // Monotonic, which the name always promised: the Win32 timer this is named after counts
    // from boot and cannot be stepped. `Date.getTime()` can go backwards under an NTP
    // correction, and a backwards step is exactly what would un-trip the batch bound in
    // `pump` and put the loop back in the lock it is there to prevent (#83).
    function timeGetTime() {
        return performance.now();
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

    // The most wall clock one catch-up batch may hold the event loop for. One frame: the loop
    // exists to hit 60 Hz, so blocking longer than the frame it is chasing is never the right
    // trade. What it bounds is how long the socket, the keyboard and the timer wait between
    // two ticks -- not latency: the check is after a tick, so a single tick that takes three
    // seconds still blocks for three seconds. No tick is capped and none is skipped (#83).
    //
    // ponytail: a batch that overruns a vsync waits for the next frame, so a sprint (a resume
    // gap) runs at roughly 50-100% duty. Upgrade path: `scheduler.yield()` inside the batch, if
    // a resume ever keeps the overlay up visibly long.
    var BATCH_MS = 1000 / 60;

    // How early a tick may run against the frame that shows it. rAF timestamps sit on the
    // display's vsync and the budget advances on the same 16.67 ms grid, so with no slack a tick
    // due "now" flips between this frame and the next on a millisecond of jitter -- 0 then 2
    // ticks, which is the judder this pacing exists to remove (#51). A quarter frame: under the
    // half frame a 120 Hz display's in-between frames sit at, so those still wait their turn.
    var SLACK_MS = 1000 / 240;

    // Decide, then step: rAF wakes once per display frame, 60 or 120 or 144 times a second, so
    // a loop that stepped first would run the simulation at the display's rate. `frame_time` is
    // the frame's vsync timestamp, the same timebase as `timeGetTime()`.
    function pump(frame_time) {
        var batch_started = timeGetTime();
        var stepped = false;
        while (playing) {
            // Above the sprint branch on purpose: a peer holding `gap()` positive drives that
            // branch past both the draw and the yield, and it is the entrance that needs the
            // bound most (#83, and `docs/research/desync-under-load.md` §7 -- a client that
            // has not read its socket cannot know what the room is doing). Checked on real
            // elapsed time, never on `frame_time`.
            if (timeGetTime() - batch_started >= BATCH_MS) {
                next_time = frame_time + 1000 / 60;
                break;
            }
            // Behind the room rather than behind its own clock. The ticks between here and
            // the newest frame anybody has stamped are ticks whose input has already
            // arrived, so stepping them is replay and not guesswork -- and a client that
            // paces them off its own clock instead never closes the gap, because it steps
            // at the same 60 Hz the room does. Every frame it sends is then stamped for a
            // tick the room has already passed, which the relay drops (#42).
            //
            // A rebuild is where that gap comes from: a resumed client replays to the tick
            // the room was on when the payload was built, and decoding a state, building an
            // object graph and replaying the gap all take time the room spends playing
            // (#40, #70). The budget is re-seeded rather than advanced, because the ticks
            // just stepped are the room's backlog and not this client's own schedule --
            // advancing it would sleep the gap straight back open.
            if (room.gap() > 0) next_time = frame_time + 1000 / 60;
            // Not due by this frame: the backlog is cleared. Catch-up stays uncapped in ticks
            // and no tick is ever skipped -- what bounds it is `BATCH_MS` of wall clock per
            // batch, so the loop always reaches the yield below. That bound is what makes the
            // old claim true: a slow client loses frames, never simulation state (#30, #83).
            else if (next_time - frame_time > SLACK_MS) break;
            else next_time += 1000 / 60;
            game_iteration();
            stepped = true;
        }
        // A match that reached its limit paused itself inside `game_iteration`, which drew the
        // tick that ended it (#39).
        if (!playing) return;
        // Once per wakeup, and only if a tick ran: a 120 Hz display has a frame with nothing new
        // in it every other time.
        if (stepped) renderer.draw();
        // Not fired while the tab is hidden, which is the freeze: no tick, so no frame goes to
        // the relay, which is #42's drop signal -- AI at 30 ticks, seats held for the token (#51).
        requestAnimationFrame(pump);
    }

    // Resuming a hidden tab: the backlog is wall clock nobody played, not ticks owed. A local
    // room has nobody to be behind; a networked one's position is `room.gap()`'s, which the
    // sprint closes on its own -- a stale budget there would step past what the room has stamped
    // and fill the ticks with released keys (#51, #19). `BATCH_MS` alone would cap the lurch at
    // one frame of CPU in a real browser, but it is still a lurch; this drops it outright.
    this.drop_backlog = function () {
        next_time = timeGetTime();
    };

    this.start = function () {
        // Already pumping: a second loop would step the same simulation twice a frame,
        // and every way into the match calls this. A match that reached its limit is over
        // for good -- restarting it would step past the tick the room ended on (#39).
        if (playing || ended) return;
        // The first tick at once and the next one frame on, not one second. A second of
        // nothing before the first tick is the port's own -- the C original paces on its timer
        // interrupt and has no such pause -- and it cost every client the same 60 ticks at
        // match start, so it never showed. A client resumed into a match already running is
        // the one it shows on: it lands on the tick the room is on and then hands the room a
        // one-second head start, which is 60 ticks of a delay budget worth two (#40).
        next_time = timeGetTime();
        playing = true;
        pump(timeGetTime());
    };

    this.pause = function () {
        playing = false;
    };
}
