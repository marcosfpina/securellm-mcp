import { z } from 'zod';
import { sandboxManager } from '../security/sandbox-manager.js';
import type { ExtendedTool } from '../types/mcp-tool-extensions.js';

export const executeInSandboxSchema = z.object({
  command: z.string().describe('The shell command to execute safely'),
  packages: z.array(z.string()).optional().default([]).describe('List of Nix packages to make available (e.g. ["nodejs", "jq"])'),
  use_project_flake: z.boolean().optional().default(false).describe('If true, include dependencies from the current directory flake.nix'),
  timeout_seconds: z.number().optional().default(60).describe('Execution timeout in seconds'),
});

export const executeInSandboxTool: ExtendedTool = {
  name: 'execute_in_sandbox',
  description: 'Execute a command in an isolated, ephemeral Nix sandbox. Protects the system from side effects.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute safely' },
      packages: { 
        type: 'array', 
        items: { type: 'string' },
        description: 'List of Nix packages to make available (e.g. ["nodejs", "jq"])'
      },
      use_project_flake: { 
        type: 'boolean', 
        description: 'If true, include dependencies from the current directory flake.nix' 
      },
      timeout_seconds: { 
        type: 'number', 
        description: 'Execution timeout in seconds' 
      }
    },
    required: ['command']
  },
  defer_loading: false
};

export async function handleExecuteInSandbox(args: z.infer<typeof executeInSandboxSchema>) {
  const { command, packages, use_project_flake, timeout_seconds } = args;

  // Determine cwd (current working directory)
  const cwd = process.cwd();

  const result = await sandboxManager.execute(command, {
    packages,
    inputsFrom: use_project_flake ? '.' : undefined,
    cwd,
    timeout: timeout_seconds * 1000,
    ignoreEnvironment: true // Enforce purity
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          status: result.failed ? 'failed' : 'success',
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          command_executed: result.command,
          isolation: 'pure-nix-shell'
        }, null, 2)
      }
    ],
    isError: result.failed
  };
}
