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
