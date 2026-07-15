/**
 * Discovery of already-running nitro node containers.
 *
 * Pure docker introspection: lists running `nitro-*` containers, parses their
 * names and port mappings, filters by expected chain id (both by name and by
 * an RPC eth_chainId probe), and returns plain data. Registering the results
 * as NodeInstances (clients, health monitoring) is the NodeManager's job.
 */

import { createPublicClient, http } from 'viem';
import { NodeType } from '../../types/index.js';
import { CONTAINER_NAME_PREFIX, DEFAULT_MAIN_NODE_HTTP_PORT } from '../../types/constants.js';
import { quietDockerCommand } from './dockerCli.js';

const formatChainId = (chainId: number | bigint | null | undefined): string =>
  chainId === null || chainId === undefined ? 'unknown' : chainId.toString();

/** Build the container name for a node started by this CLI. */
export const getContainerName = (chainId: number | bigint | null | undefined, id: string): string =>
  `${CONTAINER_NAME_PREFIX}-${formatChainId(chainId)}-${id}-${process.pid}`;

/** Parse a container name produced by getContainerName back into its parts. */
export const parseContainerName = (containerName: string): { chainId?: string; nodeId?: string } | null => {
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

// Container port 9642 is the feed output; it must be ignored when deciding
// which host ports are HTTP/WS.
const FEED_CONTAINER_PORT = 9642;

/**
 * Extract host HTTP/WS ports from a Docker port-mapping string.
 *
 * Format: `0.0.0.0:8459->8449/tcp, [::]:8459->8449/tcp, 0.0.0.0:9642->9642/tcp`
 * Docker outputs both IPv4 and IPv6 mappings, so mappings are deduplicated by
 * container port; the lowest container port is HTTP, the second lowest is WS.
 */
export const extractPortMappings = (portsStr: string): { httpPort: number; wsPort: number } => {
  // Map: containerPort -> hostPort (deduplicated)
  const portMap = new Map<number, number>();
  const re = /:(\d+)->(\d+)\/tcp/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(portsStr)) !== null) {
    const hostPort = Number(m[1]);
    const containerPort = Number(m[2]);
    if (Number.isFinite(hostPort) && Number.isFinite(containerPort)) {
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
    httpPort = portMap.get(sortedContainerPorts[0]) ?? DEFAULT_MAIN_NODE_HTTP_PORT;
  }
  if (sortedContainerPorts.length >= 2) {
    wsPort = portMap.get(sortedContainerPorts[1]) ?? 0;
  }

  return { httpPort, wsPort };
};

export interface DiscoveredContainer {
  nodeId: string;
  nodeType: NodeType;
  containerId: string;
  containerName: string;
  httpPort: number;
  wsPort: number;
}

/**
 * List running nitro containers that belong to `expectedChainId`.
 *
 * Containers are skipped when: the name doesn't parse, the name's chain id
 * doesn't match, docker says they aren't running, or the node's RPC
 * eth_chainId doesn't match the expected chain (or doesn't respond).
 */
export async function discoverRunningNitroContainers(
  expectedChainId: number | bigint | null | undefined,
): Promise<DiscoveredContainer[]> {
  const discovered: DiscoveredContainer[] = [];

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
    const parts = line.trim().split(' ');
    if (parts.length < 2) continue;

    const containerName = parts[0];
    const containerId = parts[1];
    const ports = parts.slice(2).join(' ');

    // Verify container is actually running by doing a quick health check
    try {
      const healthResult = await quietDockerCommand(`inspect ${containerId} --format '{{.State.Running}}'`);
      const isRunning = (healthResult as any)?.raw?.trim() === 'true';
      if (!isRunning) continue;
    } catch {
      continue; // Skip containers we can't inspect
    }

    // Extract node info from container name (e.g., nitro-<chainId>-main-12345)
    const parsedName = parseContainerName(containerName);
    if (!parsedName?.nodeId) continue;

    if (expectedChainId !== null && expectedChainId !== undefined) {
      if (!parsedName.chainId || parsedName.chainId !== expectedChainId.toString()) {
        continue;
      }
    }

    const nodeId = parsedName.nodeId; // 'main' or generated ID
    const nodeType = nodeId === 'main' ? NodeType.MAIN : NodeType.MALICIOUS;
    const { httpPort, wsPort } = extractPortMappings(ports);

    // Verify the actual chainId via RPC call to ensure the node is running the expected chain
    if (expectedChainId !== null && expectedChainId !== undefined) {
      try {
        const tempClient = createPublicClient({ transport: http(`http://localhost:${httpPort}`) });
        const actualChainId = await tempClient.getChainId();
        if (actualChainId !== expectedChainId) continue;
      } catch {
        // RPC call failed - node may not be ready yet or not responding, skip this container
        continue;
      }
    }

    discovered.push({ nodeId, nodeType, containerId, containerName, httpPort, wsPort });
  }

  return discovered;
}
