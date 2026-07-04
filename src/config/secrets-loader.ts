import { execSync } from "child_process";
import { existsSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_PATH = path.join(__dirname, "../../../secrets/secrets.yaml");

export function loadSecrets(): void {
  if (!existsSync(SECRETS_PATH)) {
    // Secrets file absent — rely on shell environment (dev/CI)
    return;
  }

  try {
    const decrypted = execSync(`sops --decrypt --output-type dotenv "${SECRETS_PATH}"`, {
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    for (const line of decrypted.toString().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes added by sops dotenv output
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && !process.env[key]) {
        // Only set if not already overridden by shell environment
        process.env[key] = value;
      }
    }
  } catch (err: any) {
    // Non-fatal: if sops fails (e.g. no GPG agent), fall back to env vars
    process.stderr.write(
      `[secrets-loader] SOPS decrypt failed: ${err.message} — using shell environment\n`
    );
  }
}
