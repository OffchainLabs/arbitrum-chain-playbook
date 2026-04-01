import test from 'node:test';
import { expect } from 'chai';
import inquirer from 'inquirer';
import { NodeManager } from '../../src/core/docker/nodeManager';
import { NodeStatus, NodeType } from '../../src/types';

test('selectAndStopNode: only lists RUNNING nodes (excludes ERROR nodes)', async () => {
  const nodeManager = new NodeManager({} as any);

  // Seed internal nodes registry with one ERROR node and one RUNNING node.
  (nodeManager as any).nodes.set('main', {
    config: { id: 'main', nodeType: NodeType.MAIN, httpPort: 8547, wsPort: 8548 },
    status: NodeStatus.ERROR,
  });
  (nodeManager as any).nodes.set('honest-1', {
    config: { id: 'honest-1', nodeType: NodeType.HONEST, httpPort: 8557, wsPort: 8558 },
    status: NodeStatus.RUNNING,
  });

  const originalPrompt = (inquirer as any).prompt;
  let seenChoices: any[] | undefined;

  (inquirer as any).prompt = async (questions: any[]) => {
    seenChoices = questions?.[0]?.choices;
    return { selectedId: 'back' };
  };

  try {
    await (nodeManager as any).selectAndStopNode();
  } finally {
    (inquirer as any).prompt = originalPrompt;
  }

  const values = (seenChoices ?? []).map((c: any) => c.value);
  expect(values).to.include('honest-1');
  expect(values).to.not.include('main');
});
