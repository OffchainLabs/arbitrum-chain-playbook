import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import logger from '../../utils/logger.js';

export interface ContainerExitEvent {
  nodeId: string;
  containerId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class ProcessMonitor extends EventEmitter {
  private processes: Map<string, ChildProcess> = new Map();

  monitorContainer(containerId: string, nodeId: string): void {
    // Use 'docker wait' to actually wait for container exit, not logs
    const monitor = spawn('docker', ['wait', containerId]);

    let stdout = '';
    if (monitor.stdout) {
      monitor.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
    }

    monitor.on('close', (code, signal) => {
      // Only emit if the wait command itself didn't fail
      if (code === 0) {
        // Container actually exited - docker wait returns the container's exit code in stdout
        const raw = stdout.trim();
        const parsed = raw === '' ? NaN : Number(raw);
        const exitCode = Number.isFinite(parsed) ? parsed : null;
        this.emit('container-exit', { nodeId, containerId, code: exitCode, signal: null });
        logger.warn(`Container ${containerId} has exited`);
      } else if (signal !== 'SIGTERM') {
        // Only log if it's not due to us stopping monitoring
        logger.debug(`Monitor process for ${containerId} exited (code: ${code}, signal: ${signal})`);
      }
    });

    monitor.on('error', (error) => {
      logger.errorWithFix(
        `Error monitoring container ${containerId}: ${error.message}`,
        `Check if the container is still running: docker ps | grep ${containerId}`,
      );
    });

    this.processes.set(nodeId, monitor);
  }

  stopMonitoring(nodeId: string): void {
    const process = this.processes.get(nodeId);
    if (process) {
      process.kill('SIGTERM');
      this.processes.delete(nodeId);
    }
  }

  stopAllMonitoring(): void {
    for (const [nodeId] of this.processes) {
      this.stopMonitoring(nodeId);
    }
  }
}

export default ProcessMonitor;
