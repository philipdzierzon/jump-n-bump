// `quiet()` says the tick being stepped is one already heard: a rewind steps it again, and
// a jump that only happens in the replay makes no sound either (#141).
export function Sfx(sound_player, quiet) {
    "use strict";
    function playOnce(filename_without_extension) {
        return function () {
            if (quiet && quiet()) return;
            sound_player.play_sound(filename_without_extension, false);
        };
    }

    this.jump = playOnce("jump");
    this.death = playOnce("death");
    this.spring = playOnce("spring");
    this.splash = playOnce("splash");
    this.fly = playOnce("fly");
    this.music = function () {
        sound_player.play_sound("bump", true);
    };
}
