#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { accessSync, constants, statSync, watchFile, unwatchFile } from "node:fs";
import { join, isAbsolute, delimiter } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

interface ParsedArgs {
  command: string;
  args: string[];
  env: Record<string, string> | undefined;
}

// ─── CLI Parsing ─────────────────────────────────────────────────────

function parseArgs(argv: string[]): ParsedArgs {
  const envPairs: [string, string][] = [];
  let passEnvironment = false;
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--pass-environment") {
      passEnvironment = true;
      i++;
    } else if (arg === "-e" || arg === "--env") {
      if (i + 2 >= argv.length) {
        process.stderr.write("Error: -e requires KEY and VALUE arguments\n");
        process.exit(1);
      }
      envPairs.push([argv[i + 1], argv[i + 2]]);
      i += 3;
    } else if (arg === "--") {
      i++;
      break;
    } else if (arg.startsWith("-")) {
      process.stderr.write(`Error: unknown option: ${arg}\n`);
      process.exit(1);
    } else {
      break;
    }
  }

  if (i >= argv.length) {
    process.stderr.write(
      "Usage: mcp-stdio-proxy [--pass-environment] [-e KEY VALUE ...] command [args ...]\n",
    );
    process.exit(1);
  }

  const command = argv[i];
  const args = argv.slice(i + 1);

  let env: Record<string, string> | undefined;
  if (passEnvironment || envPairs.length > 0) {
    env = {};
    if (passEnvironment) {
      Object.assign(env, process.env);
    }
    for (const [key, value] of envPairs) {
      env[key] = value;
    }
  }

  return { command, args, env };
}

// ─── Utility ─────────────────────────────────────────────────────────

function which(command: string): string | null {
  if (isAbsolute(command)) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, command);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      continue;
    }
  }
  return null;
}

// ─── Backend Connection ──────────────────────────────────────────────

async function connectBackend(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command,
    args,
    env,
    stderr: "inherit",
  });
  const client = new Client({ name: "mcp-stdio-proxy", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  // Connect to backend
  let { client } = await connectBackend(parsed.command, parsed.args, parsed.env);

  const capabilities = client.getServerCapabilities() ?? {};
  const serverVersion = client.getServerVersion();

  // Build server capabilities matching backend (always include tools for reload_mcp)
  const serverCaps: ServerCapabilities = { tools: {} };
  if (capabilities.prompts) serverCaps.prompts = {};
  if (capabilities.resources) serverCaps.resources = {};
  if (capabilities.logging) serverCaps.logging = {};

  const hasBackendTools = Boolean(capabilities.tools);

  // Create proxy server
  const server = new Server(
    {
      name: serverVersion?.name ?? "mcp-stdio-proxy",
      version: serverVersion?.version ?? "0.1.0",
    },
    { capabilities: serverCaps },
  );

  // ─── Request Handlers ────────────────────────────────────────────

  // Tools (always enabled for reload_mcp)
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [];
    if (hasBackendTools) {
      const result = await client.listTools();
      tools.push(...result.tools);
    }
    tools.push({
      name: "reload_mcp",
      description: "Reload the backend MCP server process",
      inputSchema: { type: "object" as const },
    });
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "reload_mcp") {
      try {
        await client.close();
        const result = await connectBackend(parsed.command, parsed.args, parsed.env);
        client = result.client;

        const newCaps = client.getServerCapabilities() ?? {};
        if (newCaps.tools) await server.sendToolListChanged();
        if (newCaps.prompts) await server.sendPromptListChanged();
        if (newCaps.resources) await server.sendResourceListChanged();

        return { content: [{ type: "text" as const, text: "Reloaded successfully" }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: String(err) }],
          isError: true,
        };
      }
    }

    try {
      return await client.callTool({
        name: request.params.name,
        arguments: request.params.arguments,
      });
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: String(err) }],
        isError: true,
      };
    }
  });

  // Prompts
  if (capabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return await client.listPrompts();
    });
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return await client.getPrompt(request.params);
    });
  }

  // Resources
  if (capabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return await client.listResources();
    });
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      return await client.listResourceTemplates();
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return await client.readResource(request.params);
    });
    server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      await client.subscribeResource(request.params);
      return {};
    });
    server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      await client.unsubscribeResource(request.params);
      return {};
    });
  }

  // Logging
  if (capabilities.logging) {
    server.setRequestHandler(SetLevelRequestSchema, async (request) => {
      await client.setLoggingLevel(request.params.level);
      return {};
    });
  }

  // Completions
  server.setRequestHandler(CompleteRequestSchema, async (request) => {
    return await client.complete(request.params);
  });

  // ─── Connect Server to Stdio ─────────────────────────────────────

  const serverTransport = new StdioServerTransport();
  await server.connect(serverTransport);

  // ─── Binary Watching ─────────────────────────────────────────────

  const binaryPath = which(parsed.command) ?? parsed.command;
  let watchEnabled = false;
  try {
    statSync(binaryPath);
    watchEnabled = true;
  } catch {
    process.stderr.write(
      `Warning: cannot stat ${binaryPath} — binary watching disabled\n`,
    );
  }

  if (watchEnabled) {
    watchFile(binaryPath, { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        const notify = async () => {
          if (capabilities.tools) await server.sendToolListChanged();
          if (capabilities.prompts) await server.sendPromptListChanged();
          if (capabilities.resources) await server.sendResourceListChanged();
        };
        notify().catch((err) => {
          process.stderr.write(`Failed to send notifications: ${err}\n`);
        });
      }
    });
  }

  // ─── Cleanup ─────────────────────────────────────────────────────

  const cleanup = async (): Promise<void> => {
    if (watchEnabled) unwatchFile(binaryPath);
    await client.close();
    await server.close();
  };

  server.onclose = async () => {
    if (watchEnabled) unwatchFile(binaryPath);
    await client.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void cleanup().then(() => process.exit(0)));
  process.on("SIGTERM", () => void cleanup().then(() => process.exit(0)));
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
