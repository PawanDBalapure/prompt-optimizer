/** Shared string keys and limits used across the extension. */
export const CHAT_PARTICIPANT_ID = 'pawanbalapure.promptoptimizer';

// Storage keys (globalState).
export const SESSION_BUFFER_KEY = 'promptProxy.history';
export const LAST_ANALYSIS_KEY = 'promptProxy.lastAnalysis';
export const SEEDING_DONE_KEY = 'promptProxy.seeded';
/** Tracks whether the first-ever workspace bootstrap completed. Unlike
 *  SEEDING_DONE_KEY, this is checked once per workspace and never expires —
 *  it guarantees a fresh install always performs the heavy initial harvest. */
export const BOOTSTRAP_DONE_KEY = 'promptProxy.bootstrapped';
export const CONVERSATION_KEY = 'promptProxy.conversation';
export const MODE_KEY = 'promptProxy.mode';
export const TARGET_MODEL_KEY = 'promptProxy.targetModel';
export const DENSITY_KEY = 'promptProxy.density';
export const PASSIVE_EVENTS_KEY = 'promptProxy.passiveEvents';
/** Pending (analyzed-but-not-yet-sent) optimization awaiting user confirmation. */
export const PENDING_OPTIMIZATION_KEY = 'promptProxy.pendingOptimization';

// Bounds.
export const MAX_SESSION_ITEMS = 8;
export const MAX_CHAT_HISTORY_ITEMS = 6;
export const MAX_CONVERSATION_TURNS = 12;
export const MAX_PASSIVE_EVENTS = 20;
/** Re-seed at most once every 24 h to pick up new Copilot history. */
export const SEEDING_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Continuous chat-history enrichment cadence while VS Code stays open. */
export const ENRICH_INTERVAL_MS = 15 * 60 * 1000;
