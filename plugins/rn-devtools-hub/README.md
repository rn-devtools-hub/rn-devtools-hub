# rn-devtools-hub, Claude Code plugin

Installs the skill that teaches an agent to chain the hub's MCP tools, and
registers the local MCP server.

## Install

```
/plugin marketplace add rn-devtools-hub/rn-devtools-hub
/plugin install rn-devtools-hub
```

## Before it can do anything

The MCP server is the hub, and the hub runs per project. Start it at the
root of the app you are working on:

```
npx rn-devtools-hub
```

It listens on `http://127.0.0.1:8973/mcp`, which is what this plugin
registers. On another port, add the server by hand instead:

```
claude mcp add rn-devtools --transport http http://127.0.0.1:8974/mcp
```

The app itself needs the SDK wired in, which `npx rn-devtools-hub init`
does, plus `devtools.attachUiAutomation()` in the glue file for the
perception and action tools.

## What the skill changes

Without it, an agent has 55 tools and no idea how to sequence them. With
it, it knows to call `get_project_context` before debugging anything that
looks impossible, to prove results with `assert` instead of screenshots,
to wait on events instead of sleeping, and to read the `source` field
instead of grepping the repository.
