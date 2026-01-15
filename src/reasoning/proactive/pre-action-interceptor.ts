/**
 * Pre-Action Interceptor
 * 
 * Intercepts tool calls to perform proactive checks and validation
 * BEFORE the tool is actually executed.
 */

import type { ContextManager } from '../context-manager.js';
import type { EnrichedContext } from '../../types/context-inference.js';

export interface PreAction {
  type: 'list_files' | 'check_git' | 'validate_build' | 'analyze_deps' | 'check_auth' | 'check_rate_limit';
  description: string;
  timeout: number;
  priority: number;
}

export interface PreActionResult {
  action: PreAction;
  success: boolean;
  data: any;
  duration: number;
  error?: string;
}

export interface ValidationResult {
  canProceed: boolean;
  warnings: string[];
  blockers: string[];
  suggestions: string[];
}

export class PreActionInterceptor {
  constructor(private contextManager: ContextManager) {}

  /**
   * Intercept tool call and perform proactive checks
   */
  async intercept(
    toolName: string,
    args: any
  ): Promise<{ shouldProceed: boolean; reason?: string; enrichedArgs?: any }> {
    // 1. Enrich context first
    const context = await this.contextManager.enrichContext(JSON.stringify({ tool: toolName, args }));
    
    // 2. Plan pre-actions
    const preActions = this.planPreActions(toolName, args, context);
    
    if (preActions.length === 0) {
      return { shouldProceed: true };
    }

    // 3. Execute pre-actions
    const results = await this.executePreActions(preActions);
    
    // 4. Validate results
    const validation = this.validateResults(toolName, results);

    if (!validation.canProceed) {
      return {
        shouldProceed: false,
        reason: `Pre-action checks failed: ${validation.blockers.join(', ')}`
      };
    }

    return { shouldProceed: true };
  }

  /**
   * Plan what checks to run based on tool and context
   */
  private planPreActions(
    toolName: string,
    args: any,
    context: EnrichedContext
  ): PreAction[] {
    const actions: PreAction[] = [];

    // File modification tools -> Check git status
    if (['write_file', 'replace_in_file', 'patch_file'].includes(toolName)) {
      actions.push({
        type: 'check_git',
        description: 'Check for uncommitted changes before modification',
        timeout: 500,
        priority: 1
      });
    }

    // Build/Test tools -> Check dependencies
    if (['run_test', 'build_project'].includes(toolName)) {
      actions.push({
        type: 'validate_build',
        description: 'Check if build environment is ready',
        timeout: 2000,
        priority: 2
      });
    }

    // Provider tools -> Check auth/rate limit (lightweight check)
    if (toolName.includes('provider') || ['deepseek', 'openai', 'anthropic'].some(p => toolName.includes(p))) {
      actions.push({
        type: 'check_auth',
        description: 'Verify API key presence',
        timeout: 100,
        priority: 0
      });
    }

    return actions.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Execute planned pre-actions
   */
  private async executePreActions(actions: PreAction[]): Promise<PreActionResult[]> {
    return Promise.all(actions.map(async action => {
      const startTime = Date.now();
      try {
        const result = await this.runAction(action);
        return {
          action,
          success: true,
          data: result,
          duration: Date.now() - startTime
        };
      } catch (error: any) {
        return {
          action,
          success: false,
          data: null,
          duration: Date.now() - startTime,
          error: error.message
        };
      }
    }));
  }

  /**
   * Run specific action logic
   */
  private async runAction(action: PreAction): Promise<any> {
    switch (action.type) {
      case 'check_git':
        // Reuse ProjectStateTracker from ContextManager if accessible, 
        // or just use a lightweight git check
        return this.contextManager.refreshState().git; // Assuming refreshState returns ProjectState
      
      case 'check_auth':
        // Simple env check
        return true; // Assume handled by main server logic, this is just a pre-check stub
        
      default:
        return { skipped: true };
    }
  }

  /**
   * Validate results to determine if we can proceed
   */
  private validateResults(toolName: string, results: PreActionResult[]): ValidationResult {
    const blockers: string[] = [];
    const warnings: string[] = [];

    for (const result of results) {
      if (!result.success) {
        // Decide if failure is blocking
        if (result.action.type === 'check_git' && ['write_file'].includes(toolName)) {
           // Maybe just warn for now? Or block if requested.
           // For this implementation, let's just warn unless it's critical.
           warnings.push(`Git check failed: ${result.error}`);
        } else {
           warnings.push(`${result.action.description} failed: ${result.error}`);
        }
      } else {
        // specific checks on data
        if (result.action.type === 'check_git' && result.data?.dirty && toolName === 'git_commit') {
           // e.g. warn if trying to commit but state is weird? 
           // actually if dirty, maybe we shouldn't overwrite?
        }
      }
    }

    return {
      canProceed: blockers.length === 0,
      blockers,
      warnings,
      suggestions: []
    };
  }
}
