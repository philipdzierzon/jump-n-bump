// Every sound the game owns. Preloaded once and reused: play_sound used to create an
// <audio> element per event and reclaim it only once it reached `ended`, which an
// autoplay-blocked or still-loading element never does -- so elements accumulated
// until the main thread died (#30). The owner rose from the match to the session next,
// because a repair rebuilt the match and its six elements with it (#91), and from the
// session to the page after that, because nothing ever released a session's set and a
// session is rebuilt on every room entry *and* every walk between the lobby and the match
// (`viewmodels.js`) -- two sets a lap, and no end to it (#123).
//
// It is not reached through `new` any more, and that is the point: `shared_sound_player`
// below is the only way in, so there is no second set of elements to leak.
const SFX_NAMES = ["bump", "death", "fly", "jump", "splash", "spring"];

function Sound_Player() {
    var self = this;
    var sounds = {};
    // Not a preference of this player's, though it outlives every session that drives it:
    // whichever session is in a match writes its own `muted` in here through `set_muted` on
    // every entry into one, and M toggles the two together (`game_session.js`). This is only
    // what holds until the first session speaks for it, which is why it is no longer handed
    // in -- there is no one session whose value it would be.
    var muted = false;

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

    // The track back to the top, for a match that is beginning rather than being repaired:
    // `play_sound` below leaves a running loop where it is, and this player outlives every
    // match and room that asks for it, so without this the next match picked the track up
    // wherever the last one had left it (#146). Paused already -- `on_start` mutes first.
    this.rewind = function () {
        for (var name in sounds) sounds[name].currentTime = 0;
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

// One player, built on the first session that needs it and kept for the tab. Nothing ever
// tore a session's player down, and a session is rebuilt on every room entry and on every
// walk between the lobby and the match -- so a browse in, a match and a browse out cost two
// sets of six decoded elements, for good (#123).
//
// Sharing is right here and was wrong one level down: what `Sfx` holds is a match's, and a
// repair rebuilds the match (#91). What this holds is six decoded files, and a file is
// neither a match's nor a room's.
//
// ponytail: one player per module instance, and no way to ask for a fresh one -- a test
// that wanted a player with no history would have to reload the page, which is what every
// walk in `browser.test.mjs` already does. upgrade path: a `reset` export, if anything ever
// needs two players on one page.
var shared = null;
export function shared_sound_player() {
    if (!shared) shared = new Sound_Player();
    return shared;
}
