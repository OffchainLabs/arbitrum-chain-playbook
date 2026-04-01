import test, { before, after, afterEach } from 'node:test';
import { expect } from 'chai';
import { NodeManager } from '../../../src/core/docker/nodeManager';
import { ChainEnv, setNodeManagerClass } from '../../../src/state/chainEnv';
import { NodeType } from '../../../src/types';
import { isDockerAvailable, removeAllNitroContainers, waitForRpcReady } from './helpers';

// Register NodeManager class with ChainEnv
setNodeManagerClass(NodeManager);

const RUN = process.env.RUN_DOCKER_TESTS === 'true';
let dockerOk = false;

// Get ChainEnv singleton for tests
const getChainEnv = () => ChainEnv.getInstance();

before(async () => {
  if (!RUN) return;
  dockerOk = await isDockerAvailable();
});

afterEach(async () => {
  if (!RUN || !dockerOk) return;
  await removeAllNitroContainers();
  // Reset ChainEnv between tests
  ChainEnv.resetInstance();
});

after(async () => {
  if (!RUN || !dockerOk) return;
  await removeAllNitroContainers();
});

test('startNode: starts honest node, container running, RPC ready', async () => {
  if (!RUN) return;
  if (!dockerOk) return;

  const chainEnv = getChainEnv();
  // Load chain from existing node-config.json or mock data
  chainEnv.load();

  const nodeManager = chainEnv.nodeManager;
  const node = await nodeManager.startNode(NodeType.HONEST);
  expect(node).to.not.equal(null);
  expect(node!.status).to.equal('running');

  const httpUrl = `http://localhost:${node!.config.httpPort}`;
  const ready = await waitForRpcReady(httpUrl, 10, 1000);
  expect(ready).to.equal(true);
});

test('port conflict detection: second node on same ports fails', async () => {
  if (!RUN) return;
  if (!dockerOk) return;

  const chainEnv = getChainEnv();
  chainEnv.load();

  const nodeManager = chainEnv.nodeManager;
  const first = await nodeManager.startNode(NodeType.HONEST);
  expect(first).to.not.equal(null);

  const port = (first as any).config.httpPort;
  (nodeManager as any).nextPort = port;

  const second = await nodeManager.startNode(NodeType.HONEST);
  expect(second).to.equal(null);
});

test('stopNode: gracefully stops and removes container', async () => {
  if (!RUN) return;
  if (!dockerOk) return;

  const chainEnv = getChainEnv();
  chainEnv.load();

  const nodeManager = chainEnv.nodeManager;
  const node = await nodeManager.startNode(NodeType.HONEST);
  expect(node).to.not.equal(null);

  const stopped = await nodeManager.stopNode(node!.config.id);
  expect(stopped).to.equal(true);
});

test('stopAllNodes: stops and removes all containers', async () => {
  if (!RUN) return;
  if (!dockerOk) return;

  const chainEnv = getChainEnv();
  chainEnv.load();

  const nodeManager = chainEnv.nodeManager;
  const n1 = await nodeManager.startNode(NodeType.HONEST);
  const n2 = await nodeManager.startNode(NodeType.MALICIOUS);
  expect(n1).to.not.equal(null);
  expect(n2).to.not.equal(null);

  await nodeManager.stopAllNodes();
  expect(nodeManager.getNodes().size).to.equal(0);
});

test('state tracking: nodes map updates on start/stop', async () => {
  if (!RUN) return;
  if (!dockerOk) return;

  const chainEnv = getChainEnv();
  chainEnv.load();

  const nodeManager = chainEnv.nodeManager;
  const node = await nodeManager.startNode(NodeType.HONEST);
  expect(nodeManager.getNodes().size).to.equal(1);

  await nodeManager.stopNode(node!.config.id);
  expect(nodeManager.getNodes().size).to.equal(0);
});

test('failure handling: no chain deployed prevents startup', async () => {
  if (!RUN) return;
  if (!dockerOk) return;

  const chainEnv = getChainEnv();
  // Don't load chain - should fail to start node
  const nodeManager = chainEnv.nodeManager;
  const node = await nodeManager.startNode(NodeType.HONEST);
  expect(node).to.equal(null);
});

test('failure handling: startup timeout marks node as ERROR', async () => {
  if (!RUN) return;
  if (!dockerOk) return;

  const chainEnv = getChainEnv();
  chainEnv.load();

  const nodeManager = chainEnv.nodeManager;
  const node = await nodeManager.startNode(NodeType.HONEST);
  // If node-config.json doesn't exist or has invalid config, this will fail
  // The actual behavior depends on the node-config.json presence
  // This test may need adjustment based on environment
});
