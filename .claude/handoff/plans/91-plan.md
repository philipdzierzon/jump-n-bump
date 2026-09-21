# #91 — A repair leaks its six audio elements

Read at `/Users/philipdzierzon/Documents/sbx/jumpnbump/jump-n-bump`, `master` @ `af04c21`.
All line numbers below are that commit.

**Shape of the fix in one line:** stop building a `Sound_Player` per match, build one per
session — then there is no outgoing player to release, and nothing to free. Deletion, not a
`release()` method.

---

## 1. What the code does today

### The repair path

`src/interaction/game_session.js:158` `room.on_start` is the one entry for *both* a match
starting and a repair landing:

```js
        repairing = self.in_match && !!msg.snapshot;          // :162
        if (repairing) repaired_at = Date.now();
        self.in_match = true;
        if (game) game.pause();                                // :172
        // Which it really did: `build` makes a Sound_Player per match, so the outgoing
        // one's looping music has to be stopped here rather than on the way to the lobby.
        if (sound_player) sound_player.set_muted(true);         // :177
        ...
        get_level(room.settings.level).then(function (level) {  // :189
            if (mine === starting) build(level);
        }, noop);
```

`build()` then constructs a whole fresh object graph, sound included
(`src/interaction/game_session.js:265-272`):

```js
        var renderer = new Renderer(canvas, img, level);
        objects = new Objects(rnd);
        var ai = new AI();
        var animation = new Animation(renderer, img, objects, rnd);
        sound_player = new Sound_Player(muted);                 // :269  <-- the leak
        sfx = new Sfx(sound_player);
```

`sound_player` is the session's only reference to the old player
(`src/interaction/game_session.js:92`, `var sound_player = null;`). Line 269 overwrites it.
The old player's six elements are **paused** by `:177` and then unreferenced *by the
session* — but the session is the only thing that ever pointed at them, so "release" and
"drop the reference" are the same act, and today's code already drops it. The leak is not a
missing `release()`; the leak is that the elements were **made at all**.

### What a `Sound_Player` costs

`src/resource_loading/sound_player.js:5-17`:

```js
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
```

Seven `<audio>` elements per construction (six plus the throwaway `canPlayType` probe), each
one `load()`ed — i.e. fetched and decoded. None of them is ever appended to the document, so
`document.querySelectorAll("audio")` is empty and a leak is invisible from the DOM.

**There is nothing per-match in this object.** Six fixed `src`es, a `muted` flag and a `loop`
flag. Rebuilding it per match is pure waste; rebuilding it per *repair* is the bug.

