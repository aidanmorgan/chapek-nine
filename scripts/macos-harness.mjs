#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChapekCommandCore } from "./application/chapek-command-core.mjs";
import { createMacosPlatform } from "./infrastructure/os/macos/platform.mjs";

if (process.platform !== "darwin" && process.env.CHAPEK_ALLOW_UNSUPPORTED_PLATFORM !== "1") {
  throw new Error("harness.sh is for macOS. Use harness.ps1 on Windows.");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command = "help", profile, value, extra] = process.argv.slice(2);
const modelsDir = path.resolve(process.env.KIMI_MODELS_DIR || path.join(root, "models"));
const runtimeDir = path.resolve(process.env.KIMI_RUNTIME_DIR || path.join(root, "runtime"));
const profilesPath = path.join(root, "config", "profiles.json");
const platform = createMacosPlatform({ root, modelsDir, runtimeDir, profilesPath });
const core = createChapekCommandCore({ root, platform, profilesPath, modelsDir, runtimeDir });
await core.execute(command, profile, value, extra);
