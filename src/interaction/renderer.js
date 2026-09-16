import { player } from "../game/game.js";
import { env } from "../game/env.js";
import { rabbit_gobs } from "../asset_data/rabbit_gobs.js";
import { number_gobs } from "../asset_data/number_gobs.js";

export function Renderer(canvas, img, level) {
    "use strict";
    var self = this;
    var main = { num_pobs: 0, pobs: [] };
    var leftovers = { num_pobs: 0, pobs: [] };
    var canvas_scale = 1;
    var ctx = canvas.getContext('2d');

    var MAX = {
        POBS: 200,
        FLIES: 20,
        LEFTOVERS: 50,
    };

    // Ring buffer: MAX.LEFTOVERS was declared and never applied, so splats accumulated
    // for the length of a match. Overwriting oldest-first keeps the newest ones (#30).
    var leftovers_written = 0;

    this.add_leftovers = function(x, y, image, gob) {
        leftovers.pobs[leftovers_written++ % MAX.LEFTOVERS] = { x: x, y: y, gob: gob, image: image };
        leftovers.num_pobs = Math.min(leftovers_written, MAX.LEFTOVERS);
    }

    // Pobs live for one tick. draw() used to clear them because it ran every tick;
    // now that it runs once per catch-up batch, the tick has to clear its own or a
    // deep batch stacks every intermediate frame's sprites and overruns MAX.POBS.
    this.clear_pobs = function() {
        main.num_pobs = 0;
    }

    this.add_pob = function(x, y, image, gob) {
        if (main.num_pobs >= MAX.POBS) {
            return;
        }
        main.pobs[main.num_pobs] = { x: x, y: y, gob: gob, image: image };
        main.num_pobs++;
    }

    function put_pob(x, y, gob, img) {
        var sx, sy, sw, sh, hs_x, hs_y;
        sx = gob.x;
        sy = gob.y;
        sw = gob.width;
        sh = gob.height;
        hs_x = gob.hotspot_x;
        hs_y = gob.hotspot_y;
        ctx.drawImage(img, sx, sy, sw, sh, x - hs_x, y - hs_y, sw, sh);
    }

    function draw_pobs() {
        for (var c1 = main.num_pobs - 1; c1 >= 0; c1--) {
            var pob = main.pobs[c1];
            put_pob(pob.x, pob.y, pob.gob, pob.image);
        }
    }

    function draw_leftovers() {
        // Oldest first: array order is not insertion order once the ring has wrapped,
        // and a newer splat has to paint over an older one, not under it.
        var oldest = leftovers_written - leftovers.num_pobs;
        for (var c1 = 0; c1 != leftovers.num_pobs; ++c1) {
            var pob = leftovers.pobs[(oldest + c1) % MAX.LEFTOVERS];
            put_pob(pob.x, pob.y, pob.gob, pob.image);
        }
    }


    // Drawn from player state every frame rather than painted into `leftovers` on each
    // kill (#13): the buffer is now a bounded ring, and a counter that is really a splat
    // gets evicted by gore. Display caps at 99; the matrix holds the true number.
    function draw_score(i) {
        var score = Math.min(player[i].bumps, 99);
        if (score >= 10) {
            self.add_pob(360, 34 + i * 64, img.numbers, number_gobs[Math.floor(score / 10)]);
        }
        self.add_pob(376, 34 + i * 64, img.numbers, number_gobs[score % 10]);
    }

    function resize_canvas() {
        var x_scale = window.innerWidth / level.image.width;
        var y_scale = window.innerHeight / level.image.height;
        var new_scale = Math.max(1, Math.floor(Math.min(x_scale, y_scale)));

        if (canvas_scale != new_scale) {
            canvas_scale = new_scale;
            canvas.width = 0;
            canvas.height = 0;
            canvas.width = level.image.width * canvas_scale;
            canvas.height = level.image.height * canvas_scale;
            ctx.scale(canvas_scale, canvas_scale);
        }
    }

    this.draw = function () {
        resize_canvas();

        ctx.drawImage(level.image, 0, 0);

        for (var i = 0; i < env.JNB_MAX_PLAYERS; i++) {
            if (player[i].enabled) {
                this.add_pob(player[i].x.pos >> 16, player[i].y.pos >> 16, img.rabbits, rabbit_gobs[player[i].get_image() + i * 18]);
                draw_score(i);
            }
        }
        draw_leftovers();
        draw_pobs();

        ctx.drawImage(level.mask, 0, 0);
    }
};