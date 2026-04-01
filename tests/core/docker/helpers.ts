import { dockerCommand } from 'docker-cli-js';
import { DOCKER_IMAGE, CONTAINER_NAME_PREFIX } from '../../../src/types/constants';

export const IMAGE = DOCKER_IMAGE;

export async function isDockerAvailable(): Promise<boolean> {
  try {
    const res = await dockerCommand('info');
    return !!res && typeof (res as any).raw === 'string';
  } catch (_) {
    return false;
  }
}

export async function removeAllNitroContainers(): Promise<void> {
  try {
    const ps = await dockerCommand('ps -a --format "{{.Names}}"');
    const namesRaw = (ps as any)?.raw ?? '';
    const names = namesRaw
      .split('\n')
      .map((s: string) => s.trim())
      .filter(Boolean);
    const targets = names.filter((n: string) => n.startsWith(`${CONTAINER_NAME_PREFIX}-`));
    for (const name of targets) {
      try {
        await dockerCommand(`stop --timeout=1800 ${name}`);
      } catch (_) {}
      try {
        await dockerCommand(`rm ${name}`);
      } catch (_) {}
    }
  } catch (_) {}
}

export async function waitForRpcReady(rpcUrl: string, attempts = 30, intervalMs = 2000): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const ok = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      });
      const data: any = await ok.json();
      if (data && data.result !== undefined) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
