// Every sound the game owns. Preloaded once and reused: play_sound used to create an
// <audio> element per event and reclaim it only once it reached `ended`, which an
// autoplay-blocked or still-loading element never does -- so elements accumulated
// until the main thread died (#30).
const SFX_NAMES = ["bump", "death", "fly", "jump", "splash", "spring"];

export function Sound_Player(muted) {
    var self = this;
    var sounds = {};

    var sfx_extension = document.createElement('audio').canPlayType('audio/mpeg') ? 'mp3' : 'ogg';
    for (var i = 0; i < SFX_NAMES.length; i++) {
        var audio = document.createElement('audio');
        audio.src = "sound/" + SFX_NAMES[i] + "." + sfx_extension;
        audio.load();
        sounds[SFX_NAMES[i]] = audio;
    }

    function play(audio) {
        // A blocked autoplay rejects; it is not an error worth surfacing, but an
        // unhandled rejection per sound event is noise.
        var started = audio.play();
        if (started) started.catch(function () { });
    }

    this.set_muted = function (val) {
        muted = val;
        for (var name in sounds) {
            var audio = sounds[name];
            if (val) audio.pause();
            else if (audio.loop) play(audio);
        }
    }

    this.toggle_sound = function () {
        self.set_muted(!muted);
    };

    this.play_sound = function (sfx_name, loop) {
        var audio = sounds[sfx_name];
        audio.loop = !!loop;
        audio.currentTime = 0;
        if (!muted) play(audio);
    };
};
