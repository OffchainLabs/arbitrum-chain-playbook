/**
 * NodeManager - Manages Docker containers for Nitro nodes
 *
 * This class is instantiated by ChainEnv and receives a reference to it.
 * All chain-related information is obtained through ChainEnv.
 *
 * Responsibilities are split across three modules:
 * - portAllocation.ts     — choosing free host ports
 * - containerDiscovery.ts — finding already-running nitro containers
 * - this file             — node lifecycle (start/stop) + health monitoring
 */

import { dockerCommand } from 'docker-cli-js';
import { extractHttpPortFromConfigPath, extractWsPortFromConfigPath } from './nodeConfigExtractors.js';
import fs from 'fs';
import path from 'path';
import { createPublicClient, defineChain, http } from 'viem';
import { NodeType, NodeInstance, NodeStatus, SingleNodeConfig } from '../../types/index.js';
import {
  DOCKER_IMAGE,
  DOCKER_IMAGE_MALICIOUS,
  DOCKER_IMAGE_HONEST,
  DOCKER_DATA_DIR,
  DOCKER_USER,
  DOCKER_NODE_CONFIG_PATH,
  LOCAL_DATA_DIR,
  HEADLESS_DOCKER_MODE_LABEL,
  HEADLESS_DOCKER_SESSION_LABEL,
  HEADLESS_SESSION_ENV,
} from '../../types/constants.js';
import logger from '../../utils/logger.js';
import { renderNodeTable, buildNodeRow } from '../../utils/statusDisplay.js';
import { getNodeConfigPathForType } from '../../utils/nodeConfigUtils.js';
import ProcessMonitor, { ContainerExitEvent } from '../monitoring/processMonitor.js';
import { quietDockerCommand } from './dockerCli.js';
import { findAvailablePorts } from './portAllocation.js';
import { getContainerName, discoverRunningNitroContainers } from './containerDiscovery.js';

// Import ChainEnv type (avoid circular dependency by using type import)
import type { ChainEnv } from '../../state/chainEnv/index.js';

/**
 * Generate a container ID
 */
const generateContainerId = (): string => {
  return Math.random().toString(36).substring(2, 14);
};

const getHeadlessDockerLabelArgs = (): string[] => {
  const sessionId = process.env[HEADLESS_SESSION_ENV];
  if (!sessionId) return [];
  return [`--label ${HEADLESS_DOCKER_MODE_LABEL}=headless`, `--label ${HEADLESS_DOCKER_SESSION_LABEL}=${sessionId}`];
};

const ensureDataDir = (baseDir: string): void => {
  try {
    fs.mkdirSync(baseDir, { recursive: true });
  } catch (e) {
    // ignore; start will fail later if not accessible
  }
};

/**
 * Create a PublicClient with chain definition for Orbit chain
 */
const createOrbitPublicClient = (chainId: number | bigint, httpPort: number) => {
  const rpcUrl = `http://localhost:${httpPort}`;
  const chain = defineChain({
    id: typeof chainId === 'bigint' ? Number(chainId) : chainId,
    network: 'Orbit chain',
    name: 'orbit',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl] },
      public: { http: [rpcUrl] },
    },
    testnet: true,
  });

  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
};

/**
 * NodeManager Class
 *
 * Manages Docker containers for Nitro nodes. Receives ChainEnv reference
 * to access chain configuration and state.
 */
export class NodeManager {
  private nodes: Map<string, NodeInstance> = new Map();
  private chainEnv: ChainEnv;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private healthStartTimeout: NodeJS.Timeout | null = null;
  private readonly HEALTH_CHECK_INTERVAL = 1000; // 1 second
  private processMonitor: ProcessMonitor;

  /**
   * Constructor - receives ChainEnv reference
   */
  constructor(chainEnv: ChainEnv) {
    this.chainEnv = chainEnv;
    this.processMonitor = new ProcessMonitor();

    // Set up event listener for container exit events
    this.processMonitor.on('container-exit', (event: ContainerExitEvent) => {
      this.handleUnexpectedNodeShutdown(event.nodeId, event);
    });
  }

  /**
   * Initialize NodeManager and discover existing containers
   */
  async initialize(): Promise<void> {
    await this.discoverExistingContainers();
  }

  /**
   * Get all nodes
   */
  getNodes(): Map<string, NodeInstance> {
    return this.nodes;
  }

  /**
   * Get a specific node by ID
   */
  getNode(nodeId: string): NodeInstance | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * Get all running nodes
   */
  getRunningNodes(): NodeInstance[] {
    return Array.from(this.nodes.values()).filter((n) => n.status === NodeStatus.RUNNING);
  }

