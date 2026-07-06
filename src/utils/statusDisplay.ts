/**
 * Status Display — formatted, color-coded tables for "View Status".
 *
 * Provides helpers to render chain info, node tables, and account lists
 * using cli-table3 with consistent color coding:
 *   Green  = healthy / running / success
 *   Yellow = warning / degraded / starting
 *   Red    = error / down
 *   Blue   = informational
 */

import Table from 'cli-table3';
import chalk from 'chalk';
import { NodeInstance, NodeStatus, NodeType } from '../types/index.js';

// Shared bordered-table character preset (indented two spaces to align with
// the section headers above each table).
const TABLE_CHARS = {
  top: '─',
  'top-mid': '┬',
  'top-left': '  ┌',
  'top-right': '┐',
  bottom: '─',
  'bottom-mid': '┴',
  'bottom-left': '  └',
  'bottom-right': '┘',
  left: '  │',
  'left-mid': '  ├',
  mid: '─',
  'mid-mid': '┼',
  right: '│',
  'right-mid': '┤',
  middle: '│',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Color helpers
// ─────────────────────────────────────────────────────────────────────────────

function colorForNodeStatus(status: NodeStatus): (s: string) => string {
  switch (status) {
    case NodeStatus.RUNNING:
      return chalk.green;
    case NodeStatus.STARTING:
      return chalk.yellow;
    case NodeStatus.STOPPED:
      return chalk.gray;
    case NodeStatus.ERROR:
      return chalk.red;
  }
}

function colorForNodeType(type: NodeType): (s: string) => string {
  switch (type) {
    case NodeType.HONEST:
      return chalk.green;
    case NodeType.MALICIOUS:
      return chalk.red;
    case NodeType.MAIN:
      return chalk.cyan;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Key-value info table (for chain info, remote RPC info, devnode info)
// ─────────────────────────────────────────────────────────────────────────────

export function renderInfoTable(title: string, rows: Array<{ label: string; value: string }>): void {
  console.log();
  console.log(chalk.bold.cyan(`▸ ${title}`));
  console.log();

  const table = new Table({
    chars: {
      top: '',
      'top-mid': '',
      'top-left': '',
      'top-right': '',
      bottom: '',
      'bottom-mid': '',
      'bottom-left': '',
      'bottom-right': '',
      left: '  ',
      'left-mid': '',
      mid: '',
      'mid-mid': '',
      right: '',
      'right-mid': '',
      middle: '  ',
    },
    style: { 'padding-left': 0, 'padding-right': 0 },
  });

  for (const row of rows) {
    table.push([chalk.dim(row.label), row.value]);
  }

  console.log(table.toString());
}

// ─────────────────────────────────────────────────────────────────────────────
// Node table
// ─────────────────────────────────────────────────────────────────────────────

interface NodeRowData {
  id: string;
  type: NodeType;
  status: NodeStatus;
  httpPort: number;
  wsPort: number;
  uptime?: string;
  containerId?: string;
}

export function buildNodeRow(id: string, node: NodeInstance, uptime?: string): NodeRowData {
  return {
    id,
    type: node.config.nodeType,
    status: node.status,
    httpPort: node.config.httpPort,
    wsPort: node.config.wsPort,
    uptime,
    containerId: node.containerId,
  };
}

export function renderNodeTable(rows: NodeRowData[]): void {
  console.log();
  console.log(chalk.bold.cyan('▸ Node Status'));
  console.log();

  if (rows.length === 0) {
    console.log(chalk.dim('  No running nodes'));
    return;
  }

  const table = new Table({
    head: [
      chalk.bold('ID'),
      chalk.bold('Type'),
      chalk.bold('Status'),
      chalk.bold('HTTP'),
      chalk.bold('WS'),
      chalk.bold('Uptime'),
    ],
    chars: TABLE_CHARS,
    style: { head: [], border: ['gray'] },
  });

  for (const row of rows) {
    const statusColor = colorForNodeStatus(row.status);
    const typeColor = colorForNodeType(row.type);

    table.push([
      chalk.bold(row.id),
      typeColor(row.type),
      statusColor(row.status),
      `http://localhost:${row.httpPort}`,
      row.wsPort > 0 ? `ws://localhost:${row.wsPort}` : chalk.dim('n/a'),
      row.uptime ?? chalk.dim('—'),
    ]);
  }

  console.log(table.toString());
}

// ─────────────────────────────────────────────────────────────────────────────
// Sender accounts table
// ─────────────────────────────────────────────────────────────────────────────

interface AccountRow {
  role: string;
  address: string;
}

export function renderAccountsTable(accounts: AccountRow[]): void {
  console.log();
  console.log(chalk.bold.cyan('▸ Sender Accounts'));
  console.log();

  if (accounts.length === 0) {
    console.log(chalk.dim('  No sender accounts configured'));
    return;
  }

  const table = new Table({
    head: [chalk.bold('Role'), chalk.bold('Address')],
    chars: TABLE_CHARS,
    style: { head: [], border: ['gray'] },
  });

  for (const account of accounts) {
    table.push([account.role, account.address]);
  }

  console.log(table.toString());
}
