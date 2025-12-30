import { z } from "zod";
import type { DownloadResult } from "../types/package-debugger.js";
export declare const packageDownloadSchema: any;
export type PackageDownloadInput = z.infer<typeof packageDownloadSchema>;
export declare class PackageDownloadTool {
    private workspaceDir;
    constructor(workspaceDir: string);
    /**
     * Main download function
     */
    download(input: PackageDownloadInput): Promise<DownloadResult>;
    /**
     * Download from GitHub release
     */
    private downloadFromGitHub;
    /**
     * Get GitHub release info
     */
    private getGitHubReleaseInfo;
    /**
     * Find matching asset from release
     */
    private findMatchingAsset;
    /**
     * Download from NPM
     */
    private downloadFromNpm;
    /**
     * Get NPM package info
     */
    private getNpmPackageInfo;
    /**
     * Download from direct URL
     */
    private downloadFromUrl;
    /**
     * Download file using curl
     */
    private downloadFile;
    /**
     * Calculate SHA256 hash of a file
     */
    private calculateSha256;
    /**
     * Get file information
     */
    private getFileInfo;
    /**
     * Get storage directory for package type
     */
    private getStorageDir;
    /**
     * Generate configuration template
     */
    private generateConfigTemplate;
}
//# sourceMappingURL=package-download.d.ts.map