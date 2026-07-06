import { NodeInstance, NodeType } from '../types/index.js';
import { DevnodeManager } from './devnodeManager.js';
import { renderNodeTable, buildNodeRow } from '../utils/statusDisplay.js';

export class DevnodeNodeManager {
  private devnodeManager = new DevnodeManager();
  private cachedNode: NodeInstance | null = null;

  constructor(_chainEnv: unknown) {
    void _chainEnv;
  }

  async discoverExistingContainers(): Promise<void> {
    this.cachedNode = await this.devnodeManager.getDevnodeNodeInstance();
  }

  getRunningNodes(): NodeInstance[] {
    if (this.cachedNode) return [this.cachedNode];
    return [];
  }

  getNode(nodeId: string): NodeInstance | undefined {
    if (!this.cachedNode) return undefined;
    return this.cachedNode.config.id === nodeId ? this.cachedNode : undefined;
  }

  getNodes(): Map<string, NodeInstance> {
    const nodes = new Map<string, NodeInstance>();
    if (this.cachedNode) nodes.set(this.cachedNode.config.id, this.cachedNode);
    return nodes;
  }

  async checkNodeHealth(_nodeId: string): Promise<boolean> {
    return this.devnodeManager.isDevnodeRunning();
  }

  async getNodeUptime(_nodeId: string): Promise<string> {
    return 'unknown';
  }

  // The devnode is a single dev container; there is no background health loop.
  isMonitoringActive(): boolean {
    return false;
  }

  async startHealthMonitoring(): Promise<void> {}

  stopHealthMonitoring(): void {}

  displayStatus(): void {
    if (!this.cachedNode) {
      renderNodeTable([]);
      return;
    }
    renderNodeTable([buildNodeRow(this.cachedNode.config.id, this.cachedNode)]);
  }

  async stopNode(nodeId: string): Promise<boolean> {
    if (!this.cachedNode || this.cachedNode.config.id !== nodeId) {
      return false;
    }
    await this.devnodeManager.stopDevnode();
    this.cachedNode = null;
    return true;
  }

  async stopAllNodes(): Promise<void> {
    await this.devnodeManager.stopDevnode();
    this.cachedNode = null;
  }

  async startNode(_type: NodeType): Promise<NodeInstance | null> {
    await this.devnodeManager.startDevnode();
    await this.discoverExistingContainers();
    return this.cachedNode;
  }
}
