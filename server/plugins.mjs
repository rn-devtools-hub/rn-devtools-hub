/**
 * Hub plugins: the capabilities that do not live inside the app.
 *
 * Everything else in this hub reads a running JS runtime or the OS under
 * it. A release lives somewhere neither can see: App Store Connect knows
 * whether the build an agent just made finished processing, Google Play
 * knows what the last rollout is at. Those answers belong on the same bus
 * as the crashes, and they arrive through a plugin.
 *
 * The contract on purpose:
 *
 *   export default {
 *     id: "asc",                       // namespace; every tool is `${id}_*`
 *     title, summary, license,
 *     hosts: ["api.example.com"],      // every host this plugin will contact
 *     config: [{ key, env, pathEnv, required, secret, description, derive }],
 *     setupHint: "...",
 *     tools: [ { name, description, inputSchema, annotations } ],
 *     writeTools: [ ... ],             // the ones that CHANGE something
 *     handle(name, args, ctx),         // ctx = { config, projectRoot, state }
 *   }
 *
 * Three rules that are not negotiable, because a plugin is the one place
 * where this hub stops being local-only:
 *
 * 1. A plugin declares the hosts it contacts, and the hub prints them at
 *    startup and returns them from list_plugins. "Data never leaves the
 *    machine" stays true of the hub; a plugin that calls a vendor API is
 *    the user's own credentials talking to the user's own account, and
 *    that has to be visible rather than discovered in a proxy log.
 * 2. A plugin with no credentials is not an error and not a crash: it is
 *    listed as not configured, with what is missing and how to set it,
 *    and it contributes NO tool. Ten tools nobody can call would be ten
 *    tool definitions every agent pays for on every request.
 * 3. Secrets resolve here and stay here. list_plugins says a value is
 *    set and where it came from, never what it is.
 * 4. A plugin separates the tools that READ from the tools that CHANGE
 *    something, and the registry knows which is which. Writes ship
 *    enabled, because a release tool that can only look at a release is
 *    half a tool; a team that does not want an agent submitting or
 *    rolling out sets RN_DEVTOOLS_PLUGIN_WRITES=off (or the per-plugin
 *    RN_DEVTOOLS_<ID>_WRITES) and those tools are not exposed at all. It
 *    is one switch, in one place, rather than a judgement made tool by
 *    tool in a description nobody reads.
 *
 * Discovery is the built-in directory plus whatever RN_DEVTOOLS_PLUGINS
 * names explicitly. It is deliberately not "any file in a directory of
 * the project": auto-loading code that merely happens to sit somewhere is
 * a supply chain, not a feature.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const BUILTIN_PLUGIN_DIR = join(__dirname, "plugins");
export const CONFIG_FILE = join(".rn-devtools", "plugins.json");

const PLUGIN_ID = /^[a-z][a-z0-9]{1,15}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;

/** Keys live outside the repo far more often than inside it */
export const expandHome = (value) =>
  value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;

const readFileValue = (raw, projectRoot) => {
  const path = expandHome(String(raw));
  const full = isAbsolute(path) ? path : resolve(projectRoot, path);
  return { value: readFileSync(full, "utf-8"), path: full };
};

/** app.json, for the identifiers a plugin should never have to be told */
export const appConfig = (projectRoot) => {
  try {
    const parsed = JSON.parse(readFileSync(join(projectRoot, "app.json"), "utf-8"));
    return parsed?.expo ?? parsed ?? null;
  } catch {
    return null;
  }
};

export const readConfigFile = (projectRoot) => {
  const path = join(projectRoot, CONFIG_FILE);
  if (!existsSync(path)) return { path, exists: false, data: {}, error: null };
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { path, exists: true, data: {}, error: "plugins.json must be an object keyed by plugin id" };
    }
    return { path, exists: true, data, error: null };
  } catch (error) {
    return { path, exists: true, data: {}, error: `plugins.json is not readable: ${error?.message ?? error}` };
  }
};

/**
 * A plugin that would break the hub is disabled, never fatal.
 *
 * A tool name colliding with a core one is the dangerous case: the agent
 * would call `assert` and reach a plugin. So the reserved set wins and
 * the plugin is refused as a whole rather than half-loaded.
 */
