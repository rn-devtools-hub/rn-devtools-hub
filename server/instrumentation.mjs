/**
 * "Nothing observed" is not "nothing observable".
 *
 * An empty list is the most expensive answer this hub can give. A tool
 * that returns `[]` because the app made no request and a tool that
 * returns `[]` because nothing was ever wrapped are indistinguishable
 * from outside the runtime, and the second one sends an agent
 * investigating a problem that does not exist. The SDK answers
 * `context.instrumentation` with what it actually attached; this module
 * turns that into a sentence attached to the empty answer.
 *
 * Older SDKs do not know the command. Saying "the app cannot tell me" is
 * still an answer, and it is not the same as "nothing is attached".
 */

/** Asks the device what it attached, degrading on an older SDK */
export const readInstrumentation = async (sendCommand) => {
  let response;
  try {
    response = await sendCommand("context.instrumentation", {});
  } catch (error) {
    return { report: null, supported: null, error: String(error?.message ?? error) };
  }
  if (!response?.error) return { report: response?.result ?? null, supported: true };
  if (/unknown command/i.test(String(response.error))) {
    return { report: null, supported: false };
  }
  return { report: null, supported: null, error: String(response.error) };
};

const UNSUPPORTED =
  "This app runs an SDK older than the instrumentation report, so the hub cannot tell " +
  "an app that sent nothing from an app whose client was never wrapped. Upgrade " +
  "rn-devtools-hub in the app to get that distinction.";

const unavailable = (state) => {
  if (state.supported === false) return { instrumented: null, note: UNSUPPORTED };
  if (state.report === null) {
    return {
      instrumented: null,
      note: `The device did not answer the instrumentation query (${state.error ?? "no result"}), so this empty answer is unexplained.`,
    };
  }
  return null;
};

/**
 * Why the network history is empty. Three different facts hide behind the
 * same empty array, and only one of them means the app is quiet.
 */
export const explainEmptyNetwork = (state) => {
  const blocked = unavailable(state);
  if (blocked) return blocked;

  const wraps = Array.isArray(state.report.network?.wraps) ? state.report.network.wraps : [];
  const active = wraps.filter((wrap) => wrap.active);

  if (!wraps.length) {
    return {
      instrumented: false,
      wrappedClients: [],
      note:
        "Nothing is watching the network: this app never called devtools.wrapFetch or " +
        'devtools.attachAxios, so an empty list means "not observed", not "no request". ' +
        'Instrument the client (const api = devtools.wrapFetch(fetch, "api")), reload, ' +
        "then call again before concluding anything.",
    };
  }

  if (!active.length) {
    const labels = wraps.map((wrap) => `${wrap.kind}:${wrap.label}`).join(", ");
    return {
      instrumented: false,
      wrappedClients: [],
      note:
        `${labels} ran BEFORE devtools.init(), so the SDK returned the client unchanged and ` +
        "nothing is instrumented. This is the usual trap: a module-scope wrapFetch in a file " +
        "imported before the devtools setup. Wrap after init(), or wrap lazily inside the " +
        "function that fires the request.",
    };
  }

  return {
    instrumented: true,
    wrappedClients: active.map((wrap) => `${wrap.kind}:${wrap.label}`),
    note:
      `${active.length} instrumented client(s) (${active
        .map((wrap) => wrap.label)
        .join(", ")}) and no traffic captured: the app really sent nothing over this window. ` +
      "A request going through another client (a raw fetch, an axios instance that was never " +
      "attached, a native SDK) is invisible here.",
  };
};

/** What each optional attachment unlocks, and the call that enables it */
const ATTACHMENTS = {
  stores: {
    field: "stores",
    enable: "devtools.registerStore(name, adapter)",
    unlocks: "get_state and set_state",
  },
  actions: {
    field: "actions",
    enable: "devtools.registerAction(definition, handler)",
    unlocks: "list_actions and run_action",
  },
  previews: {
    field: "previews",
    enable: "devtools.registerPreview(name, factory)",
    unlocks: "list_previews and render_component",
  },
};

/**
 * Why a registry is empty: nothing registered, or an app that cannot say.
 * Same rule as the network, applied to the optional attachments.
 */
export const explainEmptyRegistry = (state, kind) => {
  const attachment = ATTACHMENTS[kind];
  if (!attachment) return null;
  const blocked = unavailable(state);
  if (blocked) return blocked.note;

  const registered = state.report[attachment.field];
  if (Array.isArray(registered) && registered.length) return null;
  return (
    `This app registered nothing with ${attachment.enable}, which is what ${attachment.unlocks} ` +
    "read. The list is empty because nothing was declared, not because the app has no state to expose."
  );
};

const capability = (available, enable, tools, details = {}) => ({
  available,
  tools,
  ...(available ? {} : { enable }),
  ...details,
});

/** Turns the runtime attachment report into an agent-readable capability map. */
export const describeCapabilities = (state) => {
  if (state.report === null) {
    return {
      supported: state.supported,
      note: state.supported === false ? UNSUPPORTED : `Capabilities unavailable (${state.error ?? "no result"}).`,
      capabilities: {},
    };
  }
  const report = state.report;
  const stores = Array.isArray(report.stores) ? report.stores : [];
  const actions = Array.isArray(report.actions) ? report.actions : [];
  const previews = Array.isArray(report.previews) ? report.previews : [];
  return {
    supported: true,
    capabilities: {
      perception: capability(report.uiAutomation === true, "devtools.attachUiAutomation()", ["get_ui_tree", "query_ui", "ui_act", "assert"]),
      console: capability(report.console === true, "devtools.attachConsole()", ["get_logs"]),
      network: capability(report.network?.instrumented === true, 'devtools.wrapFetch(fetch, "api") or devtools.attachAxios(api, "api")', ["get_recent_network", "get_endpoint_stats"], { wraps: report.network?.wraps ?? [] }),
      determinism: capability(report.determinism === true, "devtools.attachDeterminism()", ["freeze_time", "advance_time", "restore_time", "mock_network"]),
      stores: capability(stores.length > 0, "devtools.registerStore(name, adapter)", ["get_state", "set_state"], { registered: stores }),
      actions: capability(actions.length > 0, "devtools.registerAction(definition, handler)", ["list_actions", "run_action"], { registered: actions }),
      previews: capability(previews.length > 0, "devtools.registerPreview(name, factory)", ["list_previews", "render_component", "unmount_component"], { registered: previews }),
      originTracking: capability(report.originTracking === true, "devtools.attachOriginTracking()", ["get_recent_network"]),
    },
  };
};
