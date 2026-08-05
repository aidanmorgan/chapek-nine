import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DuckDBConnection } from "@duckdb/node-api";

const [inputDirectory, outputDirectory = inputDirectory] = process.argv.slice(2);
if (!inputDirectory) {
  throw new Error("Usage: materialize-coordinator-corpus.mjs <input-dir> [output-dir]");
}

const input = path.resolve(inputDirectory);
const output = path.resolve(outputDirectory);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonLines(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function coordinatorRows(file) {
  return readJsonLines(file).map((value) => {
    const route = JSON.parse(value.messages.at(-1).content);
    return {
      id: value.id,
      taskId: value.taskId,
      category: value.category,
      messagesJson: JSON.stringify(value.messages),
      routeJson: value.messages.at(-1).content,
      tier: route.tier,
      primaryRole: route.primary.role,
      primaryModel: route.primary.model,
      maxTokens: route.primary.maxTokens ?? null,
    };
  });
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function writeParquet(connection, rows, outputFile) {
  await connection.run(`
    CREATE TABLE corpus (
      id VARCHAR,
      task_id VARCHAR,
      category VARCHAR,
      messages_json VARCHAR,
      route_json VARCHAR,
      tier VARCHAR,
      primary_role VARCHAR,
      primary_model VARCHAR,
      max_tokens INTEGER
    )
  `);
  const appender = await connection.createAppender("corpus");
  for (const row of rows) {
    appender.appendVarchar(row.id);
    appender.appendVarchar(row.taskId);
    appender.appendVarchar(row.category);
    appender.appendVarchar(row.messagesJson);
    appender.appendVarchar(row.routeJson);
    appender.appendVarchar(row.tier);
    appender.appendVarchar(row.primaryRole);
    appender.appendVarchar(row.primaryModel);
    if (row.maxTokens === null) appender.appendNull();
    else appender.appendInteger(row.maxTokens);
    appender.endRow();
  }
  appender.closeSync();
  const escaped = outputFile.replaceAll("'", "''").replaceAll("\\", "/");
  await connection.run(`COPY corpus TO '${escaped}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
  const reader = await connection.runAndReadAll("SELECT count(*) AS rows FROM corpus");
  const [{ rows: count }] = reader.getRowObjects();
  await connection.run("DROP TABLE corpus");
  return Number(count);
}

async function main() {
  const sourceManifest = readJson(path.join(input, "manifest.json"));
  const train = coordinatorRows(path.join(input, "train.jsonl"));
  const validation = coordinatorRows(path.join(input, "validation.jsonl"));
  fs.mkdirSync(output, { recursive: true });

  const connection = await DuckDBConnection.create();
  try {
    const trainPath = path.join(output, "train.parquet");
    const validationPath = path.join(output, "validation.parquet");
    const trainRows = await writeParquet(connection, train, trainPath);
    const validationRows = await writeParquet(connection, validation, validationPath);
    const readers = await Promise.all([
      connection.runAndReadAll(`SELECT count(DISTINCT task_id) AS families FROM read_parquet('${trainPath.replaceAll("\\", "/").replaceAll("'", "''")}')`),
      connection.runAndReadAll(`SELECT count(DISTINCT task_id) AS families FROM read_parquet('${validationPath.replaceAll("\\", "/").replaceAll("'", "''")}')`),
      connection.runAndReadAll(`SELECT count(*) AS overlap FROM (SELECT DISTINCT task_id FROM read_parquet('${trainPath.replaceAll("\\", "/").replaceAll("'", "''")}') INTERSECT SELECT DISTINCT task_id FROM read_parquet('${validationPath.replaceAll("\\", "/").replaceAll("'", "''")}'))`),
    ]);
    const trainFamilies = Number(readers[0].getRowObjects()[0].families);
    const validationFamilies = Number(readers[1].getRowObjects()[0].families);
    const overlap = Number(readers[2].getRowObjects()[0].overlap);
    if (overlap) throw new Error(`train/validation task-family leakage: ${overlap} overlapping IDs`);
    const manifest = {
      version: 3,
      format: "Parquet (Zstandard), materialized and verified with DuckDB Node API",
      trainRows,
      validationRows,
      trainTaskFamilies: trainFamilies,
      validationTaskFamilies: validationFamilies,
      taskFamilyOverlap: overlap,
      source: sourceManifest,
      files: {
        "train.parquet": { sha256: sha256(trainPath), bytes: fs.statSync(trainPath).size },
        "validation.parquet": { sha256: sha256(validationPath), bytes: fs.statSync(validationPath).size },
      },
    };
    fs.writeFileSync(path.join(output, "parquet-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    connection.closeSync();
  }
}

await main();