export const validatePlugin = (plugin, { reserved = new Set(), taken = new Set() } = {}) => {
  if (!plugin || typeof plugin !== "object") return "the module exports no plugin object";
  if (!PLUGIN_ID.test(String(plugin.id ?? ""))) {
    return `invalid id ${JSON.stringify(plugin.id ?? null)}: 2 to 16 lowercase letters or digits`;
  }
  if (typeof plugin.handle !== "function") return `plugin ${plugin.id} has no handle(name, args, ctx)`;
  const declared = [...(plugin.tools ?? []), ...(plugin.writeTools ?? [])];
  if (!Array.isArray(plugin.tools) || declared.length === 0) return `plugin ${plugin.id} declares no tool`;
  if (plugin.writeTools !== undefined && !Array.isArray(plugin.writeTools)) {
    return `plugin ${plugin.id} declares writeTools that is not a list`;
  }
  for (const tool of declared) {
    const name = String(tool?.name ?? "");
    if (!TOOL_NAME.test(name)) return `plugin ${plugin.id} declares an invalid tool name ${JSON.stringify(tool?.name ?? null)}`;
    if (!name.startsWith(`${plugin.id}_`)) return `tool ${name} must start with "${plugin.id}_" so its owner is readable from the call`;
    if (reserved.has(name)) return `tool ${name} collides with a hub tool`;
    if (taken.has(name)) return `tool ${name} is already provided by another plugin`;
    if (!tool.inputSchema || typeof tool.inputSchema !== "object") return `tool ${name} has no inputSchema`;
    if (typeof tool.description !== "string" || !tool.description.trim()) return `tool ${name} has no description`;
  }
  for (const tool of plugin.writeTools ?? []) {
    // An MCP client decides whether to ask the human from these two
    // flags. A tool that changes something at Apple or Google and calls
    // itself read-only is the one mislabelling that must never ship.
    if (tool.annotations?.readOnlyHint !== false || tool.annotations?.destructiveHint !== true) {
      return `write tool ${tool.name} must carry annotations {readOnlyHint: false, destructiveHint: true}`;
    }
  }
  return null;
};

/**
 * Where each value came from: an env var, a file that env var pointed at,
 * plugins.json, or the project's own app.json. The source is reported and
 * the value is not, which is the whole point of separating them.
 */
export const resolveConfig = (plugin, { env = {}, projectRoot = process.cwd(), file = {} } = {}) => {
  const declared = Array.isArray(plugin.config) ? plugin.config : [];
  const own = file?.[plugin.id] ?? {};
  const values = {};
  const entries = [];
  const missing = [];

  for (const entry of declared) {
    const key = String(entry.key);
    let value = null;
    let source = null;

    for (const name of entry.env ?? []) {
      if (env[name]) { value = env[name]; source = `env:${name}`; break; }
    }
    if (value === null) {
      for (const name of entry.pathEnv ?? []) {
        if (!env[name]) continue;
        try {
          const read = readFileValue(env[name], projectRoot);
          value = read.value;
          source = `file:${read.path} (${name})`;
        } catch (error) {
          // A path that was given and does not resolve is a mistake worth
          // naming: silently falling through reads as "not configured"
          missing.push({ key, description: `${name} points at a file that cannot be read: ${error?.message ?? error}` });
          value = null;
          source = null;
        }
        break;
      }
    }
    if (value === null && own[key] !== undefined && own[key] !== null && own[key] !== "") {
      value = typeof own[key] === "string" ? own[key] : JSON.stringify(own[key]);
      source = `${CONFIG_FILE}:${plugin.id}.${key}`;
    }
    if (value === null && own[`${key}Path`]) {
      try {
        const read = readFileValue(own[`${key}Path`], projectRoot);
        value = read.value;
        source = `file:${read.path} (${plugin.id}.${key}Path)`;
      } catch (error) {
        missing.push({ key, description: `${plugin.id}.${key}Path cannot be read: ${error?.message ?? error}` });
      }
    }
    if (value === null && typeof entry.derive === "function") {
      const derived = entry.derive({ projectRoot, appConfig: appConfig(projectRoot) });
      if (derived) { value = String(derived); source = "project:app.json"; }
    }

    const set = value !== null && value !== undefined && String(value) !== "";
    if (set) values[key] = String(value);
    if (!set && entry.required !== false && !missing.some((item) => item.key === key)) {
      missing.push({
        key,
        description: entry.description ?? "",
        env: entry.env ?? [],
        pathEnv: entry.pathEnv ?? [],
      });
    }
    entries.push({
      key,
      description: entry.description ?? "",
      required: entry.required !== false,
      secret: entry.secret === true,
      set,
      // A secret's origin is safe to show; a secret's value is not, and a
      // path is an origin. Only the bytes stay behind.
      source: set ? source : null,
    });
  }

  return { values, entries, missing };
};

