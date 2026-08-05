import fs from "node:fs";
import path from "node:path";

/** Atomic JSON file gateway for profile configuration. */
export function createFileProfileRepository(file) {
  return {
    read() { return JSON.parse(fs.readFileSync(file, "utf8")); },
    write(value) { const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`); fs.renameSync(temporary, file); },
    path: path.resolve(file),
  };
}
