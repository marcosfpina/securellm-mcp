import { z } from "zod";
import type { DiagnoseResult } from "../types/package-debugger.js";
export declare const packageDiagnoseSchema: any;
export type PackageDiagnoseInput = z.infer<typeof packageDiagnoseSchema>;
export declare class PackageDiagnoseTool {
    private errorClassifier;
    private workspaceDir;
    private hostname;
    constructor(workspaceDir: string, hostname?: string);
    /**
     * Main diagnose function
     */
    diagnose(input: PackageDiagnoseInput): Promise<DiagnoseResult>;
    /**
     * Validate configuration file
     */
    private validateConfig;
    /**
     * Analyze configuration for potential issues
     */
    private analyzeConfig;
    /**
     * Test build the package
     */
    private testBuild;
    /**
     * Get Nix attribute path for package
     */
    private getAttributePath;
    /**
     * Extract package name from path
     */
    private extractPackageName;
    /**
     * Generate suggestions based on issues found
     */
    private generateSuggestions;
}
//# sourceMappingURL=package-diagnose.d.ts.map