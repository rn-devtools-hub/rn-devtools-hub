#!/usr/bin/env node
/**
 * Does what these plugins call still exist?
 *
 * The asc and gplay plugins do not reimplement anything: every call is
 * Apple's or Google's own REST API, with their own auth. That is the
 * right trade, and its one risk is drift. Apple renames an attribute
 * between API versions, Google moves a method, and the failure surfaces
 * as a 400 in the middle of someone's release.
 *
 * So each plugin DECLARES what it depends on (CONTRACT), and this script
 * checks that declaration against the machine-readable specification the
 * vendor publishes: Apple's OpenAPI document and Google's discovery
 * document. It is the sync: not a vendored copy of their code, not a
 * generated client nobody reads, just a standing check that the surface
 * this hub couples to is still there.
 *
 *   npm run check:store-apis            report, exit 1 on drift
 *   npm run check:store-apis -- --strict a spec that cannot be fetched
 *                                        is also a failure
 *
 * Zero dependencies here too: the zip Apple serves is opened with
 * node:zlib, the same way the hub decodes a PNG.
 */

import { inflateRawSync } from "node:zlib";
import { CONTRACT as ASC } from "../server/plugins/asc.mjs";
import { CONTRACT as GPLAY } from "../server/plugins/gplay.mjs";

const STRICT = process.argv.includes("--strict");

const fetchBytes = async (url) => {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
};

/**
 * One file out of a zip, through the central directory.
 *
 * The local header is not enough: an entry written with a data
 * descriptor carries zeroed sizes there, and the real ones only exist in
 * the directory at the end.
 */
const unzipEntry = (buffer, matches) => {
  const EOCD = 0x06054b50;
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== EOCD) end -= 1;
  if (end < 0) throw new Error("not a zip archive: no end of central directory");

  let offset = buffer.readUInt32LE(end + 16);
  const count = buffer.readUInt16LE(end + 10);

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("corrupt central directory");
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf-8", offset + 46, offset + 46 + nameLength);

    if (matches(name)) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(start, start + compressedSize);
      return { name, bytes: compression === 0 ? data : inflateRawSync(data) };
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("no matching entry in the archive");
};

const loadOpenApi = async (spec) => {
  const bytes = await fetchBytes(spec.url);
  const entry = spec.url.endsWith(".zip")
    ? unzipEntry(bytes, (name) => name.endsWith(".json") && !name.startsWith("__MACOSX"))
    : { bytes };
  return JSON.parse(entry.bytes.toString("utf-8"));
};

const checkOpenApi = (document, contract) => {
  const problems = [];
  const paths = document.paths ?? {};
  for (const endpoint of contract.endpoints) {
    const entry = paths[endpoint.path];
    if (!entry) {
      problems.push(`gone: ${endpoint.method} ${endpoint.path} (${endpoint.why})`);
      continue;
    }
    if (!entry[endpoint.method.toLowerCase()]) {
      problems.push(
        `method gone: ${endpoint.method} ${endpoint.path} is now ${Object.keys(entry).join(", ").toUpperCase()} (${endpoint.why})`,
      );
    }
  }

  const schemas = document.components?.schemas ?? {};
  for (const group of contract.fields ?? []) {
    const attributes = schemas[group.schema]?.properties?.attributes?.properties;
    if (!attributes) {
      problems.push(`schema gone: ${group.schema}`);
      continue;
    }
    for (const field of group.read) {
      if (!(field in attributes)) problems.push(`field gone: ${group.schema}.${field}`);
    }
    const survivors = (group.tolerated ?? []).filter((field) => field in attributes);
    if ((group.tolerated ?? []).length && survivors.length === 0) {
      problems.push(`every tolerated name is gone on ${group.schema}: ${group.tolerated.join(", ")}`);
    }
  }
  return problems;
};

const checkDiscovery = (document, contract) => {
  const problems = [];
  const methods = new Map();
  const walk = (resource) => {
    for (const child of Object.values(resource.resources ?? {})) {
      for (const method of Object.values(child.methods ?? {})) methods.set(method.id, method);
      walk(child);
    }
  };
  walk(document);

  for (const endpoint of contract.endpoints) {
    if (!methods.has(endpoint.id)) problems.push(`gone: ${endpoint.id} (${endpoint.why})`);
  }

  const schemas = document.schemas ?? {};
  for (const group of contract.fields ?? []) {
    const properties = schemas[group.schema]?.properties;
    if (!properties) {
      problems.push(`schema gone: ${group.schema}`);
      continue;
    }
    for (const field of group.read) {
      if (!(field in properties)) problems.push(`field gone: ${group.schema}.${field}`);
    }
  }
  return problems;
};

const run = async ({ id, contract }) => {
  process.stdout.write(`\n  ${id}: ${contract.spec.name}\n`);
  let document;
  try {
    document = await loadOpenApi(contract.spec);
  } catch (error) {
    // A spec that cannot be downloaded is not the same fact as an API
    // that changed, and reporting it as drift would train people to
    // ignore this check
    process.stdout.write(`  skipped, the specification could not be read: ${error?.message ?? error}\n`);
    return STRICT ? 1 : 0;
  }

  const problems = contract.spec.kind === "discovery"
    ? checkDiscovery(document, contract)
    : checkOpenApi(document, contract);

  const fields = (contract.fields ?? []).reduce((total, group) => total + group.read.length, 0);
  if (problems.length === 0) {
    process.stdout.write(`  ${contract.endpoints.length} endpoints and ${fields} fields still exist\n`);
    return 0;
  }
  for (const problem of problems) process.stdout.write(`  DRIFT ${problem}\n`);
  return 1;
};

const failures = [
  await run({ id: "asc", contract: ASC }),
  await run({ id: "gplay", contract: GPLAY }),
].reduce((total, code) => total + code, 0);

process.stdout.write(failures ? "\n  The vendors moved. Update the plugin and its CONTRACT.\n\n" : "\n  In sync.\n\n");
process.exit(failures ? 1 : 0);
