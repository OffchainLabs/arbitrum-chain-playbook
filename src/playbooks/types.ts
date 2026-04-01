import { OperationMode } from '../types/index.js';

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
