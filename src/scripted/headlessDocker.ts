import { dockerCommand } from 'docker-cli-js';
import logger from '../utils/logger.js';
import {
  CONTAINER_NAME_PREFIX,
  HEADLESS_DOCKER_MODE_LABEL,
  HEADLESS_DOCKER_SESSION_LABEL,
  HEADLESS_SESSION_ENV,
} from '../types/constants.js';
import type { OrphanContainerPolicy } from './schema.js';

interface NitroContainer {
  id: string;
  name: string;
  ports: string;
  labels: Map<string, string>;
}

export function createHeadlessSessionId(): string {
  return `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

export function installHeadlessSessionEnv(sessionId: string): void {
  process.env[HEADLESS_SESSION_ENV] = sessionId;
}

export async function prepareHeadlessDockerContainers(
  policy: OrphanContainerPolicy,
  currentSessionId: string,
): Promise<void> {
  const containers = await listRunningNitroContainers();
  const candidates = containers.filter((container) => {
    const session = container.labels.get(HEADLESS_DOCKER_SESSION_LABEL);
    return session !== currentSessionId;
  });

  if (candidates.length === 0) return;

  const headlessOwned = candidates.filter(
    (container) => container.labels.get(HEADLESS_DOCKER_MODE_LABEL) === 'headless',
  );
  const legacy = candidates.filter((container) => container.labels.get(HEADLESS_DOCKER_MODE_LABEL) !== 'headless');
  const conflictHint = candidates.some((container) => container.ports.includes(':9642->9642/tcp'))
    ? ' At least one maps feed port 9642 and may block a fresh demo.'
    : '';

  if (policy === 'stop') {
    logger.warn(`Stopping ${candidates.length} pre-existing Nitro container(s) before headless run.${conflictHint}`);
    await stopContainers(candidates);
    return;
  }

  logger.warn(`Found ${candidates.length} pre-existing Nitro container(s).${conflictHint}`);
  logger.raw('  Headless will not stop them automatically with orphanContainerPolicy: warn.');
  if (headlessOwned.length > 0) {
    logger.raw(`  Previous headless container(s): ${formatContainerList(headlessOwned)}`);
  }
  if (legacy.length > 0) {
    logger.raw(`  Unlabeled/interactive container(s): ${formatContainerList(legacy)}`);
  }
  logger.raw(`  To stop them explicitly: docker stop ${candidates.map((container) => container.id).join(' ')}`);
}

async function listRunningNitroContainers(): Promise<NitroContainer[]> {
  try {
    const result = await dockerCommand(
      `ps --filter "name=${CONTAINER_NAME_PREFIX}-" --format "{{.ID}}\\t{{.Names}}\\t{{.Ports}}\\t{{.Labels}}"`,
      { echo: false },
    );
    const raw = String((result as { raw?: string })?.raw ?? '');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseContainerLine)
      .filter(
        (container): container is NitroContainer =>
          !!container && container.name.startsWith(`${CONTAINER_NAME_PREFIX}-`),
      );
  } catch (error) {
    logger.debug(
      `Could not inspect existing Nitro containers: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

function parseContainerLine(line: string): NitroContainer | null {
  const [id, name, ports = '', labels = ''] = line.split('\t');
  if (!id || !name) return null;
  return {
    id,
    name,
    ports,
    labels: parseLabels(labels),
  };
}

function parseLabels(raw: string): Map<string, string> {
  const labels = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const [key, ...valueParts] = pair.split('=');
    if (!key) continue;
    labels.set(key, valueParts.join('='));
  }
  return labels;
}

function formatContainerList(containers: NitroContainer[]): string {
  return containers.map((container) => `${container.name} (${container.id})`).join(', ');
}

async function stopContainers(containers: NitroContainer[]): Promise<void> {
  const ids = containers.map((container) => container.id);
  if (ids.length === 0) return;
  await dockerCommand(`stop --timeout=10 ${ids.join(' ')}`, { echo: false });
}
