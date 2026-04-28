/**
 * NodeManager - Manages Docker containers for Nitro nodes
 *
 * This class is instantiated by ChainEnv and receives a reference to it.
 * All chain-related information is obtained through ChainEnv.
 */

import { dockerCommand } from 'docker-cli-js';
import { extractHttpPortFromConfigPath, extractWsPortFromConfigPath } from './nodeConfigExtractors.js';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { createPublicClient, defineChain, http } from 'viem';
import { NodeType, NodeInstance, NodeStatus, SingleNodeConfig } from '../../types/index.js';
import {
  DOCKER_IMAGE,
  DOCKER_IMAGE_MALICIOUS,
  DOCKER_IMAGE_HONEST,
  CONTAINER_NAME_PREFIX,
  DOCKER_DATA_DIR,
  DOCKER_USER,
  DOCKER_NODE_CONFIG_PATH,
  LOCAL_DATA_DIR,
  DEFAULT_MAIN_NODE_HTTP_PORT,
  HEADLESS_DOCKER_MODE_LABEL,
  HEADLESS_DOCKER_SESSION_LABEL,
  HEADLESS_SESSION_ENV,
} from '../../types/constants.js';
import logger from '../../utils/logger.js';
import { renderNodeTable, buildNodeRow } from '../../utils/statusDisplay.js';
import { getNodeConfigPathForType } from '../../utils/nodeConfigUtils.js';
import ProcessMonitor, { ContainerExitEvent } from '../monitoring/processMonitor.js';

// Import ChainEnv type (avoid circular dependency by using type import)
import type { ChainEnv } from '../../state/chainEnv/index.js';

/**
 * Quiet docker command that suppresses all console output
 * Uses docker-cli-js's echo: false option for safe output suppression
 */
const quietDockerCommand = async (command: string): Promise<{ raw?: string }> => {
  const result = await dockerCommand(command, { echo: false });
  return result;
};

/**
 * Generate a container ID
 */
const generateContainerId = (): string => {
  return Math.random().toString(36).substring(2, 14);
};

const formatChainId = (chainId: number | bigint | null | undefined): string =>
  chainId === null || chainId === undefined ? 'unknown' : chainId.toString();

const getContainerName = (chainId: number | bigint | null | undefined, id: string): string =>
  `${CONTAINER_NAME_PREFIX}-${formatChainId(chainId)}-${id}-${process.pid}`;

const getHeadlessDockerLabelArgs = (): string[] => {
  const sessionId = process.env[HEADLESS_SESSION_ENV];
  if (!sessionId) return [];
  return [`--label ${HEADLESS_DOCKER_MODE_LABEL}=headless`, `--label ${HEADLESS_DOCKER_SESSION_LABEL}=${sessionId}`];
};

const parseContainerName = (containerName: string): { chainId?: string; nodeId?: string } | null => {
  const parts = containerName.split('-');
  if (parts.length < 3 || parts[0] !== CONTAINER_NAME_PREFIX) {
    return null;
  }

  const maybeChainId = parts.length >= 4 && /^\d+$/.test(parts[1]) ? parts[1] : undefined;
  const nodeIdStartIndex = maybeChainId ? 2 : 1;
  const nodeId = parts.slice(nodeIdStartIndex, -1).join('-');
  if (!nodeId) return null;

  return { chainId: maybeChainId, nodeId };
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

const parseDockerPsPorts = (raw: string): Set<number> => {
  const used = new Set<number>();
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const portsPart = line;
    const regex = /:(\d+)->/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(portsPart)) !== null) {
      used.add(Number(m[1]));
    }
  }
  return used;
};

/**
 * Check if a host port is available.
 */
