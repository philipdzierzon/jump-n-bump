import { Animation_Data } from "../asset_data/animation_data.js";

// Shared simulation constants. Lives in src/game/ rather than the composition root
// so the simulation imports nothing from src/interaction/ and runs headless (#5).
export const env = {
    JNB_MAX_PLAYERS: 4,
    MAX_OBJECTS: 200,
    animation_data: new Animation_Data(),
};