/**
 * Whether this plugin may change anything.
 *
 * On by default: a plugin that reaches App Store Connect and cannot
 * submit a build is a browser tab with extra steps. Off is one variable,
 * globally or per plugin, and the tools then do not exist rather than
 * existing and refusing, so an agent never plans a step it cannot take.
 */
const OFF = new Set(["off", "0", "false", "no", "read-only", "readonly"]);

export const writesAllowed = (id, env = {}) => {
  const specific = env[`RN_DEVTOOLS_${String(id).toUpperCase()}_WRITES`];
  const global = env.RN_DEVTOOLS_PLUGIN_WRITES;
  const raw = specific ?? global;
  if (raw === undefined || raw === null || raw === "") return { enabled: true, disabledBy: null };
  if (!OFF.has(String(raw).trim().toLowerCase())) return { enabled: true, disabledBy: null };
  return {
    enabled: false,
    disabledBy: specific !== undefined && specific !== null && specific !== ""
      ? `RN_DEVTOOLS_${String(id).toUpperCase()}_WRITES`
      : "RN_DEVTOOLS_PLUGIN_WRITES",
  };
};

const listModules = (source) => {
  const path = expandHome(String(source));
  if (!existsSync(path)) return { files: [], error: `no such plugin source: ${path}` };
  if (!statSync(path).isDirectory()) return { files: [path], error: null };
  const files = readdirSync(path)
    .filter((name) => name.endsWith(".mjs") && !name.startsWith("_"))
    .sort()
    .map((name) => join(path, name));
  return { files, error: null };
};

/**
 * Builds the registry once, at startup.
 *
 * Config is read here and not per call: a hub whose tool list changes
 * under a client that was told listChanged:false is a client calling a
 * tool that no longer exists. Configure, then restart the hub, and the
 * banner says what came up.
 */
