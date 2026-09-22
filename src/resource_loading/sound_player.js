// Every sound the game owns. Preloaded once and reused: play_sound used to create an
// <audio> element per event and reclaim it only once it reached `ended`, which an
// autoplay-blocked or still-loading element never does -- so elements accumulated
// until the main thread died (#30). The owner is the session rather than the match, for
// the same reason one level up: a repair rebuilt the match, and its six elements with it
// (#91).
const SFX_NAMES = ["bump", "death", "fly", "jump", "splash", "spring"];

export function Sound_Player(muted) {
    var self = this;
    var sounds = {};

    var sfx_extension = document.createElement("audio").canPlayType("audio/mpeg") ? "mp3" : "ogg";
    for (var i = 0; i < SFX_NAMES.length; i++) {
        var audio = document.createElement("audio");
        audio.src = "sound/" + SFX_NAMES[i] + "." + sfx_extension;
        audio.load();
        sounds[SFX_NAMES[i]] = audio;
    }

    function play(audio) {
        // A blocked autoplay rejects; it is not an error worth surfacing, but an
        // unhandled rejection per sound event is noise.
        var started = audio.play();
        if (started) started.catch(function () {});
    }

    this.set_muted = function (val) {
        muted = val;
        for (var name in sounds) {
            var audio = sounds[name];
            if (val) audio.pause();
            else if (audio.loop) play(audio);
        }
    };

    this.toggle_sound = function () {
        self.set_muted(!muted);
    };

    this.play_sound = function (sfx_name, loop) {
        var audio = sounds[sfx_name];
        // The looping track is the session's, not the build's: a repair rebuilds `Sfx` and
        // asks for the music again, and rewinding it to zero is heard as the track starting
        // over. Already looping means already playing -- `set_muted(false)` picks it up from
        // where the repair paused it (#91).
        // ponytail: one looping sound, and `bump` is never played as a one-shot, so "is the
        // loop flag set" is the same question as "is this the track already running".
        // upgrade path: compare the element's own `src` if a second loop is ever added.
        if (loop && audio.loop) return;
        audio.loop = !!loop;
        audio.currentTime = 0;
        if (!muted) play(audio);
    };
}
