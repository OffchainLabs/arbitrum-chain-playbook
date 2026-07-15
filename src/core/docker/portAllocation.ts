/**
 * Host-port allocation for node containers.
 *
 * Ports are chosen from the node-config file when free, otherwise probed
 * upward, avoiding ports already claimed by other docker containers, by
 * nodes tracked in-process, or by any other process on the host.
 */

import net from 'net';
import { quietDockerCommand } from './dockerCli.js';
import { extractHttpPortFromConfigPath, extractWsPortFromConfigPath } from './nodeConfigExtractors.js';

/** Parse `docker ps --format "{{.Ports}}"` output into the set of host ports in use. */
export const parseDockerPsPorts = (raw: string): Set<number> => {
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
export const isPortAvailable = async (port: number): Promise<boolean> => {
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
 * Find available host ports for a new node.
 *
 * @param configPath   node-config file to read the preferred http/ws ports from
 * @param trackedPorts host ports already claimed by nodes tracked in-process
 */
export async function findAvailablePorts(
  configPath: string,
  trackedPorts: Iterable<number>,
): Promise<{ httpPort: number; wsPort: number }> {
  let usedPorts = new Set<number>();
  try {
    const ps = await quietDockerCommand('ps --format "{{.Ports}}"');
    usedPorts = parseDockerPsPorts((ps as any)?.raw ?? '');
  } catch (error) {
    usedPorts = new Set<number>();
  }

  for (const port of trackedPorts) {
    if (port > 0) usedPorts.add(port);
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