const isPortAvailable = async (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '0.0.0.0');
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
    const availablePorts = await this.findAvailablePorts(configPath);
    const httpPort = availablePorts.httpPort;
    const wsPort = availablePorts.wsPort;

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
   * Find available ports for a new node
   */
  private async findAvailablePorts(configPath: string): Promise<{ httpPort: number; wsPort: number }> {
    let usedPorts = new Set<number>();
    try {
      const ps = await dockerCommand('ps --format "{{.Ports}}"');
      usedPorts = parseDockerPsPorts((ps as any)?.raw ?? '');
    } catch (error) {
      usedPorts = new Set<number>();
    }

    // Add ports from our tracked nodes
    for (const node of this.nodes.values()) {
      usedPorts.add(node.config.httpPort);
      if (node.config.wsPort > 0) {
        usedPorts.add(node.config.wsPort);
      }
    }

    // Read ports from config file (http required, ws optional)
    const configHttpPort = extractHttpPortFromConfigPath(configPath);
    const configWsPort = extractWsPortFromConfigPath(configPath);

    const isPortUsable = async (port: number): Promise<boolean> => {
      if (port <= 0) return false;
      if (usedPorts.has(port)) return false;
      return isPortAvailable(port);
    };

    const httpAvailable = await isPortUsable(configHttpPort);
    const wsAvailable = configWsPort === 0 || (await isPortUsable(configWsPort));

    if (httpAvailable && wsAvailable) {
      return { httpPort: configHttpPort, wsPort: configWsPort };
    }

    let httpPort = configHttpPort;
    while (!(await isPortUsable(httpPort))) {
      httpPort += 10;
    }

    let wsPort = 0;
    if (configWsPort !== 0) {
      wsPort = httpPort + 1;
      while (!(await isPortUsable(wsPort))) {
        wsPort += 1;
      }
    }

    return { httpPort, wsPort };
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
  async startNode(type: NodeType, options?: { dockerImage?: string }): Promise<NodeInstance | null> {
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
   * Public method to discover existing containers
   */
  async discoverExistingContainers(): Promise<void> {
    try {
      const psResult = await quietDockerCommand(
        'ps --filter "status=running" --format "{{.Names}} {{.ID}} {{.Ports}}" | grep nitro-',
      );
      const rawOutput = (psResult as any)?.raw || '';

      // Clean up any stray output that might leak through
      const containerLines = rawOutput
        .split('\n')
        .filter((line: string) => line.trim())
        .filter((line: string) => line.includes('nitro-')); // Only lines with nitro containers

      for (const line of containerLines) {
        if (!line.trim()) continue;

        const parts = line.trim().split(' ');
        if (parts.length < 2) continue;

        const containerName = parts[0];
        const containerId = parts[1];
        const ports = parts.slice(2).join(' ');

        // Verify container is actually running by doing a quick health check
        try {
          const healthResult = await quietDockerCommand(`inspect ${containerId} --format '{{.State.Running}}'`);
          const isRunning = (healthResult as any)?.raw?.trim() === 'true';
          if (!isRunning) {
            continue; // Skip non-running containers
          }
        } catch {
          continue; // Skip containers we can't inspect
        }

        // Extract node info from container name (e.g., nitro-<chainId>-main-12345)
        const parsedName = parseContainerName(containerName);
        if (parsedName?.nodeId) {
          const chainId = this.chainEnv.chainConfig.getChainId();
          if (chainId !== null && chainId !== undefined) {
            if (parsedName.chainId && parsedName.chainId !== chainId.toString()) {
              continue;
            }
            if (!parsedName.chainId) {
              continue;
            }
          }

          const nodeId = parsedName.nodeId; // 'main' or generated ID
          const nodeType = nodeId === 'main' ? NodeType.MAIN : NodeType.MALICIOUS;

          // Extract port mappings from Docker port string
          // Format: 0.0.0.0:8459->8449/tcp, [::]:8459->8449/tcp, 0.0.0.0:9642->9642/tcp
          // We need to identify which host port maps to which container port:
          // - Container port 8449 (or similar) = HTTP
          // - Container port 8450 (or HTTP+1) = WS
          // - Container port 9642 = Feed output (should be ignored for HTTP/WS detection)
          // Docker outputs both IPv4 and IPv6 mappings, so we deduplicate by container port.
          const FEED_CONTAINER_PORT = 9642;

          const extractPortMappings = (portsStr: string): { httpPort: number; wsPort: number } => {
            // Map: containerPort -> hostPort (deduplicated)
            const portMap = new Map<number, number>();
            const re = /:(\d+)->(\d+)\/tcp/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(portsStr)) !== null) {
              const hostPort = Number(m[1]);
              const containerPort = Number(m[2]);
              if (Number.isFinite(hostPort) && Number.isFinite(containerPort)) {
                // Skip feed port - it's not HTTP or WS
                if (containerPort === FEED_CONTAINER_PORT) continue;
                // Only store first occurrence (IPv4/IPv6 both map to same host port)
                if (!portMap.has(containerPort)) {
                  portMap.set(containerPort, hostPort);
                }
              }
            }

            // Sort container ports to find HTTP (lowest) and WS (second lowest)
            const sortedContainerPorts = Array.from(portMap.keys()).sort((a, b) => a - b);

            let httpPort = DEFAULT_MAIN_NODE_HTTP_PORT;
            let wsPort = 0; // 0 means WS not configured

            if (sortedContainerPorts.length >= 1) {
              // First (lowest) container port is HTTP
              httpPort = portMap.get(sortedContainerPorts[0]) ?? DEFAULT_MAIN_NODE_HTTP_PORT;
            }
            if (sortedContainerPorts.length >= 2) {
              // Second container port is WS
              wsPort = portMap.get(sortedContainerPorts[1]) ?? 0;
            }

            return { httpPort, wsPort };
          };

          const { httpPort, wsPort } = extractPortMappings(ports);

          // Verify the actual chainId via RPC call to ensure the node is running the expected chain
          const expectedChainId = this.chainEnv.chainConfig.getChainId();
          if (expectedChainId !== null && expectedChainId !== undefined) {
            try {
              const tempClient = createPublicClient({ transport: http(`http://localhost:${httpPort}`) });
              const actualChainId = await tempClient.getChainId();

              if (actualChainId !== expectedChainId) {
                // ChainId mismatch - the node is running a different chain, skip this container
                continue;
              }
            } catch {
              // RPC call failed - node may not be ready yet or not responding, skip this container
              continue;
            }
          }

          // Only add if we don't already track this container
          if (!this.nodes.has(nodeId) || this.nodes.get(nodeId)?.containerId !== containerId) {
            const nodeConfig: SingleNodeConfig = {
              id: nodeId,
              nodeType,
              httpPort,
              wsPort,
            };

            // Create PublicClient with chain definition for Orbit chain
            const publicClient = chainId ? createOrbitPublicClient(chainId, httpPort) : undefined;

            const nodeInstance: NodeInstance = {
              config: nodeConfig,
              containerId,
              containerName, // Store the discovered container name
              status: NodeStatus.RUNNING,
              publicClient,
            };

            this.nodes.set(nodeId, nodeInstance);
            logger.info(
              `Discovered running node: ${nodeId} (Container: ${containerId.substring(0, 12)}, HTTP:${httpPort}, WS:${wsPort})`,
            );
          }
        }
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
