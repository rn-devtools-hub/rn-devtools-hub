/**
 * Turning bundle coordinates back into source coordinates.
 *
 * This closes the gap the source cascade cannot close from inside the app.
 * Verified on React 19.2.3: the `source` argument handed to jsxDEV is
 * dropped outright, `_debugSource` no longer exists, and what survives is
 * `_debugStack`, an Error whose frames point INTO THE BUNDLE:
 *
 *   at ServiceCard (http://localhost:8081/index.bundle?platform=ios:48213:19)
 *
 * A component name and a bundle offset are not what an agent needs. It
 * needs src/components/ServiceCard.tsx:42, and only Metro knows the map
 * between the two. Metro exposes /symbolicate for exactly this, so the hub
 * asks it and upgrades the location before the agent ever sees it.
 *
 * Everything degrades: no Metro, an old Metro, a frame it cannot place, and
 * the raw frames are returned untouched rather than the call failing.
 */

const FRAME_PATTERNS = [
  // V8: "at Component (url:line:column)" and "at url:line:column"
  /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/,
  // Hermes: "Component@url:line:column"
  /^\s*(.+?)@(.+?):(\d+):(\d+)$/,
];

/** Frames as strings become the shape Metro's /symbolicate expects */
export const parseFrames = (frames) => {
  const parsed = [];
  for (const raw of frames ?? []) {
    const line = String(raw);
    for (const pattern of FRAME_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      const [, methodName, file, lineNumber, column] = match;
      parsed.push({
        methodName: methodName?.trim() || "<unknown>",
        file,
        lineNumber: Number(lineNumber),
        column: Number(column),
      });
      break;
    }
  }
  return parsed;
};

/**
 * The first frame that belongs to the app rather than to a library.
 *
 * Symbolication answers for every frame, and the top ones are React's own
 * jsxDEV plumbing: returning those would point an agent at node_modules
 * instead of at the component it asked about.
 */
export const firstAppFrame = (frames) =>
  frames?.find((frame) => {
    if (!frame?.file || frame.collapse) return false;
    // Metro answers 200 even for positions it cannot map, handing back the
    // BUNDLE URL with a null line. Verified against Metro on a real Expo 56
    // project. Such a frame passes a naive library filter and would be
    // reported as a source location pointing at a URL.
    if (/^https?:\/\//.test(String(frame.file))) return false;
    // Not Number(frame.lineNumber): Number(null) is 0, which is finite, so
    // an unmapped frame would sail through as line zero
    if (typeof frame.lineNumber !== "number" || !Number.isFinite(frame.lineNumber)) return false;
    return !/node_modules|react-jsx|\/react\/cjs\/|\[native code\]|InternalBytecode/.test(
      String(frame.file)
    );
  }) ?? null;

const isLocalhost = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(String(url ?? ""));

/**
 * Guesses Metro's address from the frames themselves. The bundle URL in a
 * stack IS the Metro server that served it, which is more reliable than
 * assuming port 8081 on a project that moved it.
 */
export const metroUrlFromFrames = (frames, fallback = "http://localhost:8081") => {
  for (const frame of frames ?? []) {
    try {
      const url = new URL(frame.file);
      if (url.protocol.startsWith("http")) return url.origin;
    } catch {
      // relative or non-URL file, keep looking
    }
  }
  return fallback;
};

/**
 * Asks Metro to map bundle positions back to source positions.
 * `fetchImpl` is injected so the mapping can be tested without a Metro.
 */
export const symbolicate = async (rawFrames, options = {}) => {
  const frames = parseFrames(rawFrames);
  if (!frames.length) return { ok: false, reason: "no parsable frames", frames: [] };

  const metroUrl = options.metroUrl ?? metroUrlFromFrames(frames);
  // Symbolicating against a remote host would leak a stack off the machine;
  // Metro is a local dev server and nothing else should be asked
  if (!isLocalhost(metroUrl)) {
    return { ok: false, reason: `refusing to symbolicate against a non-local host: ${metroUrl}`, frames: [] };
  }

  const request = options.fetchImpl ?? fetch;
  try {
    const response = await request(`${metroUrl}/symbolicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stack: frames }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    if (!response.ok) {
      return { ok: false, reason: `Metro answered ${response.status}`, frames: [] };
    }
    const body = await response.json();
    return { ok: true, metroUrl, frames: Array.isArray(body?.stack) ? body.stack : [] };
  } catch (error) {
    // Metro not running, wrong port, or too old: the raw frames stay usable
    return { ok: false, reason: String(error?.message ?? error), frames: [] };
  }
};

/**
 * Upgrades a source location resolved as `via:"stack"` into a real file and
 * line. Anything already exact is returned untouched: symbolicating it
 * would be a round trip for an answer we already have.
 */
export const upgradeSource = async (source, options = {}) => {
  if (!source || source.via !== "stack" || !source.stack?.length) return source;
  const result = await symbolicate(source.stack, options);
  if (!result.ok) {
    return { ...source, symbolication: { ok: false, reason: result.reason } };
  }
  const frame = firstAppFrame(result.frames);
  if (!frame) {
    return { ...source, symbolication: { ok: false, reason: "no application frame in the symbolicated stack" } };
  }
  return {
    file: frame.file,
    line: frame.lineNumber ?? null,
    column: frame.column ?? null,
    componentName: frame.methodName ?? source.componentName ?? null,
    via: "symbolicated",
  };
};

/** Walks a UI tree or a match list and upgrades every stack-based source.
 * One Metro round trip per distinct stack, not one per node. */
export const upgradeTreeSources = async (nodes, options = {}) => {
  const cache = new Map();
  const upgradeOne = async (source) => {
    if (!source || source.via !== "stack" || !source.stack?.length) return source;
    const key = source.stack.join("\n");
    if (!cache.has(key)) cache.set(key, await upgradeSource(source, options));
    return cache.get(key);
  };

  const visit = async (list) => {
    for (const node of list ?? []) {
      if (node?.source) node.source = await upgradeOne(node.source);
      if (node?.children?.length) await visit(node.children);
    }
  };
  await visit(nodes);
  return nodes;
};