  /** Host ports already claimed by tracked nodes. */
  private trackedPorts(): number[] {
    const ports: number[] = [];
    for (const node of this.nodes.values()) {
      ports.push(node.config.httpPort);
      if (node.config.wsPort > 0) ports.push(node.config.wsPort);
    }
    return ports;
  }

  /**
   * Create node configuration for a specific type
   */
  private async createNodeConfig(type: NodeType): Promise<SingleNodeConfig | null> {
    if (!this.chainEnv.status.isInitiated()) {
      return null;
    }

    // Ensure nodeConfigPaths has the path for this type
    this.ensureNodeConfigPath(type);

    const configPath = this.chainEnv.nodeConfig.getPath(type);
    if (!configPath) {
      logger.errorWithFix(
        `No config path found for node type: ${type}.`,
        `Ensure a config file exists for '${type}' nodes. Deploy a chain (Main Menu > Deploy Chain) to generate configs.`,
      );
      return null;
    }

    // Find available ports by checking existing containers and host ports
    const { httpPort, wsPort } = await findAvailablePorts(configPath, this.trackedPorts());

    // Generate unique ID for multiple instances
    let id: string;
    if (type === NodeType.MAIN) {
      // For main nodes, allow multiple instances with numbered IDs
      let mainCount = 1;
      while (this.nodes.has(`main-${mainCount}`)) {
        mainCount++;
      }
      id = mainCount === 1 ? 'main' : `main-${mainCount}`;
    } else {
      id = `${type.toLowerCase()}-${generateContainerId()}`;
    }

    // For non-MAIN nodes, set the forwarding target port (main node's HTTP port)
    let forwardingTargetPort: number | undefined;
    if (type !== NodeType.MAIN) {
      const mainNode = this.nodes.get('main');
      if (mainNode) {
        forwardingTargetPort = undefined;
      } else {
        const mainConfigPath =
          this.chainEnv.nodeConfig.getPath(NodeType.MAIN) ?? getNodeConfigPathForType(NodeType.MAIN);
        try {
          // Use the main node config port when main node is not running yet
          forwardingTargetPort = extractHttpPortFromConfigPath(mainConfigPath);
        } catch (error) {
          logger.errorWithFix(
            `Failed to read main node HTTP port: ${(error as Error).message}`,
            `Check that the node config file exists and contains a valid 'http.port' entry.`,
          );
          return null;
        }
      }
    }

    return { id, nodeType: type, httpPort, wsPort, forwardingTargetPort };
  }

  /**
   * Ensure node config path exists for the given type
   */
  private ensureNodeConfigPath(type: NodeType): void {
    // Check if path already exists
    if (this.chainEnv.nodeConfig.getPath(type)) return;

    // Set the path based on type
    this.chainEnv.nodeConfig.setPath(type, getNodeConfigPathForType(type));
  }

