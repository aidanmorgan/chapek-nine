import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "./json-file.ts";

/** Atomic JSON-file implementation of the profile repository port. */
export function createFileProfileRepository(file) {
  return {
    read() {
      const value = readJsonFile(file, undefined);
      if (value === undefined) throw new Error(`Profile configuration cannot be read: ${file}`);
      return value;
    },
    write(value) {
      writeJsonFileAtomic(file, value);
    },
    path: path.resolve(file),
  };
}
