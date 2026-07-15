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
  - [Guards](#guards)
  - [Config](#config)
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
│  NodeManager, deployChain                                   │
├─────────────────────────────────────────────────────────────┤
│                      State Layer                            │
│  ChainEnv (singleton), SendersEnv (singleton)               │
├─────────────────────────────────────────────────────────────┤
│                    Infrastructure Layer                     │
│  Docker, config functions, guards, Logger                  │
└─────────────────────────────────────────────────────────────┘
```

**Design Principles**:

1. **UI/Business Separation**: UI logic (inquirer prompts) is in Controllers, business logic is in Managers
2. **Centralized State**: `ChainEnv` and `SendersEnv` singletons manage all application state
3. **Guard helpers**: Shared precondition checks live in `utils/guards.ts` (e.g. `requireChainInitiated`)
4. **Config functions**: Env-derived config is read via plain functions in `config/` (`getAppConfig`, `isChainModeAvailable`, …); static constants come from `types/constants.ts`

## Project Structure

```
src/
├── index.ts                    # Application entry point
├── init.ts                     # App initialization logic
├── config/                     # Configuration management
│   └── index.ts                # Env-derived config functions
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
│   │   └── deployChain.ts      # Deployment implementation
│   ├── docker/                 # Docker/Node management
│   │   ├── nodeManager.ts      # Node lifecycle + health monitoring
│   │   ├── nodeController.ts   # NodeController (UI logic)
│   │   ├── containerDiscovery.ts # Find running nitro containers
│   │   ├── portAllocation.ts   # Host port selection
│   │   ├── dockerCli.ts        # Quiet docker exec helper
│   │   └── nodeConfigExtractors.ts # Config port extractors
│   ├── interactChain/          # Chain interaction
│   │   └── interactChainOperations.ts
│   ├── nodeConfig/             # Node config operations
│   │   └── nodeConfigOperations.ts
│   └── monitoring/             # Process monitoring
│       └── processMonitor.ts
├── state/                      # State management
│   ├── chainEnv/               # ChainEnv singleton
│   │   ├── index.ts            # ChainEnv class (status/nodeConfig/chainConfig views)
│   │   ├── types.ts            # Related types
│   │   ├── persistence.ts      # Load/save state + core-contracts file
│   │   └── fromTxHash.ts       # State from tx hash
│   └── sendersEnv/             # SendersEnv singleton
│       ├── index.ts
│       └── types.ts
├── playbooks/                  # Playbook modules
│   ├── types.ts                # Playbook interface
│   ├── index.ts                # Playbook registry
│   ├── runnerKit.ts            # Shared runner/chain-ops primitives
│   ├── malicious-validator/    # Malicious validator playbook
│   └── timeboost/              # Timeboost auction playbook
├── types/                      # Shared types
│   ├── index.ts                # Enums, interfaces
│   └── constants.ts            # Application constants
└── utils/                      # Utilities
    ├── logger.ts               # Logging utilities
    ├── guards.ts               # requireChainInitiated precondition
    ├── nodeConfigUtils.ts      # Node config helpers
    └── inquirerUtils.ts        # Inquirer helpers

tests/                          # Test suites
└── unit/                       # Pure unit tests (no docker required)
    └── *.spec.ts
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
// Load chain configuration from disk
chainEnv.load(): boolean
chainEnv.reset(): void

// Set deployment result
chainEnv.setDeploymentResult(chainConfig, nodeConfig, coreContracts, nodeConfigPaths): void

// Set parent chain client
chainEnv.setParentChainClient(client: PublicClient): void
```

> Mode-availability checks live in `config/` (`isChainModeAvailable()`,
> `isRemoteRpcModeAvailable()`), not on `ChainEnv`.

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
sendersEnv.addByPrivateKey(privateKey: string, role: SenderRole): SenderAccount

// Remove accounts
sendersEnv.clearByRole(role: SenderRole): void
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

### Guards

Shared precondition checks in `utils/guards.ts`.

```typescript
import { requireChainInitiated } from './utils/guards';

// Check if a chain is initialized (logs an actionable error if not)
if (!requireChainInitiated()) return;
```

For node-manager / main-node access, read `ChainEnv.getInstance().nodeManager`
and null-check it directly — the former `OperationGuard` class (with
`requireNodeManager` / `requireMainNode` / … helpers) was removed as unused.

### Config

Env-derived configuration via plain functions in `config/` (re-evaluated on
each call, so mid-session `.env` changes are picked up). Static tunables
(docker image, ports, …) are imported directly from `types/constants.ts`, not
wrapped here.

```typescript
import {
  getAppConfig,
  isChainModeAvailable,
  isRemoteRpcModeAvailable,
  hasDeployerKey,
  getDeploymentTxHash,
} from './config';

const app = getAppConfig();
app.parentChainRpc       // PARENT_CHAIN_RPC
app.chainRpc             // CHAIN_RPC
app.deploymentTxHash     // CHAIN_DEPLOYMENT_TRANSACTION_HASH
app.deployerPrivateKey   // MAIN_PRIVATE_KEY

// Mode-availability helpers
isChainModeAvailable(): boolean
isRemoteRpcModeAvailable(): boolean
hasDeployerKey(): boolean
getDeploymentTxHash(): `0x${string}` | undefined
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

  /** Operation modes in which this playbook is runnable */
  supportedModes: OperationMode[];

  /** Show interactive menu */
  showMenu(): Promise<void>;

  /** Optional: drive the playbook non-interactively from `yarn run:script ...` */
  runHeadless?(command: string, params: unknown, ctx?: OperationContext): Promise<PlaybookActionResult>;
  listHeadlessCommands?(): HeadlessCommandSpec[];
}
```

**Headless contract**: when implementing `runHeadless`, factor your demo into a private `executeXxx(config, ctx)` that both the menu handler and the headless dispatch call. This keeps the two entry points in lockstep — anything you fix or add in interactive mode automatically applies to scripted runs. See `MaliciousValidatorPlaybook` for the canonical pattern.

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
import { requireChainInitiated } from '../../utils/guards';
import { ChainEnv } from '../../state/chainEnv';

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
    // Validate preconditions
    if (!requireChainInitiated()) return;

    const nodeManager = ChainEnv.getInstance().nodeManager;
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
```

## Testing

```bash
# Run all tests (pure unit tests, no docker required)
yarn test

# Run a specific test file
npx tsx --test tests/unit/persistence.spec.ts
```
