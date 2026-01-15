/**
 * Nix Package Search
 *
 * Search for Nix packages across nixpkgs and other channels.
 */
import { executeNixCommand } from './utils/async-exec.js';
import { CacheManager } from '../../utils/cache-manager.js';
/**
 * Package Search
 */
export class PackageSearch {
    searchCache = new CacheManager({
        max: 500,
        ttl: 1800000, // 30 min
    });
    /**
     * Search for packages
     */
    async search(query, limit = 20) {
        const cacheKey = `search:${query}:${limit}`;
        const cached = this.searchCache.get(cacheKey);
        if (cached)
            return cached;
        try {
            // Use nix search for fast searching
            const output = await executeNixCommand(['search', 'nixpkgs', query, '--json'], {
                timeout: 30000,
                maxBuffer: 5 * 1024 * 1024,
            });
            const results = JSON.parse(output);
            const packages = [];
            for (const [attrPath, info] of Object.entries(results)) {
                const pkgInfo = info;
                packages.push({
                    name: pkgInfo.pname || this.extractName(attrPath),
                    version: pkgInfo.version || 'unknown',
                    description: pkgInfo.description,
                    attrPath,
                });
                if (packages.length >= limit)
                    break;
            }
            this.searchCache.set(cacheKey, packages);
            return packages;
        }
        catch (error) {
            // Fallback to simpler search if JSON fails
            return this.fallbackSearch(query, limit);
        }
    }
    getCacheStats() {
        return this.searchCache.getStats();
    }
    /**
     * Get package info
     */
    async getPackageInfo(attrPath) {
        try {
            const output = await executeNixCommand(['eval', `nixpkgs#${attrPath}.meta`, '--json'], {
                timeout: 10000,
            });
            const meta = JSON.parse(output);
            return {
                name: meta.pname || this.extractName(attrPath),
                version: meta.version || 'unknown',
                description: meta.description,
                attrPath,
            };
        }
        catch {
            return null;
        }
    }
    /**
     * Fallback search using grep
     */
    async fallbackSearch(query, limit) {
        try {
            const output = await executeNixCommand(['search', 'nixpkgs', query], {
                timeout: 30000,
                maxBuffer: 5 * 1024 * 1024,
            });
            return this.parseTextOutput(output, limit);
        }
        catch {
            return [];
        }
    }
    /**
     * Parse text search output
     */
    parseTextOutput(output, limit) {
        const packages = [];
        const lines = output.split('\n');
        let currentPackage = null;
        for (const line of lines) {
            if (line.startsWith('*')) {
                // New package entry
                if (currentPackage && currentPackage.attrPath) {
                    packages.push(currentPackage);
                    if (packages.length >= limit)
                        break;
                }
                const match = line.match(/\* ([^\s]+) \(([^)]+)\)/);
                if (match) {
                    currentPackage = {
                        attrPath: match[1],
                        version: match[2],
                        name: this.extractName(match[1]),
                    };
                }
            }
            else if (currentPackage && line.trim()) {
                // Description line
                currentPackage.description = line.trim();
            }
        }
        // Add last package
        if (currentPackage && currentPackage.attrPath) {
            packages.push(currentPackage);
        }
        return packages;
    }
    /**
     * Extract package name from attribute path
     */
    extractName(attrPath) {
        const parts = attrPath.split('.');
        return parts[parts.length - 1];
    }
}
//# sourceMappingURL=package-search.js.map