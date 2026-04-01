# Developer Guide

This document covers the architecture, key interfaces, and development guidelines for the Arbitrum Chain Playbook.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Project Structure](#project-structure)
- [Key Interfaces](#key-interfaces)
  - [ChainEnv Singleton](#chainenv-singleton)
  - [SendersEnv Singleton](#sendersenv-singleton)
  - [NodeManager](#nodemanager)
  - [NodeController](#nodecontroller)
  - [OperationGuard](#operationguard)
  - [ConfigService](#configservice)
- [Playbook Interface](#playbook-interface)
- [Adding a New Playbook](#adding-a-new-playbook)
- [Development Commands](#development-commands)
- [Testing](#testing)

## Architecture Overview

The application follows a layered architecture with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────────┐
│                      Menu Layer (UI)                        │
│  mainMenu.ts, nodeController.ts, playbooks                  │
├─────────────────────────────────────────────────────────────┤
│                    Business Logic Layer                     │
│  NodeManager, ManageChainOperations, deployChain            │
├─────────────────────────────────────────────────────────────┤
│                      State Layer                            │
│  ChainEnv (singleton), SendersEnv (singleton)               │
├─────────────────────────────────────────────────────────────┤
│                    Infrastructure Layer                     │
│  Docker, ConfigService, Guards, Logger                      │
└─────────────────────────────────────────────────────────────┘
```

**Design Principles**:

1. **UI/Business Separation**: UI logic (inquirer prompts) is in Controllers, business logic is in Managers
2. **Centralized State**: `ChainEnv` and `SendersEnv` singletons manage all application state
3. **Guard Pattern**: Common validation checks are centralized in `OperationGuard`
4. **Configuration Service**: Environment variables and constants are accessed via `ConfigService`

## Project Structure

```
src/
├── index.ts                    # Application entry point
├── init.ts                     # App initialization logic
├── config/                     # Configuration management
│   └── index.ts                # ConfigService singleton
├── devnode/                    # Devnode mode
│   ├── devnodeConfig.ts        # Devnode configuration
│   ├── devnodeManager.ts       # Devnode lifecycle management
│   ├── devnodeMode.ts          # Mode setup
│   └── devnodeNodeManager.ts   # NodeManager wrapper for devnode
├── remoteRpc/                  # Remote RPC mode
│   ├── remoteRpcMode.ts        # Mode setup and validation
│   └── remoteRpcConfig.ts      # Remote RPC configuration
├── menu/                       # Main menu system
│   └── mainMenu.ts             # Interactive CLI menu
├── core/                       # Core functionality
│   ├── deployChain/            # Chain deployment
│   │   ├── deployChain.ts      # Deployment implementation
│   │   └── prepareNodeConfig.ts # Node config preparation
│   ├── docker/                 # Docker/Node management
│   │   ├── nodeManager.ts      # NodeManager (business logic)
│   │   ├── nodeController.ts   # NodeController (UI logic)
│   │   └── nodeConfigExtractors.ts # Config extractors
│   ├── manageChain/            # Chain management
│   │   └── manageChainOperations.ts # TPS/gas configuration
│   ├── interactChain/          # Chain interaction
│   │   └── interactChainOperations.ts
│   ├── nodeConfig/             # Node config operations
│   │   └── nodeConfigOperations.ts
│   └── monitoring/             # Process monitoring
│       └── processMonitor.ts
├── state/                      # State management
│   ├── chainEnv/               # ChainEnv singleton
│   │   ├── index.ts            # ChainEnv class
│   │   ├── types.ts            # Related types
│   │   ├── persistence.ts      # Load/save state
│   │   ├── fromTxHash.ts       # State from tx hash
│   │   └── accessors/          # Accessor classes
│   │       ├── statusAccessor.ts
│   │       ├── nodeConfigAccessor.ts
│   │       └── chainConfigAccessor.ts
│   └── sendersEnv/             # SendersEnv singleton
│       ├── index.ts
│       └── types.ts
├── playbooks/                  # Playbook modules
│   ├── types.ts                # Playbook interface
│   ├── index.ts                # Playbook registry
│   ├── malicious-validator/    # Example playbook
│   └── tps-test/               # TPS test playbook
├── types/                      # Shared types
│   ├── index.ts                # Enums, interfaces
│   └── constants.ts            # Application constants
└── utils/                      # Utilities
    ├── logger.ts               # Logging utilities
    ├── guards.ts               # OperationGuard class
    ├── nodeConfigUtils.ts      # Node config helpers
    └── inquirerUtils.ts        # Inquirer helpers

tests/                          # Test suites
└── core/docker/
    └── nodeManager.spec.ts
```

## Key Interfaces

### ChainEnv Singleton

The central singleton for managing chain lifecycle and state.

```typescript
import { ChainEnv } from './state/chainEnv';

const chainEnv = ChainEnv.getInstance();
```

**Accessors**:

| Accessor | Methods | Description |
|----------|---------|-------------|
| `chainEnv.status` | `isInitiated()`, `get()`, `set(status)` | Chain status management |
| `chainEnv.nodeConfig` | `get()`, `getPath(type)`, `setPath(type, path)` | Node configuration |
| `chainEnv.chainConfig` | `get()`, `getChainId()`, `getCoreContracts()` | Chain configuration |
| `chainEnv.nodeManager` | NodeManager instance | Docker node control |
| `chainEnv.parentChainClient` | PublicClient | Parent chain RPC client |

**Lifecycle Methods**:

```typescript
// Load/save chain configuration
chainEnv.load(): boolean
chainEnv.save(): void
chainEnv.reset(): void

// Set deployment result
chainEnv.setDeploymentResult(chainConfig, nodeConfig, coreContracts, nodeConfigPaths): void

// Set parent chain client
chainEnv.setParentChainClient(client: PublicClient): void

// Mode availability
chainEnv.isChainModeAvailable(): boolean
chainEnv.isRemoteRpcModeAvailable(): boolean
```

### SendersEnv Singleton

Manages sender accounts for transactions.

```typescript
import { SendersEnv, SenderRole } from './state/sendersEnv';

const sendersEnv = SendersEnv.getInstance();
```

**SenderRole Enum**:

```typescript
enum SenderRole {
  Validator = 'validator',
  BatchPoster = 'batchPoster',
  RegularSender = 'regularSender',
}
```

**Methods**:

```typescript
// Get accounts
sendersEnv.getAll(): SenderAccount[]
sendersEnv.getAllByRole(role: SenderRole): SenderAccount[]

// Add accounts
sendersEnv.add(account: SenderAccount): void
sendersEnv.addByPrivateKey(privateKey: string, role: SenderRole): SenderAccount

// Remove accounts
sendersEnv.removeByAddress(address: string): boolean
sendersEnv.clear(): void
```

### NodeManager

Manages Docker containers for Nitro nodes. **Business logic only** - UI is handled by NodeController.

```typescript
const nodeManager = chainEnv.nodeManager;
```

**Node Lifecycle**:

```typescript
// Start a node
await nodeManager.startNode(NodeType.MAIN): Promise<NodeInstance | null>
await nodeManager.startNode(NodeType.HONEST): Promise<NodeInstance | null>
await nodeManager.startNode(NodeType.MALICIOUS): Promise<NodeInstance | null>

// Stop nodes
await nodeManager.stopNode(nodeId): Promise<boolean>
await nodeManager.stopAllNodes(): Promise<void>

// Discover existing containers
await nodeManager.discoverExistingContainers(): Promise<void>
```

**Node Queries**:

```typescript
nodeManager.getNodes(): Map<string, NodeInstance>
nodeManager.getNode(nodeId): NodeInstance | undefined
nodeManager.getRunningNodes(): NodeInstance[]
nodeManager.displayStatus(): void
```

**Health Monitoring**:

```typescript
await nodeManager.checkNodeHealth(nodeId): Promise<boolean>
await nodeManager.getNodeUptime(nodeId): Promise<string>
nodeManager.isMonitoringActive(): boolean
await nodeManager.startHealthMonitoring(): Promise<void>
nodeManager.stopHealthMonitoring(): void
```

**NodeInstance Interface**:

```typescript
interface NodeInstance {
  config: SingleNodeConfig;
  status: NodeStatus;
  containerId?: string;
  containerName?: string;
  startedAt?: Date;
  publicClient?: PublicClient;
}
```

### NodeController

Handles UI interactions for node management. Separates UI logic from business logic.

```typescript
import { nodeController } from './core/docker/nodeController';

// Show interactive management menu
await nodeController.showManagementMenu(): Promise<void>

// Select and stop a node (with user prompt)
await nodeController.selectAndStopNode(): Promise<void>

// Show node details (with user prompt)
await nodeController.showNodeDetails(): Promise<void>
```

### OperationGuard

Centralized validation checks to reduce code duplication.

```typescript
import { guard } from './utils/guards';

// Check if chain is initialized (logs error if not)
if (!guard.requireChainInitiated()) return;

// Check chain mode specifically
if (!guard.requireChainModeInitiated()) return;

// Get NodeManager (returns null and logs error if not available)
const nodeManager = guard.requireNodeManager();
if (!nodeManager) return;

// Get main node (returns null if not found)
const mainNode = guard.requireMainNode();

// Get main node with PublicClient (returns null if client not available)
const mainNodeWithClient = guard.requireMainNodeWithClient();

// Combined check: chain initialized + NodeManager available
const nodeManager = guard.requireChainAndNodeManager();
```

### ConfigService

Centralized configuration management.

```typescript
import { config } from './config';

// Application config (from environment variables)
config.app.parentChainRpc      // PARENT_CHAIN_RPC
config.app.chainRpc            // CHAIN_RPC
config.app.deploymentTxHash    // CHAIN_DEPLOYMENT_TRANSACTION_HASH
config.app.deployerPrivateKey  // MAIN_PRIVATE_KEY

// Docker config (constants)
config.docker.image            // Docker image name
config.docker.containerPrefix  // Container name prefix
config.docker.dataDir          // Container data directory
config.docker.user             // Docker user

// Network config
config.network.defaultHttpPort
config.network.defaultWsPort

// Helper methods
config.isChainModeAvailable(): boolean
config.isRemoteRpcModeAvailable(): boolean
config.hasDeployerKey(): boolean
config.getDeploymentTxHash(): `0x${string}` | undefined
```

## Playbook Interface

Each playbook must implement the `Playbook` interface:

```typescript
export interface Playbook {
  /** Unique identifier */
  id: string;
  
  /** Display name */
  name: string;
  
  /** Brief description */
  description: string;
  
  /** Show interactive menu */
  showMenu(): Promise<void>;
}
```

## Adding a New Playbook

### Step 1: Create the playbook directory

```bash
mkdir -p src/playbooks/your-playbook
```

### Step 2: Implement the Playbook interface

Create `src/playbooks/your-playbook/index.ts`:

```typescript
import inquirer from 'inquirer';
import { Playbook } from '../types';
import logger from '../../utils/logger';
import { guard } from '../../utils/guards';

enum YourPlaybookAction {
  ACTION_ONE = 'action_one',
  ACTION_TWO = 'action_two',
  BACK = 'back',
}

class YourPlaybook implements Playbook {
  id = 'your-playbook';
  name = 'Your Playbook Name';
  description = 'Description of what your playbook does';

  async showMenu(): Promise<void> {
    logger.section('Your Playbook');

    while (true) {
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'Select an action:',
          choices: [
            { name: 'Action One', value: YourPlaybookAction.ACTION_ONE },
            { name: 'Action Two', value: YourPlaybookAction.ACTION_TWO },
            new inquirer.Separator(),
            { name: '← Back to Playbook List', value: YourPlaybookAction.BACK },
          ],
        },
      ]);

      switch (action) {
        case YourPlaybookAction.ACTION_ONE:
          await this.handleActionOne();
          break;
        case YourPlaybookAction.ACTION_TWO:
          await this.handleActionTwo();
          break;
        case YourPlaybookAction.BACK:
          return;
      }

      logger.newline();
    }
  }

  private async handleActionOne(): Promise<void> {
    // Use guard for validation
    if (!guard.requireChainInitiated()) return;

    const nodeManager = guard.requireNodeManager();
    if (!nodeManager) return;

    // Your implementation here
    logger.info('Action one executed');
  }

  private async handleActionTwo(): Promise<void> {
    // Your implementation here
    logger.info('Action two executed');
  }
}

export const yourPlaybook = new YourPlaybook();
export default yourPlaybook;
```

### Step 3: Register the playbook

Update `src/playbooks/index.ts`:

```typescript
import { yourPlaybook } from './your-playbook';

class PlaybookRegistry {
  constructor() {
    this.register(maliciousValidatorPlaybook);
    this.register(tpsTestPlaybook);
    this.register(yourPlaybook); // Add your playbook here
  }
  // ...
}
```

## Development Commands

```bash
# Run in development mode (auto-reload)
yarn dev

# Type check
yarn build
# or
npx tsc --noEmit

# Format code
yarn format

# Check formatting
yarn format:check

# Lint
yarn lint
```

## Testing

```bash
# Run all tests
yarn test

# Run specific test file
yarn test tests/core/docker/nodeManager.spec.ts

# Run with coverage
yarn test --coverage
```

**Note**: Some tests (e.g., `nodeManager.spec.ts`) require Docker to be running.
