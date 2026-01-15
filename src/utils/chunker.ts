/**
 * Knowledge Chunker Utility
 * 
 * Splits large files/text into smaller, semantically coherent chunks
 * for better processing and storage in the knowledge base.
 */

export interface Chunk {
  content: string;
  metadata: {
    startLine: number;
    endLine: number;
    tokens?: number;
    type: 'function' | 'class' | 'text' | 'code_block';
  };
}

export class KnowledgeChunker {
  /**
   * Split text into fixed-size chunks with overlap
   */
  public static splitByFixedSize(text: string, chunkSize = 1000, overlap = 200): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      chunks.push(text.substring(start, end));
      start += chunkSize - overlap;
    }

    return chunks;
  }

  /**
   * Smart split by code structure (simplified)
   */
  public static splitByCode(code: string): Chunk[] {
    const lines = code.split('\n');
    const chunks: Chunk[] = [];
    
    let currentChunk: string[] = [];
    let startLine = 1;
    
    // Heuristic: Split by double newlines or significant structural changes
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      currentChunk.push(line);
      
      // If we hit a potential boundary (e.g., end of a block or max lines)
      if ((line.trim() === '}' && currentChunk.length > 10) || currentChunk.length >= 50) {
        chunks.push({
          content: currentChunk.join('\n'),
          metadata: {
            startLine,
            endLine: i + 1,
            type: 'code_block'
          }
        });
        
        currentChunk = [];
        startLine = i + 2;
      }
    }
    
    if (currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.join('\n'),
        metadata: {
          startLine,
          endLine: lines.length,
          type: 'code_block'
        }
      });
    }
    
    return chunks;
  }
}
