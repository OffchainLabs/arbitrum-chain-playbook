import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createPublicClient, http } from 'viem';
import { quietDockerCommand } from '../core/docker/dockerCli.js';
import { NodeInstance, NodeStatus, NodeType, SingleNodeConfig } from '../types/index.js';
import logger from '../utils/logger.js';
import { DEVNODE_CONFIG } from './devnodeConfig.js';

export interface DevnodeStatus {
  running: boolean;
  containerId?: string;
  chainId?: number;
  blockHeight?: bigint;
  balanceWei?: bigint;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class DevnodeManager {
  async startDevnode(): Promise<boolean> {
    const containerId = await this.getRunningContainerId();
    if (containerId) {
      logger.info('Devnode is already running.');
      return true;
    }

    try {
      const scriptPath = path.resolve(process.cwd(), DEVNODE_CONFIG.scriptPath);
      const assetsDir = path.resolve(process.cwd(), DEVNODE_CONFIG.assetsDir);
      if (!this.ensureDevnodeAssets(assetsDir, scriptPath)) {
        return false;
      }
      const child = spawn('bash', [scriptPath], {
        cwd: assetsDir,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      const ready = await this.waitForReady();
      if (!ready) {
        logger.warn('Devnode start triggered, but readiness check timed out.');
        return true;
      }
      logger.success(`Devnode started — RPC ${DEVNODE_CONFIG.rpcUrl} (chain ${DEVNODE_CONFIG.chainId}).`);
      return true;
    } catch (error) {
      logger.errorWithFix(
        `Failed to start devnode: ${error instanceof Error ? error.message : String(error)}`,
        'Ensure Docker is running (`docker info`) and the devnode assets are present.',
      );
      return false;
    }
  }

  async stopDevnode(): Promise<boolean> {
    try {
      await quietDockerCommand(`stop --timeout=30 ${DEVNODE_CONFIG.containerName}`);
    } catch (error) {
      logger.debug(`Devnode stop: ${error instanceof Error ? error.message : String(error)}`);
    }

    // run-dev-node.sh starts the container with --rm, so it usually removes
    // itself on stop; only rm if a stopped container is actually left behind.
    try {
      const leftover = await quietDockerCommand(
        `ps -a --filter "name=${DEVNODE_CONFIG.containerName}" --format "{{.ID}}"`,
      );
      if (String(leftover.raw ?? '').trim().length > 0) {
        await quietDockerCommand(`rm ${DEVNODE_CONFIG.containerName}`);
      }
    } catch (error) {
      logger.debug(`Devnode rm: ${error instanceof Error ? error.message : String(error)}`);
    }

    return true;
  }

  async isDevnodeRunning(): Promise<boolean> {
    return (await this.getRunningContainerId()) !== null;
  }

  async getStatus(): Promise<DevnodeStatus> {
    const containerId = await this.getRunningContainerId();
    const running = containerId !== null;
    if (!running) {
      return { running: false };
    }

    const publicClient = createPublicClient({
      transport: http(DEVNODE_CONFIG.rpcUrl),
    });

    let chainId: number | undefined;
    let blockHeight: bigint | undefined;
    let balanceWei: bigint | undefined;

    try {
      chainId = await publicClient.getChainId();
    } catch {}
    try {
      blockHeight = await publicClient.getBlockNumber();
    } catch {}
    try {
      balanceWei = await publicClient.getBalance({ address: DEVNODE_CONFIG.devAccount as `0x${string}` });
    } catch {}

    return { running, containerId: containerId ?? undefined, chainId, blockHeight, balanceWei };
  }

  async getDevnodeNodeInstance(): Promise<NodeInstance | null> {
    const containerId = await this.getRunningContainerId();
    if (!containerId) return null;

    const config: SingleNodeConfig = {
      id: 'devnode',
      nodeType: NodeType.MAIN,
      httpPort: DEVNODE_CONFIG.httpPort,
      wsPort: DEVNODE_CONFIG.wsPort,
    };

    const publicClient = createPublicClient({
      transport: http(DEVNODE_CONFIG.rpcUrl),
    });

    return {
      config,
      status: NodeStatus.RUNNING,
      containerId,
      containerName: DEVNODE_CONFIG.containerName,
      startedAt: new Date(),
      publicClient,
    };
  }

  private async waitForReady(): Promise<boolean> {
    const publicClient = createPublicClient({
      transport: http(DEVNODE_CONFIG.rpcUrl),
    });

    for (let i = 0; i < 60; i++) {
      // Probe the port with a body-less request first: the global RPC logger
      // (fileLogger) records every failed JSON-RPC call at ERROR level, so
      // polling getBlockNumber before the server is listening would spam the
      // session log with expected connection failures.
      try {
        await fetch(DEVNODE_CONFIG.rpcUrl, { method: 'HEAD' });
      } catch {
        await sleep(500);
        continue;
      }
      try {
        await publicClient.getBlockNumber();
        return true;
      } catch {
        await sleep(500);
      }
    }
    return false;
  }

  private async getRunningContainerId(): Promise<string | null> {
    try {
      const result = await quietDockerCommand(
        `ps --filter "name=${DEVNODE_CONFIG.containerName}" --filter "status=running" --format "{{.ID}}"`,
      );
      const id = String(result.raw ?? '').trim();
      return id.length > 0 ? id : null;
    } catch {
      return null;
    }
  }

  async getDevnodeUptime(): Promise<string> {
    const containerId = await this.getRunningContainerId();
    if (!containerId) return 'unknown';

    try {
      // docker-cli-js JSON-parses `inspect` output, which throws when --format
      // yields plain text — call docker directly for this read-only query.
      const result = spawnSync('docker', ['inspect', containerId, '--format', '{{.State.StartedAt}}'], {
        encoding: 'utf-8',
      });
      if (result.status !== 0) return 'unknown';
      const startedAtRaw = result.stdout.trim();
      if (!startedAtRaw) return 'unknown';

      const startTime = new Date(startedAtRaw);
      if (isNaN(startTime.getTime())) return 'unknown';

      const uptimeMinutes = Math.floor((Date.now() - startTime.getTime()) / (1000 * 60));
      const uptimeHours = Math.floor(uptimeMinutes / 60);

      if (uptimeHours > 0) {
        return `${uptimeHours}h ${uptimeMinutes % 60}m`;
      } else if (uptimeMinutes > 0) {
        return `${uptimeMinutes}m`;
      }
      return '<1m';
    } catch {
      return 'unknown';
    }
  }

  private ensureDevnodeAssets(assetsDir: string, scriptPath: string): boolean {
    if (fs.existsSync(assetsDir) && fs.existsSync(scriptPath)) {
      return true;
    }

    logger.warn('Devnode assets missing. Trying to init git submodules...');
    const result = spawnSync('git', ['submodule', 'update', '--init', '--recursive'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim();
      logger.errorWithFix(
        `Failed to init git submodules${stderr ? `: ${stderr}` : ''}.`,
        'Run `git submodule update --init --recursive` manually from the project root.',
      );
      return false;
    }

    if (!fs.existsSync(assetsDir)) {
      logger.errorWithFix(
        `Devnode assets directory not found: ${assetsDir}`,
        'Run `git submodule update --init --recursive` to fetch devnode assets.',
      );
      return false;
    }
    if (!fs.existsSync(scriptPath)) {
      logger.errorWithFix(
        `Devnode start script not found: ${scriptPath}`,
        'Run `git submodule update --init --recursive` to fetch devnode assets.',
      );
      return false;
    }

    return true;
  }
}
