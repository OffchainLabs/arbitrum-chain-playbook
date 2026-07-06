import type { ZodTypeAny } from 'zod';
import { OperationMode } from '../types/index.js';
import type { OperationContext } from '../utils/cancellation.js';

/**
 * Playbook interface definition
 * Each playbook must implement this interface to be registered in the playbook system
 */
export interface Playbook {
  /** Unique identifier for the playbook */
  id: string;

  /** Display name for the playbook */
  name: string;

  /** Brief description of what the playbook does */
  description: string;

  /** Which operation modes this playbook supports */
  supportedModes: OperationMode[];

  /**
   * Show the playbook's interactive menu
   * This method should handle all user interactions within the playbook
   */
  showMenu(): Promise<void>;

  // Headless entry — used by the scripted runner to drive a playbook from a
  // YAML/JSON file without inquirer. Implementations MUST share their core
  // execution path with showMenu so the two stay in lockstep.
  runHeadless?(command: string, params: unknown, ctx?: OperationContext): Promise<PlaybookActionResult>;

  /** List headless commands this playbook accepts (for discoverability / --help). */
  listHeadlessCommands?(): HeadlessCommandSpec[];
}

/**
 * Describes a single headless command exposed by a playbook.
 */
export interface HeadlessCommandSpec {
  command: string;
  description: string;
  supportedModes: OperationMode[];
  /**
   * True when the command always deploys a fresh chain before running.
   * Scripted/headless runners can use this to avoid restoring stale chain
   * state before the command gets a chance to redeploy.
   */
  redeploysChain?: boolean;
  /**
   * Zod schema for this command's `params`. The scripted runner validates
   * against it before dispatch; when absent, params pass through unchecked.
   * Declaring it here keeps command registration in one place — adding a new
   * headless command no longer requires touching runScript.ts.
   */
  paramsSchema?: ZodTypeAny;
}

/**
 * Playbook action result
 */
export interface PlaybookActionResult {
  success: boolean;
  message?: string;
  data?: unknown;
}

/**
 * Common playbook menu action
 */
export enum PlaybookMenuAction {
  BACK = 'back',
}
