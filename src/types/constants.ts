/**
 * Constants for Arbitrum Chain Playbook
 */

// =============================================================================
// Docker Configuration
// =============================================================================

/** Standard Nitro node Docker image */
export const DOCKER_IMAGE = 'offchainlabs/nitro-node:v3.9.5-66e42c4';

/** Malicious validator image with ReadInboxMessage bit-flip support (Challenge Demo) — must be built locally */
export const DOCKER_IMAGE_MALICIOUS = 'nitro-malicious-playbook-challenge-demo:latest';

/** Standard Nitro validator image for honest validator (Challenge Demo) */
export const DOCKER_IMAGE_HONEST = 'offchainlabs/nitro-node:v3.9.6-91bf578-validator';

/** Malicious ArbMinter image for Malicious Mint Demo */
export const DOCKER_IMAGE_MALICIOUS_ARBMINTER = 'jasonwan123/nitro-node-malicious-arbminter';

/** Docker container name prefix */
export const CONTAINER_NAME_PREFIX = 'nitro';

/** Environment variable set by the headless runner to label Docker containers. */
export const HEADLESS_SESSION_ENV = 'ARBITRUM_CHAIN_PLAYBOOK_HEADLESS_SESSION_ID';

/** Docker labels applied only to headless-run containers. */
export const HEADLESS_DOCKER_MODE_LABEL = 'arbitrum-chain-playbook.mode';
export const HEADLESS_DOCKER_SESSION_LABEL = 'arbitrum-chain-playbook.session';

/** Default Docker data directory inside container */
export const DOCKER_DATA_DIR = '/home/user/.arbitrum';

/** Docker user ID for container */
export const DOCKER_USER = '1000:1000';

// =============================================================================
// Node Configuration Files
// =============================================================================

/** Main node config filename */
export const NODE_CONFIG_FILENAME = 'node-config.json';

/** Malicious validator node config filename */
export const NODE_CONFIG_MALICIOUS_FILENAME = 'node-config-malicious.json';

/** Honest validator node config filename */
export const NODE_CONFIG_HONEST_FILENAME = 'node-config-honest.json';

/** Node config path inside Docker container */
export const DOCKER_NODE_CONFIG_PATH = '/home/user/node-config.json';

// =============================================================================
// Chain Deployment Configuration
// =============================================================================

/** Base stake amount for validators (in ETH) */
export const BASE_STAKE_ETH = '0.00001';

/** Test tokens amount to send to batch poster (in ETH) */
export const TEST_TOKENS_AMOUNT_ETH = '0.001';

/** Tokens amount to send to validators for challenge participation (in ETH) */
export const VALIDATOR_AMOUNT_ETH = '0.025';

/** Default confirm period blocks for the rollup */
export const CONFIRM_PERIOD_BLOCKS = 1600n;

/** Confirm period blocks for Challenge Demo */
export const CHALLENGE_CONFIRM_PERIOD_BLOCKS = 1600n;

/** Confirm period blocks for Malicious Mint Demo (short for quick withdrawal) */
export const MALICIOUS_MINT_CONFIRM_PERIOD_BLOCKS = 16n;

/** Minimum assertion period (in blocks) */
export const MINIMUM_ASSERTION_PERIOD = 1n;

/** ETH deposit amount for L2 funding (in ETH) */
export const L2_DEPOSIT_AMOUNT_ETH = '0.001';

// =============================================================================
// Network Configuration
// =============================================================================

/** Default starting port for node HTTP (and WS uses +1) */
export const DEFAULT_START_PORT = 30303;

/** Default main node HTTP port */
export const DEFAULT_MAIN_NODE_HTTP_PORT = 8449;

/** Port increment between nodes */
export const PORT_INCREMENT = 10;

/** Transport timeout for RPC calls */
export const TRANSPORT_TIMEOUT_MS = 3_000;

// =============================================================================
// Local Data Directories
// =============================================================================

/** Local arbitrum data directory name */
export const LOCAL_DATA_DIR = '.arbitrum';

// =============================================================================
// Application Metadata
// =============================================================================

/** Application name */
export const APP_NAME = 'Arbitrum Chain Playbook';

/** Default chain name for deployment */
export const DEFAULT_CHAIN_NAME = 'My Arbitrum Chain';
