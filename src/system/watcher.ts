import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import type { KnowledgeDatabase } from '../types/knowledge.js';

/**
 * Project Watcher
 * 
 * Monitors the filesystem for changes and updates the Knowledge Graph/State.
 * Enables the "Proactive" capability of the agent.
 */
export class ProjectWatcher extends EventEmitter {
  private watchers: fs.FSWatcher[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private changedFiles: Set<string> = new Set();
  private db: KnowledgeDatabase | null = null;

  constructor(private rootDir: string) {
    super();
  }

  public setDatabase(db: KnowledgeDatabase) {
    this.db = db;
  }

  public start() {
    try {
      // In a real enterprise app, we'd use 'chokidar' for robust cross-platform watching.
      // Using native fs.watch for zero-dependency implementation.
      const watcher = fs.watch(this.rootDir, { recursive: true }, (eventType, filename) => {
        if (filename && !this.isIgnored(filename)) {
          this.handleFileChange(filename);
        }
      });
      
      this.watchers.push(watcher);
      logger.info({ dir: this.rootDir }, "Project watcher active");
    } catch (error) {
      logger.warn({ err: error }, "Failed to start recursive watcher (fs.watch limitation?)");
    }
  }

  private isIgnored(filename: string): boolean {
    return filename.includes('node_modules') || 
           filename.includes('.git') || 
           filename.includes('build') ||
           filename.includes('.gemini');
  }

  private handleFileChange(filename: string) {
    this.changedFiles.add(filename);
    
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    
    this.debounceTimer = setTimeout(() => {
      this.flushChanges();
    }, 2000); // 2 second debounce
  }

  private async flushChanges() {
    const files = Array.from(this.changedFiles);
    this.changedFiles.clear();
    
    logger.info({ filesCount: files.length }, "Processing file changes");

    // Emit event for real-time systems
    this.emit('change', files);

    // Update Knowledge Graph (Persistent State)
    if (this.db) {
      try {
        // We store this as a "Project State Snapshot"
        // This allows the LLM to query: "What files did I just touch?"
        this.db.storeProjectState({
          root: this.rootDir,
          gitDirty: true,
          buildSuccess: false, // Assume dirty state invalidates build until proven otherwise
          recentFiles: files.slice(0, 10), // Store top 10 recent files
          fileTypes: this.countFileTypes(files),
          timestamp: Date.now()
        });
      } catch (err) {
        logger.error({ err }, "Failed to update knowledge DB with file changes");
      }
    }
  }

  private countFileTypes(files: string[]): Record<string, number> {
    const types: Record<string, number> = {};
    for (const f of files) {
      const ext = path.extname(f);
      types[ext] = (types[ext] || 0) + 1;
    }
    return types;
  }

  public stop() {
    this.watchers.forEach(w => w.close());
    this.watchers = [];
  }
}