  /**
   * Start a node of the specified type
   */
  async startNode(
    type: NodeType,
    options?: { dockerImage?: string; extraDockerArgs?: string[] },
  ): Promise<NodeInstance | null> {
    if (!this.chainEnv.status.isInitiated()) {
      logger.errorWithFix('No chain detected.', 'Deploy a chain first from Main Menu > Deploy Chain.');
      return null;
    }

    const config = await this.createNodeConfig(type);
    if (!config) return null;

    // Get config file path for this node type
    const configPath = this.chainEnv.nodeConfig.getPath(type);
    if (!configPath) {
      logger.errorWithFix(
        `No config path found for node type: ${type}.`,
        `Ensure a config file exists for '${type}' nodes. Deploy a chain (Main Menu > Deploy Chain) to generate configs.`,
      );
      return null;
    }

    // Check if we already have this specific node running
    if (this.nodes.has(config.id)) {
      const existingNode = this.nodes.get(config.id);
      if (existingNode && existingNode.status === NodeStatus.RUNNING) {
        logger.warn(
          `Node "${config.id}" is already running (HTTP:${existingNode.config.httpPort}, WS:${existingNode.config.wsPort})`,
        );
        return existingNode;
      }
    }

    const chainId = this.chainEnv.chainConfig.getChainId();
    const containerName = getContainerName(chainId, config.id);
    // Host data directory structure: <cwd>/<LOCAL_DATA_DIR>/<chainId>/<nodeId>
    // - chainId: groups data by chain, so different chains don't mix
    // - config.id: isolates data per node instance ('main' or random id), preventing conflicts when running multiple nodes
    const hostDataDir = path.join(process.cwd(), LOCAL_DATA_DIR, chainId?.toString() ?? 'main', config.id);
    ensureDataDir(hostDataDir);
    const httpEndpoint = `http://localhost:${config.httpPort}`;

    let containerHttpPort: number;
    let containerWsPort: number;
    try {
      containerHttpPort = extractHttpPortFromConfigPath(configPath);
      containerWsPort = extractWsPortFromConfigPath(configPath);
    } catch (error) {
      logger.errorWithFix(
        `Failed to read node config ports: ${(error as Error).message}`,
        'Check that the node config file exists and contains valid http.port (and optionally ws.port) entries.',
      );
      return null;
    }

    const portArgs: string[] = [`-p ${config.httpPort}:${containerHttpPort}`];
    if (containerWsPort > 0 && config.wsPort > 0) {
      portArgs.push(`-p ${config.wsPort}:${containerWsPort}`);
    }
    // For MAIN node, also expose feed output port (9642)
    if (type === NodeType.MAIN) {
      portArgs.push('-p 9642:9642');
    }

    try {
      // Pre-emptively remove any existing container with the same name to avoid conflicts
      try {
        await quietDockerCommand(`rm -f ${containerName}`);
      } catch {
        // Ignore - container may not exist
      }

      // Select Docker image: use override if provided, otherwise pick by node type
      const dockerImage =
        options?.dockerImage ??
        (type === NodeType.MALICIOUS
          ? DOCKER_IMAGE_MALICIOUS
          : type === NodeType.HONEST
            ? DOCKER_IMAGE_HONEST
            : DOCKER_IMAGE);

      // All node types use --conf.file to start
      const args: string[] = [
        'run -d',
        `--name ${containerName}`,
        ...getHeadlessDockerLabelArgs(),
        `--user ${DOCKER_USER}`,
        `-v ${hostDataDir}:${DOCKER_DATA_DIR}`,
        `-v ${configPath}:${DOCKER_NODE_CONFIG_PATH}:ro`,
        ...portArgs,
        ...(options?.extraDockerArgs ?? []),
        dockerImage,
        `--conf.file ${DOCKER_NODE_CONFIG_PATH}`,
      ];

      // For non-MAIN nodes, add forwarding target to main node
      if (type !== NodeType.MAIN && config.forwardingTargetPort) {
        args.push(`--execution.forwarding-target http://host.docker.internal:${config.forwardingTargetPort}`);
      }

      const result = await dockerCommand(args.join(' '));
      const containerId = result && (result as any).raw ? String((result as any).raw).trim() : '';

      // Create PublicClient with chain definition for Orbit chain
      const publicClient = chainId ? createOrbitPublicClient(chainId, config.httpPort) : undefined;

      const node: NodeInstance = {
        config,
        status: NodeStatus.RUNNING,
        containerId: containerId || undefined,
        containerName,
        startedAt: new Date(),
        publicClient,
      };
      this.nodes.set(config.id, node);

      // Start process monitoring for the new container
      if (containerId) {
        this.processMonitor.monitorContainer(containerId, config.id);
        logger.info(`Started process monitoring for node ${config.id}`);
      }

      // Start health monitoring when first node is added
      if (this.nodes.size === 1 && !this.monitoringInterval) {
        await this.startHealthMonitoring();
      }

      logger.success(
        `Node "${config.id}" (${type}) is now running on port ${config.httpPort} — RPC endpoint: ${httpEndpoint}`,
      );
      if (containerId) logger.raw(`  Container ID: ${containerId}`);
      if (config.wsPort > 0) {
        logger.raw(`  WS Endpoint:  ws://localhost:${config.wsPort}`);
      }
      if (config.forwardingTargetPort) {
        logger.raw(`  Forwarding to: http://host.docker.internal:${config.forwardingTargetPort}`);
      }

      // Quick health check — report block height if reachable
      if (node.publicClient) {
        try {
          const blockNumber = await node.publicClient.getBlockNumber();
          node.blockHeight = Number(blockNumber);
          logger.nodeHealth(config.id, { blocksProcessed: blockNumber });
        } catch {
          // Node may still be syncing; this is informational only
        }
      }

      return node;
    } catch (err: any) {
      logger.errorWithFix(
        `Failed to start node: ${err?.message || String(err)}`,
        `Check Docker logs: docker logs ${containerName}`,
      );
      return null;
    }
  }

