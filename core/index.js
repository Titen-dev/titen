// Public API of the Titen core (used by the CLI now and the web server in Phase 2).
export { getTrends, REGIONS, CATEGORIES } from './features/trends.js';
export { getBrief, WEB_TOPICS } from './features/brief.js';
export { getTldr } from './features/tldr.js';
export { checkScam, SCAM_DISCLAIMER, MAX_IMAGE_BYTES } from './features/scam.js';
export { ChatAgent } from './agent.js';
export { getConfig, saveConfigFile, readConfigFile, configFile, DEFAULT_MODEL } from './config.js';
export { checkKey } from './llm.js';
export { TitenError, ErrorCodes } from './errors.js';
export { createCache } from './cache.js';
