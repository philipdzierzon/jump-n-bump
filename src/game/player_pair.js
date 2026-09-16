export function Player_Pair(first, second, sfx, objects, settings) {
    "use strict";

    this.highest = function () {
        return first.y.pos < second.y.pos ? first : second;
    };

    this.lowest = function () {
        return first === this.highest() ? second : first;
    };

    this.leftmost = function () {
        return first.x.pos < second.x.pos ? first : second;
    };

    this.rightmost = function () {
        return first == this.leftmost() ? second : first;
    };

    this.collision_check = function () {
        if (first.enabled && second.enabled) {
            if (touching()) {
                if (not_same_height()) {
                    player_kill(this.highest(), this.lowest());
                } else {
                    repel_each_other(this.leftmost(), this.rightmost());
                }
            }
        }
    };

    function touching() {
        return (
            Math.abs(first.x.pos - second.x.pos) < 0xc0000 &&
            Math.abs(first.y.pos - second.y.pos) < 0xc0000
        );
    }

    function not_same_height() {
        return Math.abs(first.y.pos - second.y.pos) >> 16 > 5;
    }

    function repel_each_other(left_player, right_player) {
        if (right_player.x.velocity > 0) left_player.x.pos = right_player.x.pos - 0xc0000;
        else if (left_player.x.velocity < 0) right_player.x.pos = left_player.x.pos + 0xc0000;
        else {
            left_player.x.pos -= left_player.x.velocity;
            right_player.x.pos -= right_player.x.velocity;
        }
        var l1 = left_player.x.velocity;
        left_player.x.velocity = right_player.x.velocity;
        right_player.x.velocity = l1;
        if (right_player.x.velocity < 0) right_player.x.velocity = -right_player.x.velocity;
        if (left_player.x.velocity > 0) left_player.x.velocity = -left_player.x.velocity;
    }

    function player_kill(killer, victim) {
        killer.y.velocity = -killer.y.velocity;
        if (killer.y.velocity > -262144) killer.y.velocity = -262144;
        killer.jump_abort = true;
        victim.dead_flag = true;
        if (victim.anim != 6) {
            victim.set_anim(6);
            if (!settings.no_gore) {
                objects.add_gore(victim.x.pos, victim.y.pos, victim.player_index);
            }
            sfx.death();
            killer.bumps++;
            killer.bumped[victim.player_index]++;
        }
    }
}