  /**
   * Stop a specific node
   */
  async stopNode(nodeId: string): Promise<boolean> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      logger.errorWithFix(`Node "${nodeId}" not found.`, 'Use View Status to see currently running nodes.');
      return false;
    }

    const chainId = this.chainEnv.chainConfig.getChainId();
    const containerIdentifier = node.containerId || node.containerName || getContainerName(chainId, node.config.id);

    try {
      await dockerCommand(`stop --timeout=10 ${containerIdentifier}`);
      logger.debug(`Successfully stopped container: ${containerIdentifier}`);
    } catch (error) {
      logger.warn(`Failed to stop container: ${containerIdentifier}`);
    }

    // Stop process monitoring for this node
    this.processMonitor.stopMonitoring(nodeId);

    this.nodes.delete(nodeId);

    // Stop monitoring when no nodes are running
    if (this.nodes.size === 0) {
      this.stopHealthMonitoring();
    }

    logger.success(`Node "${nodeId}" stopped and monitoring cleaned up.`);
    return true;
  }

  /**
   * Stop all running nodes
   */
  async stopAllNodes(): Promise<void> {
    const total = this.nodes.size;
    if (total === 0) {
      logger.info('No running nodes to stop.');
      return;
    }
    for (const [, node] of this.nodes.entries()) {
      const chainId = this.chainEnv.chainConfig.getChainId();
      const containerIdentifier = node.containerId || node.containerName || getContainerName(chainId, node.config.id);
      try {
        await dockerCommand(`stop --timeout=10 ${containerIdentifier}`);
      } catch (error) {
        logger.debug(`Failed to stop container ${containerIdentifier}: ${error}`);
      }
    }
    this.nodes.clear();

    // Stop all process monitoring
    this.processMonitor.stopAllMonitoring();

    this.stopHealthMonitoring();
    logger.success(`Stopped ${total} node${total === 1 ? '' : 's'} and cleaned up all monitoring.`);
  }

  /**
   * Display current node status as a formatted table
   */
  displayStatus(): void {
    const rows = Array.from(this.nodes.entries()).map(([id, node]) => buildNodeRow(id, node));
    renderNodeTable(rows);
  }

  /**
   * Discover running nitro containers for this chain and register them.
   */
  async discoverExistingContainers(): Promise<void> {
    try {
      const chainId = this.chainEnv.chainConfig.getChainId();
      const discovered = await discoverRunningNitroContainers(chainId);

      for (const found of discovered) {
        // Only add if we don't already track this container
        if (this.nodes.has(found.nodeId) && this.nodes.get(found.nodeId)?.containerId === found.containerId) {
          continue;
        }

        const nodeConfig: SingleNodeConfig = {
          id: found.nodeId,
          nodeType: found.nodeType,
          httpPort: found.httpPort,
          wsPort: found.wsPort,
        };

        // Create PublicClient with chain definition for Orbit chain
        const publicClient = chainId ? createOrbitPublicClient(chainId, found.httpPort) : undefined;

        this.nodes.set(found.nodeId, {
          config: nodeConfig,
          containerId: found.containerId,
          containerName: found.containerName,
          status: NodeStatus.RUNNING,
          publicClient,
        });
        logger.info(
          `Discovered running node: ${found.nodeId} (Container: ${found.containerId.substring(0, 12)}, HTTP:${found.httpPort}, WS:${found.wsPort})`,
        );
      }

      if (this.nodes.size > 0) {
        logger.success(`Discovered ${this.nodes.size} running node(s)`);
        // Start health monitoring for discovered nodes if not already running
        if (!this.monitoringInterval) {
          await this.startHealthMonitoring();
        }
      }
    } catch {
      // No existing containers found, which is fine - don't log anything
    }
  }

  /**
   * Check if health monitoring is currently active
   */
  isMonitoringActive(): boolean {
    return this.monitoringInterval !== null || this.healthStartTimeout !== null;
  }

  /**
   * Start health monitoring for all nodes (background monitoring, less verbose)
   */
  async startHealthMonitoring(): Promise<void> {
    // Add a small delay before starting health monitoring to let containers stabilize
    if (this.monitoringInterval || this.healthStartTimeout) return;
    this.healthStartTimeout = setTimeout(() => {
      this.healthStartTimeout = null;
      if (this.monitoringInterval) return;
      this.monitoringInterval = setInterval(async () => {
        for (const [nodeId, node] of this.nodes.entries()) {
          if (node.status === NodeStatus.RUNNING) {
            const isHealthy = await this.checkNodeHealth(nodeId);
            if (!isHealthy && node.status === NodeStatus.RUNNING) {
              // Double-check after a brief delay to avoid false positives
              setTimeout(async () => {
                const recheckHealthy = await this.checkNodeHealth(nodeId);
                if (!recheckHealthy && node.status === NodeStatus.RUNNING) {
                  this.handleUnexpectedNodeShutdown(nodeId, node);
                }
              }, 2000); // 2 second delay for recheck
            }
          }
        }
      }, this.HEALTH_CHECK_INTERVAL);
    }, 3000); // 3 second initial delay
  }

  /**
   * Get node uptime as a formatted string
   * Public for NodeController access
   */
  async getNodeUptime(nodeId: string): Promise<string> {
    try {
      const node = this.nodes.get(nodeId);
      if (!node?.containerId) return 'unknown';

      const result = await quietDockerCommand(`inspect ${node.containerId} --format '{{.State.StartedAt}}'`);
      const startedAtRaw = (result as any).raw?.trim();

      if (startedAtRaw) {
        // Parse the Docker timestamp format (e.g., "2025-12-27T15:36:22.074060254Z")
        const startTime = new Date(startedAtRaw);
        if (!isNaN(startTime.getTime())) {
          const now = new Date();
          const uptimeMs = now.getTime() - startTime.getTime();
          const uptimeMinutes = Math.floor(uptimeMs / (1000 * 60));
          const uptimeHours = Math.floor(uptimeMinutes / 60);

          if (uptimeHours > 0) {
            return `${uptimeHours}h ${uptimeMinutes % 60}m`;
          } else if (uptimeMinutes > 0) {
            return `${uptimeMinutes}m`;
          } else {
            return '<1m';
          }
        }
      }

      return 'unknown';
    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * Stop health monitoring
   */
  stopHealthMonitoring(): void {
    if (this.healthStartTimeout) {
      clearTimeout(this.healthStartTimeout);
      this.healthStartTimeout = null;
    }
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  /**
   * Check if a node is healthy
   * Public for NodeController access
   */
  async checkNodeHealth(nodeId: string): Promise<boolean> {
    try {
      const node = this.nodes.get(nodeId);
      if (!node?.containerId) return false;

      const result = await quietDockerCommand(`inspect ${node.containerId} --format '{{.State.Running}}'`);
      const output = (result as any).raw?.trim();
      const isHealthy = output === 'true';

      // Only log on status change to avoid spam
      const currentHealth = node.lastHealthStatus ?? true;
      if (currentHealth !== isHealthy) {
        node.lastHealthStatus = isHealthy;
        if (!isHealthy) {
          logger.warn(`Node ${nodeId} health check failed`);
        }
      }

      return isHealthy;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if a container was killed by OOM (Out of Memory)
   */
  private async checkOomKill(containerIdentifier: string): Promise<void> {
    try {
      const result = await quietDockerCommand(`inspect --format="{{.State.OOMKilled}}" ${containerIdentifier}`);
      if (result.raw?.trim() === 'true') {
        logger.errorWithFix(
          'Container was killed due to Out of Memory (OOM)!',
          'Increase Docker memory limit in Docker Desktop > Settings > Resources, or reduce node memory usage.',
        );
      }
    } catch {
      // Ignore - container may have been removed
    }
  }

  /**
   * Handle unexpected node shutdown
   */
  private handleUnexpectedNodeShutdown(nodeId: string, nodeOrEvent: NodeInstance | ContainerExitEvent): void {
    const node = this.nodes.get(nodeId);
    if (!node) {
      logger.warn(`Node ${nodeId} not found in registry`);
      return;
    }

    const wasRunning = node.status === NodeStatus.RUNNING;
    if (wasRunning) {
      const containerIdent = node.containerId || node.containerName || nodeId;
      logger.errorWithFix(
        `Node "${nodeId}" shut down unexpectedly!`,
        `Check Docker logs: docker logs ${containerIdent}`,
      );
    }

    // Log additional details if it's a container exit event
    if ('code' in nodeOrEvent) {
      const event = nodeOrEvent as ContainerExitEvent;
      logger.warn(`Container exited with code: ${event.code}, signal: ${event.signal}`);

      // Check if the container was killed by OOM
      const containerIdent = node.containerId || node.containerName || nodeId;
      this.checkOomKill(containerIdent);
    }

    // Update node status to ERROR for unexpected shutdowns (unless explicitly stopped)
    if (node.status !== NodeStatus.STOPPED) {
      node.status = NodeStatus.ERROR;
    }

    // Clean up process monitoring for this node
    this.processMonitor.stopMonitoring(nodeId);

    logger.info(`Cleaned up monitoring for node ${nodeId}`);
  }
}

export default NodeManager;
