#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChapekCommandCore } from "./application/chapek-command-core.mjs";
import { createWindowsPlatform } from "./infrastructure/os/windows/platform.mjs";

if (process.platform !== "win32" && process.env.CHAPEK_ALLOW_UNSUPPORTED_PLATFORM !== "1") throw new Error("windows-harness.mjs is for Windows.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command = "help", profile, value] = process.argv.slice(2);
const modelsDir = path.resolve(process.env.KIMI_MODELS_DIR || path.join(root, "models"));
const runtimeDir = path.resolve(process.env.KIMI_RUNTIME_DIR || path.join(root, "runtime"));
const profilesPath = path.join(root, "config", "profiles.json");
const platform = createWindowsPlatform({ root, modelsDir, runtimeDir, profilesPath });
await createChapekCommandCore({ root, platform, profilesPath, modelsDir, runtimeDir }).execute(command, profile, value);
