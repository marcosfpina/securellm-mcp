import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import type { KnowledgeDatabase } from '../types/knowledge.js';
import { KnowledgeChunker } from '../utils/chunker.js';

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
           filename.includes('.gemini') ||
           filename.endsWith('.db') ||
           filename.endsWith('.db-wal') ||
           filename.endsWith('.db-shm');
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
        // 1. Store Project State Snapshot
        this.db.storeProjectState({
          root: this.rootDir,
          gitDirty: true,
          buildSuccess: false,
          recentFiles: files.slice(0, 10),
          fileTypes: this.countFileTypes(files),
          timestamp: Date.now()
        });

        // 2. Extract and Chunk Content from important files
        for (const file of files) {
          await this.processFileKnowledge(file);
        }

      } catch (err) {
        logger.error({ err }, "Failed to update knowledge DB with file changes");
      }
    }
  }

  /**
   * Extract knowledge from a single file
   */
  private async processFileKnowledge(filename: string) {
    const filePath = path.resolve(this.rootDir, filename);
    
    // Only process readable text files of reasonable size
    const ext = path.extname(filename);
    const supportedExts = ['.ts', '.js', '.nix', '.md', '.toml', '.json'];
    
    if (!supportedExts.includes(ext)) return;

    try {
      if (!fs.existsSync(filePath)) return;
      const stats = fs.statSync(filePath);
      if (stats.size > 1024 * 100) return; // Limit to 100KB for now

      const content = fs.readFileSync(filePath, 'utf-8');
      
      // Chunk the content
      const chunks = KnowledgeChunker.splitByCode(content);
      
      // Store chunks in DB
      for (const chunk of chunks) {
        await this.db!.saveKnowledge({
          type: 'code',
          content: chunk.content,
          priority: 'medium',
          tags: ['auto-extract', ext.substring(1), filename],
          metadata: {
            file: filename,
            ...chunk.metadata
          }
        });
      }

      logger.debug({ file: filename, chunks: chunks.length }, "Knowledge extracted from file");
    } catch (err) {
      logger.error({ err, file: filename }, "Failed to process file knowledge");
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
