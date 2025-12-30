import { z } from "zod";
import type { ConfigureResult } from "../types/package-debugger.js";
export declare const packageConfigureSchema: any;
export type PackageConfigureInput = z.infer<typeof packageConfigureSchema>;
export declare class PackageConfigureTool {
    private workspaceDir;
    constructor(workspaceDir: string);
    /**
     * Main configure function
     */
    configure(input: PackageConfigureInput): Promise<ConfigureResult>;
    /**
     * Configure TAR package
     */
    private configureTarPackage;
    /**
     * Configure JavaScript/NPM package
     */
    private configureJsPackage;
    /**
     * Configure DEB package
     */
    private configureDebPackage;
    /**
     * Inspect tarball structure
     */
    private inspectTarball;
    /**
     * Inspect NPM package
     */
    private inspectNpmPackage;
    /**
     * List files in tarball
     */
    private listTarballFiles;
    /**
     * Extract specific file from tarball
     */
    private extractFileFromTarball;
    /**
     * Select appropriate build method
     */
    private selectBuildMethod;
    /**
     * Map common license strings to nixpkgs license identifiers
     */
    private mapLicense;
    /**
     * Get configuration file path
     */
    private getConfigFilePath;
}
//# sourceMappingURL=package-configure.d.ts.map