The file's own header comment records the same fix one level down: `play_sound` used to make
an element per *event* and the answer was "preloaded once and reused" (`sound_player.js:1-4`,
#30). This issue is that sentence applied one level up.

### Where music comes from, and what a repair does to it

- `src/game/sfx.js:14-16` — `music()` is `play_sound("bump", true)`; `"bump"` is never played
  as a one-shot, so the looping track is the only looping sound in the game.
- `src/interaction/game_session.js:418-425`:

```js
    this.start = function () {
        if (!game) {
            start_when_ready = true;
            return;
        }
        sfx.music();
        play();
    };
```

- `play()` (`:358-372`) calls `sound_player.set_muted(muted)`, and `set_muted(false)`
  restarts anything whose `loop` is set (`sound_player.js:26-33`).

A repair reaches `start()`: `build()` ends with `if (self.on_match_start) self.on_match_start();`
(`:293`) → `viewmodels.js:605-620` `game.on_match_start` → `go("play")` → the hash is already
`#play`, so `go` applies the route by hand (`viewmodels.js:414-418`) → `apply_route` →
`viewmodels.js:931` `self.current_game().start()`.

So **today a repair does restart the music from zero**: `play_sound` unconditionally does
`audio.currentTime = 0` (`sound_player.js:42`) on the *new* element. Nothing guarantees
criterion 4 today — the issue's "find what guarantees that" has the answer "nothing does".
What exists today is only the *anti*-doubling guard at `:177`, which pauses the outgoing
player so two tracks are not heard at once (#28, #40).

### Session lifetime — what "once per room lifetime" can mean

`viewmodels.js:547-548` builds a `Game_Session` only when there is none, and
`end_match()` (`viewmodels.js:544`) drops it (`self.current_game(null)`) on any route away
from `#play`. So: **one session per lobby visit**, and a repair never crosses a session
boundary. One `Sound_Player` per session therefore means:

- zero new elements per repair (criteria 1 and 2), and
- the *same* bump element across a repair, so it can be resumed rather than rewound
  (criterion 4).

It does **not** mean one element per room across matches — walking to the lobby and starting
the next match builds a new session, and the existing suite asserts the next match opens on
its music (`test/browser.test.mjs:1294-1298`). See §5 for that reading being flagged, not
silently widened.

### What the suite sees today

`test/browser.test.mjs:98-111` patches `HTMLMediaElement.prototype.play` in an init script
per context:

```js
function record_audio() {
    window.__audio = new Set();
    window.__sounds = [];
    window.__sounding = () => ...
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        window.__audio.add(this);
        window.__sounds.push(this.src.split("/").pop());
        return play.apply(this, arguments);
    };
}
```

Helpers: `sounding()` (`:202`), `sounds()` (`:204`, "every play() in order" — the criterion-3
assertion lives at `:1294-1298` and `:1357-1362`), `forget_sounds()` (`:205`), `music()`
(`:208-222`, reads the *first* bump element out of `__audio`).

Note `__audio` only ever holds elements that were **played**. A leaked-but-silent element is
invisible to it. That is why the new count is taken at construction (§3).

The repair walk is `test/browser.test.mjs:943-956` (room `room_d`): a raw relay client
`boss` hosts, sends one snapshot, then eight checksums the page disagrees with; the page is
repaired and `.reconnecting` comes up.

---

## 2. The change, criterion by criterion

Two files, four edits, net **+6 / −2** lines of source.

### Edit A — one `Sound_Player` per session, not per match (criteria 1 and 2)

**File** `src/interaction/game_session.js`, **function** `Game_Session` (the constructor body)
and `build`.

Current, `:90-92`:

```js
    var game = null;
    var sfx = null;
    var sound_player = null;
```

Replace `:92` with:

```js
    // One per session, which is one per lobby visit: the six elements hold nothing to do
    // with a match, and `build` making a set per match left the outgoing set paused,
    // decoded and alive -- ninety of them a minute on a client being repaired every two
    // seconds, which is exactly the client that could least afford them (#91, #30).
    var sound_player = new Sound_Player(muted);
```

Current, `:269`:

```js
        sound_player = new Sound_Player(muted);
        sfx = new Sfx(sound_player);
```

becomes just:

```js
        sfx = new Sfx(sound_player);
```

`Sfx` is a stateless wrapper over `sound_player` (`src/game/sfx.js`); leave it rebuilt per
match — moving it saves nothing and grows the diff.

That is the whole of criteria 1 and 2: there is no outgoing player, so there is nothing to
release, and a repair's element count is zero by construction rather than by being freed.

**Do not add a `Sound_Player.release()`.** See §5 for why, and for the platform evidence.

### Edit B — the stale comments that Edit A falsifies (no behaviour)

1. `src/interaction/game_session.js:173-176` currently reads:

```js
        // Which it really did: `build` makes a Sound_Player per match, so the outgoing
        // one's looping music has to be stopped here rather than on the way to the lobby.
        // Leaving the match muted the old one by accident; a resync never passes through
        // the lobby at all, and doubled the music instead (#28, #40).
        if (sound_player) sound_player.set_muted(true);
```

The premise is gone. Keep the *line* — it is still wanted: it silences the gap between a
`start` landing and the level resolving, and it is what keeps a failed level load from
looping music over a frozen frame. Drop the now-always-true guard and say why it stays:

```js
        // The simulation about to be replaced must not be heard over the gap: the pump is
        // paused above, the level is still to resolve, and a load that fails leaves the
        // match here. `play` un-mutes it again, from where the track had got to rather
        // than from the top (#28, #40, #91).
        sound_player.set_muted(true);
```

2. `src/interaction/game_session.js:413`, in `this.stop`:

```js
        if (sound_player) sound_player.set_muted(true);
```

→ `sound_player.set_muted(true);` (never null now).

3. `src/resource_loading/sound_player.js:1-4` header — extend the existing "preloaded once
and reused" note to say the owner is the session, not the match.

4. `test/browser.test.mjs:94` — "A match builds one Sound_Player" becomes "A session builds
one Sound_Player". Same sentence, one word.

### Edit C — a repair resumes the music, it does not rewind it (criterion 4)

**File** `src/resource_loading/sound_player.js`, **function** `play_sound`.

Current, `:39-44`:

```js
    this.play_sound = function (sfx_name, loop) {
        var audio = sounds[sfx_name];
        audio.loop = !!loop;
        audio.currentTime = 0;
        if (!muted) play(audio);
    };
```

becomes:

```js
    this.play_sound = function (sfx_name, loop) {
        var audio = sounds[sfx_name];
        // The looping track is the match's, not the build's: a repair rebuilds `Sfx` and
        // asks for the music again, and rewinding it to zero is heard as the track
        // starting over. Already looping means already playing -- `set_muted(false)`
        // picks it up from where the repair paused it (#91).
        // ponytail: one looping sound, and `bump` is never played as a one-shot, so "is
        // the loop flag set" is the same question as "is this the track already running".
        // upgrade path: compare the element's own `src` if a second loop is ever added.
        if (loop && audio.loop) return;
        audio.loop = !!loop;
        audio.currentTime = 0;
        if (!muted) play(audio);
    };
```

Why this is the right place rather than a guard at the `sfx.music()` call site: `Sfx` is
rebuilt per match so it cannot remember, and `this.start` (`game_session.js:418`) is reached
from `apply_route` on every `#play` navigation, not only from a repair. One guard on the
element that owns the fact beats a guard per caller.

Trace with Edits A and C in place, on a repair:

| step | element state |
| --- | --- |
| `on_start` `set_muted(true)` (`:177`) | paused, `loop` still true, `currentTime` kept |
| `build` `set_muted(true)` (`:285`, silent catch-up) | unchanged |
| `start()` → `sfx.music()` | **no-op** (guard) — no rewind, no second `play()` |
| `play()` → `set_muted(false)` (`:361`) | resumes from the kept `currentTime` |

At a *fresh* match start the element is new (`loop === false`), so `sfx.music()` behaves
exactly as today: rewind, set the loop, play — `test/browser.test.mjs:1294-1298` still sees
`bump.mp3` as the first recorded sound.

### Edit D — criterion 3 needs no code

`Sfx` is rebuilt over the same player; `play_sound` is unchanged for every one-shot; nothing
about ordering moves. The assertions at `:1294-1298` and `:1357-1362` keep passing (checked
in §4).

---

## 3. Tests

One file: `test/browser.test.mjs`. Two additions, both inside the existing `room_d` repair
walk, in that file's idiom (helpers at the top, assertions inline in the walk).

### 3a. Count elements as they are made (harness, `record_audio` at `:98`)

`__audio` only holds elements that have played, so it cannot see a silent leak, and the
elements are never in the document, so `querySelectorAll` cannot either. Count the
constructions:

```js
function record_audio() {
    window.__audio = new Set();
    window.__sounds = [];
    // Counted as they are made rather than as they are played: a leaked <audio> is one
    // nothing plays again, and Sound_Player keeps them out of the document, so there is
    // nothing to querySelectorAll for (#91).
    // ponytail: this counts elements made, not elements still alive -- it proves a repair
    // makes none, which is the fix, not that a made one was freed. upgrade path: a heap
    // snapshot through CDP if a leak ever survives this.
    window.__audio_made = 0;
    const create = document.createElement.bind(document);
    document.createElement = function (tag) {
        if (String(tag).toLowerCase() === "audio") window.__audio_made++;
        return create.apply(null, arguments);
    };
    window.__sounding = () => ...          // unchanged from here down
```

Helper next to `sounds()` (after `:205`):

```js
// Every <audio> this page has made, leaked ones included: six per Sound_Player plus the one
// `canPlayType` is probed on (#91).
const audio_made = (root = page) => root.evaluate(() => window.__audio_made);
```

### 3b. The assertions (walk, around `:952-956`)

```js
    boss.send({
        type: "snapshot",
        ...
    });
    // #91: a repair used to build a second Sound_Player and merely mute the first, leaving
    // its six decoded elements alive. A client repaired every two seconds orphaned ninety
    // of them a minute -- on exactly the machine that was already short of everything.
    const audio_before = await audio_made();
    for (let t = 30; t <= 240; t += 30) boss.send({ type: "checksum", t, h: 1 });
    await until("the repair to land", () => page.locator(".reconnecting").isVisible());
    assert.equal(
        await audio_made(),
        audio_before,
        "a repair makes no audio elements at all, so a run of them cannot pile up (#91)",
    );
    // And it is the same track it was playing, not a second copy started from the top.
    // Counted rather than required, exactly as the loop count above is: a browser that
    // refused to autoplay has no bump element here to count.
    const bumps = await page.evaluate(
        () => [...window.__audio].filter((audio) => /bump\.\w+$/.test(audio.src)).length,
    );
    assert.ok(bumps <= 1, "one session, one music element: " + bumps + " (#91)");
    await click("Back to the lobby");
```

**Why no extra wait before the assertion.** `repaired_at` is stamped in `on_start`
(`game_session.js:163`) but `.reconnecting` is only raised by `sample_chrome` on a 250 ms
interval (`:343`, `:367`); `room_d`'s match runs the default level, which `get_level`
resolves as an already-made promise (`viewmodels.js:244`), so `build()` has run in a
microtask long before the next 250 ms sample. The `until` is therefore already past the
rebuild. On `master` both assertions go red (7 new elements, 2 bump elements); with the fix
both are green.

**Red/green check before committing:** stash nothing — just run `npm test` with Edit A
reverted to confirm the new assertions fail, then restore. (`npm test` builds the client
first; the browser needs `npx playwright install chromium` once.)

---

## 4. Risks

- **Callers of `Sound_Player`**: only `game_session.js` constructs one; only `src/game/sfx.js`
  calls into it (`play_sound`), and only `game_session.js` calls `set_muted`/`toggle_sound`
  (`:177`, `:285`, `:361`, `:383`, `:413`, `:434`). Nothing else in `src/`, `server/` or
  `test/` mentions it. Full list checked by grep.
- **`play_sound` callers**: `Sfx` only — five one-shots with `loop` falsy (unaffected by the
  guard) and `music()` with `loop` true (the only path the guard touches).
- **Construction moves into the lobby.** Six `load()`s now start when a client reaches
  `#room` instead of when the match builds. Strictly earlier preloading; no assertion in the
  suite depends on when the fetches happen, and `play()` is still what records a sound.
- **Assertions that must keep passing** (all re-read against the change):
  - `:836-837` "one match, one music" — one player per session, so at most one looping
    element. Still ≤ 1.
  - `:900` and `:971` `sounding()` is `[]` after leaving a match — `this.stop` still calls
    `set_muted(true)`, which still pauses every element (Edit B keeps the call).
  - `:1294-1298` "a match opens on its music", `bump.mp3` first — fresh session per match,
    `loop === false`, guard does not fire.
  - `:1307-1318` decoded, looping, moving through the file — same element, unchanged path.
  - `:1323`/`:1348` `death.mp3` / `jump.mp3` land in order — one-shots, untouched.
  - `:1357-1362` "muted is silent, not quiet" — `set_muted(true)` unchanged, `play_sound`
    still checks `muted` before playing.
- **A second `start` that is a new match, not a repair** (host starts another match while
  this client plays one): the session survives, so the *same* bump element is reused and
  Edit C's guard makes it resume rather than restart. That is a real, audible behaviour
  change beyond a repair — the track carries on across the match boundary instead of
  beginning again. It is the same property criterion 4 asks for, and no assertion covers it;
  call it out in the PR body.
- **Sessions still accumulate a player per lobby visit.** Unchanged by this issue, and
  bounded by matches played, not by repairs. See §5.

---

## 5. Deliberately not doing

- **A `Sound_Player.release()` / `dispose()` (`pause()` + `src = ""` + `load()`).** The
  session already drops its only reference at `game_session.js:269`; the elements the issue
  is about are ones that should never have been made. Adding a release method would be a
  second mechanism for a problem the first edit deletes. *(Evidence on the platform question,
  since the brief asks for it: an `<audio>` outside the document with no remaining references
  is collectible, but the HTML spec keeps a media element alive while it has "pending
  activity" — playing, or still fetching its resource — and the accepted way to end that
  early is `pause(); removeAttribute("src"); load();`, which runs the resource-selection
  algorithm and empties the element. That is what a `release()` would have had to do. I have
  not measured which engines collect a merely-paused one and when, and the plan deliberately
  does not need to know: making none is strictly stronger than freeing them well.)*
- **Reusing the object graph across a repair.** Out of scope by the issue (#70/#73 §3).
- **Hoisting the player above the session (one per page).** A session is built per lobby
  visit, so ~7 elements per match played still accumulate over a long sitting — a real but
  far slower leak than #91's, and sharing one player across sessions needs a mute/ownership
  rule between the outgoing and incoming session that this issue has no evidence for. File
  it separately if a long-lived tab ever shows it.
- **Deduplicating the `canPlayType` probe element** (`sound_player.js:11`) — one element per
  session, and hoisting it to module scope is a change with no reported symptom.
- **Asserting "music not restarted" by reading `music().t` across the repair.** It would
  require the flow walk to depend on autoplay, which that walk deliberately avoids ("counts
  rather than requires", `:834-837`); the sound walk, which does require it, has no relay and
  so cannot be repaired. The element count in §3b covers the same ground without the
  dependency, and the gap — that a single element could still be rewound — is named here
  rather than papered over.
- **Anything in the criteria that should not be built:** none of the four, but criterion 4's
  "once per room lifetime" is read as *"one music element per session, and a repair neither
  rebuilds nor rewinds it"*. Taken literally it would also forbid the next match in the same
  room from starting the track over, which `test/browser.test.mjs:1294-1298` asserts it does
  and which no part of the issue argues against. Flagging the reading rather than widening
  the work.

---

## 6. Checklist for the implementer

1. `src/interaction/game_session.js:92` — construct the player there (Edit A).
2. `src/interaction/game_session.js:269` — delete the construction (Edit A).
3. `src/interaction/game_session.js:173-177`, `:413` — comments and the dead null guards
   (Edit B).
4. `src/resource_loading/sound_player.js:1-4`, `:39-44` — header comment and the loop guard
   (Edits B, C).
5. `test/browser.test.mjs:94`, `:98`, after `:205`, `:952-956` — comment, counter, helper,
   assertions (§3).
6. `npm run format` (Prettier, pinned; `tabWidth: 4`, `printWidth: 100`), then `npm test`.
