/**
 * Accessibility perception, and the cross-check it makes possible.
 *
 * The defensive half is expected: when the React runtime is unreachable
 * (release build, WebView, a fully native screen, the splash), fall back
 * to what the OS exposes, with a `source` field on every node so an agent
 * knows how much to trust what it reads.
 *
 * The offensive half is the one that needs both. What React renders and
 * what the accessibility tree exposes are two different lists, and their
 * DIFFERENCE is what assistive technology cannot see. A tool with only
 * the accessibility tree cannot know what is missing from it, because it
 * only sees what is there; a tool with only the React tree does not know
 * what the OS publishes. Having both turns a checklist into an audit.
 */

const ANDROID_NODE = /<node\s([^>]*?)\/?>/g;
const ATTRIBUTE = /([a-zA-Z-]+)="([^"]*)"/g;

const decodeXml = (value) =>
  String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const parseBounds = (raw) => {
  const match = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(String(raw ?? ""));
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  return { x: left, y: top, width: right - left, height: bottom - top };
};

/**
 * uiautomator emits a flat XML document. Parsing it with a regex is
 * usually a mistake; here the grammar is machine-generated, attribute
 * values are escaped, and the alternative is an XML dependency in a
 * project whose main argument is having none.
 */
export const parseAndroidA11y = (xml) => {
  const nodes = [];
  ANDROID_NODE.lastIndex = 0;
  let match = ANDROID_NODE.exec(String(xml ?? ""));
  while (match) {
    const attributes = {};
    ATTRIBUTE.lastIndex = 0;
    let attribute = ATTRIBUTE.exec(match[1]);
    while (attribute) {
      attributes[attribute[1]] = decodeXml(attribute[2]);
      attribute = ATTRIBUTE.exec(match[1]);
    }
    const text = attributes.text ?? "";
    const label = attributes["content-desc"] ?? "";
    // A container with neither text nor description carries no
    // information an agent could act on
    if (text || label || attributes.clickable === "true") {
      nodes.push({
        source: "accessibility",
        type: (attributes.class ?? "").split(".").pop() || null,
        text: text || null,
        label: label || null,
        testID: attributes["resource-id"]?.split("/").pop() || null,
        clickable: attributes.clickable === "true",
        enabled: attributes.enabled !== "false",
        rect: parseBounds(attributes.bounds),
      });
    }
    match = ANDROID_NODE.exec(String(xml ?? ""));
  }
  return nodes;
};

/** AXe answers JSON; shapes have moved between versions, so read
 * defensively rather than assuming one */
export const parseIosA11y = (json) => {
  let parsed;
  try {
    parsed = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    return [];
  }
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const label = node.AXLabel ?? node.label ?? node.title ?? null;
    const value = node.AXValue ?? node.value ?? null;
    const frame = node.frame ?? node.AXFrame ?? null;
    if (label || value) {
      out.push({
        source: "accessibility",
        type: node.type ?? node.AXType ?? node.role ?? null,
        text: typeof value === "string" ? value : null,
        label: typeof label === "string" ? label : null,
        testID: node.identifier ?? node.AXIdentifier ?? null,
        clickable: node.enabled !== false,
        enabled: node.enabled !== false,
        rect: frame
          ? {
              x: frame.x ?? frame.X ?? 0,
              y: frame.y ?? frame.Y ?? 0,
              width: frame.width ?? frame.Width ?? 0,
              height: frame.height ?? frame.Height ?? 0,
            }
          : null,
      });
    }
    for (const child of node.children ?? node.AXChildren ?? []) visit(child);
  };
  visit(parsed);
  return out;
};

/** Depth-first flattening of the React tree into comparable entries */
export const flattenReactTree = (nodes, out = []) => {
  for (const node of nodes ?? []) {
    out.push({
      source: "react",
      type: node.type ?? null,
      text: node.text ?? null,
      label: node.label ?? null,
      testID: node.testID ?? null,
      role: node.role ?? null,
      pressable: node.pressable === true,
      sourceLocation: node.source ?? null,
    });
    if (node.children?.length) flattenReactTree(node.children, out);
  }
  return out;
};

const normalize = (value) => String(value ?? "").trim().toLowerCase();

/**
 * What React renders but the OS does not expose.
 *
 * Two findings, and they are different bugs:
 * - a pressable with no accessible name is unusable with a screen reader
 * - visible text absent from the accessibility tree is invisible to it
 */
export const crossCheck = (reactNodes, a11yNodes) => {
  const exposed = new Set();
  for (const node of a11yNodes ?? []) {
    if (node.text) exposed.add(normalize(node.text));
    if (node.label) exposed.add(normalize(node.label));
    if (node.testID) exposed.add(normalize(node.testID));
  }

  const findings = [];
  for (const node of flattenReactTree(reactNodes)) {
    const name = normalize(node.label ?? node.text);
    if (node.pressable && !node.label && !node.text) {
      findings.push({
        kind: "unnamed-control",
        detail: "A pressable element carries neither accessibilityLabel nor text: a screen reader announces nothing.",
        node,
      });
      continue;
    }
    if (!name || name.length < 2) continue;
    if (!exposed.has(name)) {
      findings.push({
        kind: node.pressable ? "control-not-exposed" : "text-not-exposed",
        detail: node.pressable
          ? "This control is rendered by React but absent from the accessibility tree: assistive technology cannot reach it."
          : "This text is rendered by React but absent from the accessibility tree.",
        node,
      });
    }
  }

  return {
    reactNodes: flattenReactTree(reactNodes).length,
    accessibilityNodes: (a11yNodes ?? []).length,
    findings,
    // Stated rather than implied: a clean report on an empty tree would
    // be a false negative, and an agent has no way to tell
    conclusive: (a11yNodes ?? []).length > 0 && flattenReactTree(reactNodes).length > 0,
  };
};

export const A11Y_TOOLS = [
  {
    name: "get_accessibility_tree",
    description:
      "Reads the accessibility tree the OS exposes, which is what assistive technology and any external automation see. Works when the React runtime cannot be reached (release build, WebView, native screen, splash). Android uses uiautomator; iOS needs AXe installed. Every node carries source:\"accessibility\" so it is never confused with a React node.",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "audit_accessibility",
    description:
      "Compares what React renders with what the OS exposes and reports the DIFFERENCE: pressables with no accessible name, and text or controls missing from the accessibility tree. A tool with only the accessibility tree cannot find what is missing from it. Returns conclusive:false rather than a clean report when either tree came back empty.",
    inputSchema: {
      type: "object",
      properties: { deviceId: { type: "string" }, target: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];