export const createPluginHost = async ({
  projectRoot = process.cwd(),
  env = process.env,
  reserved = new Set(),
  sources = null,
} = {}) => {
  const configFile = readConfigFile(projectRoot);
  const declaredSources = sources ?? [
    BUILTIN_PLUGIN_DIR,
    ...String(env.RN_DEVTOOLS_PLUGINS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
  ];

  const records = [];
  const taken = new Set();
  const failures = [];

  for (const source of declaredSources) {
    const listed = listModules(source);
    if (listed.error) { failures.push(listed.error); continue; }
    for (const file of listed.files) {
      let plugin = null;
      try {
        const module = await import(pathToFileURL(file).href);
        plugin = module.default ?? module.plugin ?? null;
      } catch (error) {
        failures.push(`${file} failed to load: ${error?.message ?? error}`);
        continue;
      }
      const invalid = validatePlugin(plugin, { reserved, taken });
      if (invalid) { failures.push(`${file} was refused: ${invalid}`); continue; }

      const resolved = resolveConfig(plugin, { env, projectRoot, file: configFile.data });
      const writes = writesAllowed(plugin.id, env);
      const readTools = plugin.tools ?? [];
      const writeTools = plugin.writeTools ?? [];
      const record = {
        id: plugin.id,
        title: plugin.title ?? plugin.id,
        summary: plugin.summary ?? "",
        license: plugin.license ?? null,
        hosts: Array.isArray(plugin.hosts) ? plugin.hosts : [],
        setupHint: plugin.setupHint ?? "",
        docs: plugin.docs ?? null,
        tools: readTools,
        writeTools,
        writes,
        ready: resolved.missing.length === 0,
        missing: resolved.missing,
        entries: resolved.entries,
        source: file,
        plugin,
        config: resolved.values,
        state: {},
      };
      for (const tool of [...readTools, ...writeTools]) taken.add(tool.name);
      records.push(record);
    }
  }

  /** What a plugin actually contributes: nothing without credentials,
   * and the reading half only when writes are switched off */
  const exposedTools = (record) => {
    if (!record.ready) return [];
    return record.writes.enabled ? [...record.tools, ...record.writeTools] : record.tools;
  };

  const byTool = new Map();
  for (const record of records) {
    for (const tool of exposedTools(record)) byTool.set(tool.name, record);
  }

  const describe = () => ({
    configFile: { path: configFile.path, exists: configFile.exists, error: configFile.error },
    failures,
    plugins: records.map((record) => ({
      id: record.id,
      title: record.title,
      summary: record.summary,
      license: record.license,
      hosts: record.hosts,
      ready: record.ready,
      // A tool an agent cannot call is not offered, so say what is behind
      // the door rather than pretending the plugin has nothing in it
      tools: record.tools.map((tool) => tool.name),
      writeTools: record.writeTools.map((tool) => tool.name),
      writes: record.writes,
      exposed: exposedTools(record).map((tool) => tool.name),
      missing: record.missing,
      config: record.entries,
      setupHint: record.setupHint,
      docs: record.docs,
    })),
  });

  return {
    records,
    configFile,
    failures,
    /** Only ready plugins reach an agent's tool list */
    tools: () => records.flatMap(exposedTools),
    owns: (name) => byTool.has(name)
      || records.some((record) => [...record.tools, ...record.writeTools].some((tool) => tool.name === name)),
    describe,
    handle: async (name, args = {}) => {
      const record = byTool.get(name);
      if (!record) {
        const known = records.find((entry) =>
          [...entry.tools, ...entry.writeTools].some((tool) => tool.name === name));
        if (!known) throw new Error(`Unknown plugin tool: ${name}`);
        if (known.ready && !known.writes.enabled) {
          throw new Error(
            `${name} changes something on ${known.title} and writes are switched off by ${known.writes.disabledBy}. Unset it and restart the hub to allow it.`,
          );
        }
        const missing = known.missing.map((entry) => entry.key).join(", ");
        throw new Error(
          `${known.title} is not configured, so ${name} cannot run. Missing: ${missing}. ${known.setupHint}`.trim(),
        );
      }
      return record.plugin.handle(name, args, {
        config: record.config,
        projectRoot,
        state: record.state,
        appConfig: () => appConfig(projectRoot),
      });
    },
    /** What the startup banner prints: what is on, and who it will talk to */
    banner: () => {
      const lines = [];
      for (const record of records) {
        if (record.ready) {
          const count = exposedTools(record).length;
          // A hub that can submit a build to Apple says so on the line
          // where someone reads it, not in a document they may not open
          const writes = record.writeTools.length === 0 ? ""
            : record.writes.enabled ? ", CAN CHANGE releases"
            : `, read only (${record.writes.disabledBy})`;
          lines.push(`  Plugin    : ${record.title} (${count} tools${writes}, talks to ${record.hosts.join(", ")})`);
        } else {
          lines.push(`  Plugin    : ${record.title} is available but not configured (${record.missing.map((entry) => entry.key).join(", ")})`);
        }
      }
      for (const failure of failures) lines.push(`  Plugin    : ${failure}`);
      return lines;
    },
  };
};

export const LIST_PLUGINS_TOOL = {
  name: "list_plugins",
  description:
    "Lists the hub plugins, which reach the services around the app rather than the app itself (App Store Connect, Google Play). For each one: whether it is configured, which tools it exposes, which of them CHANGE something (writeTools) and whether writes are enabled, the exact configuration keys still missing and where to set them, and every host it will contact. A plugin with no credentials exposes no tool at all, so this is the only place its tools are visible before it is set up. Credentials are never returned, only whether they are set and where they came from.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};
