import inquirer from 'inquirer';
import { Playbook } from './types.js';
import { maliciousValidatorPlaybook } from './malicious-validator/index.js';
import logger from '../utils/logger.js';
import { breadcrumb } from '../utils/breadcrumb.js';
import { ChainEnv } from '../state/chainEnv/index.js';

/**
 * Playbook Registry
 * Manages all available playbooks in the system
 */
class PlaybookRegistry {
  private playbooks: Map<string, Playbook> = new Map();

  constructor() {
    // Register all available playbooks
    this.register(maliciousValidatorPlaybook);
  }

  /**
   * Register a playbook
   */
  register(playbook: Playbook): void {
    this.playbooks.set(playbook.id, playbook);
  }

  /**
   * Get all registered playbooks
   */
  getAll(): Playbook[] {
    return Array.from(this.playbooks.values());
  }

  /**
   * Get a playbook by ID
   */
  get(id: string): Playbook | undefined {
    return this.playbooks.get(id);
  }

  /**
   * Show the playbook list menu
   */
  async showPlaybookList(): Promise<void> {
    const mode = ChainEnv.getInstance().operationMode;
    const playbooks = this.getAll().filter((playbook) => playbook.supportedModes.includes(mode));

    if (playbooks.length === 0) {
      logger.warn('No playbooks available.');
      return;
    }

    breadcrumb.push('Playbooks');
    while (true) {
      const choices = [
        ...playbooks.map((p) => ({
          name: `${p.name} - ${p.description}`,
          value: p.id,
        })),
        new inquirer.Separator(),
        { name: '← Back to Main Menu', value: 'back' },
      ];

      breadcrumb.render();
      const { selected } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selected',
          message: 'Select a playbook:',
          choices,
        },
      ]);

      if (selected === 'back') {
        breadcrumb.pop();
        return;
      }

      const playbook = this.get(selected);
      if (playbook) {
        await playbook.showMenu();
      }

      logger.newline();
    }
  }
}

export const playbookRegistry = new PlaybookRegistry();
export default playbookRegistry;
