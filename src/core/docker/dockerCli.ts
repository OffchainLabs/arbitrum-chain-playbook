import { dockerCommand } from 'docker-cli-js';

/**
 * Quiet docker command that suppresses all console output.
 * Uses docker-cli-js's echo: false option for safe output suppression.
 */
export const quietDockerCommand = async (command: string): Promise<{ raw?: string }> => {
  const result = await dockerCommand(command, { echo: false });
  return result;
};
