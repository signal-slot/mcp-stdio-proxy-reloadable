# mcp-stdio-proxy-reloadable

A stdio-to-stdio MCP proxy with binary file watching and hot reload support.

Spawns a child MCP server process, proxies all stdio messages, and monitors the command binary for changes. When the binary is rebuilt, the proxy sends `tools/list_changed` (and other list-changed notifications) so the LLM re-fetches capabilities without restarting the session.

## Features

- **Stdio-to-stdio proxying** — all MCP capabilities (tools, prompts, resources, logging, completions) are forwarded transparently
- **Binary file watching** — polls the command binary's mtime every second; sends list-changed notifications on change
- **`reload_mcp` tool** — explicitly restart the backend process and send notifications
- **Environment passthrough** — optionally pass all or specific environment variables to the backend

## Installation

```bash
npm install -g mcp-stdio-proxy-reloadable
```

## Usage

```
usage: mcp-stdio-proxy [--pass-environment] [-e KEY VALUE ...] command [args ...]
```

### Examples

```bash
# Run via npx
npx mcp-stdio-proxy-reloadable --pass-environment /path/to/your-mcp-server

# With environment variables
npx mcp-stdio-proxy-reloadable -e DISPLAY :0 /path/to/your-mcp-server

# Register with Claude Code
claude mcp add --transport stdio my-server -- \
  npx mcp-stdio-proxy-reloadable \
  --pass-environment /path/to/your-mcp-server
```

## How it works

```
Client (Claude Code)
  │ stdio
  ▼
mcp-stdio-proxy-reloadable
  │ stdio
  ▼
Backend MCP server (child process)
```

1. The proxy spawns the backend command as a child process and initializes the MCP session
2. A proxy MCP server is created that forwards all requests to the backend
3. The binary file is polled for mtime changes — on change, list-changed notifications are sent to the client
4. When the LLM calls `reload_mcp`, the backend process is restarted and notifications are sent

## License

LGPL-3.0-only OR GPL-2.0-only OR GPL-3.0-only
