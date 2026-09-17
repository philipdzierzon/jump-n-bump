import { Animation_Data } from "../asset_data/animation_data.js";

// Shared simulation constants. Lives in src/game/ rather than the composition root
// so the simulation imports nothing from src/interaction/ and runs headless (#5).
export const env = {
    JNB_MAX_PLAYERS: 4,
    MAX_OBJECTS: 200,
    // A minute of simulation, which is what a room's time limit is counted in: the limit
    // is ticks and is fixed at match start, never a wall clock, so every client ends the
    // match on the tick every other client ends it on (#39).
    TICKS_PER_MINUTE: 60 * 60,
    animation_data: new Animation_Data(),
};
