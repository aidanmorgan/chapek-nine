#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChapekCommandCore } from "./application/chapek-command-core.ts";
import { createWindowsPlatform } from "./infrastructure/os/windows/platform.ts";
import { createFileProfileRepository } from "./infrastructure/persistence/profile-repository.ts";

if (process.platform !== "win32" && process.env.CHAPEK_ALLOW_UNSUPPORTED_PLATFORM !== "1")
  throw new Error("windows-harness.ts is for Windows.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command = "help", profile, value, extra] = process.argv.slice(2);
const modelsDir = path.resolve(process.env.KIMI_MODELS_DIR || path.join(root, "models"));
const runtimeDir = path.resolve(process.env.KIMI_RUNTIME_DIR || path.join(root, "runtime"));
const profilesPath = path.join(root, "config", "profiles.json");
const platform = createWindowsPlatform({ root, modelsDir, runtimeDir, profilesPath });
await createChapekCommandCore({
  root,
  platform,
  modelsDir,
  runtimeDir,
  profileRepository: createFileProfileRepository(profilesPath),
}).execute(command, profile, value, extra);
