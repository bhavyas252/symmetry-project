import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverUrl = "http://127.0.0.1";
let backend;
let mcpProcess;
let mcpClient;
let mcpUrl;
let backendRequests = [];
let processOutput = "";

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function reservePort() {
  const probe = createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

async function waitForMcpServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (mcpProcess.exitCode !== null) {
      throw new Error(`MCP server exited early. Output: ${processOutput}`);
    }
    try {
      const response = await fetch(`${mcpUrl}/mcp`);
      if (response.status === 405) return;
    } catch {
      await delay(50);
    }
  }
  throw new Error(`MCP server did not start. Output: ${processOutput}`);
}

before(async () => {
  backendRequests = [];
  backend = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    backendRequests.push({ path: request.url, body: requestBody });

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ path: request.url, body: requestBody }));
  });
  const backendPort = await listen(backend);

  const mcpPort = await reservePort();
  mcpUrl = `${serverUrl}:${mcpPort}`;
  mcpProcess = spawn(process.execPath, [resolve(serverDirectory, "dist/server.js")], {
    cwd: serverDirectory,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(mcpPort),
      SYMMETRY_API_URL: `${serverUrl}:${backendPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  mcpProcess.stdout.on("data", (chunk) => (processOutput += chunk.toString()));
  mcpProcess.stderr.on("data", (chunk) => (processOutput += chunk.toString()));
  await waitForMcpServer();

  mcpClient = new Client({ name: "symmetry-mcp-integration-test", version: "1.0.0" });
  await mcpClient.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`)));
});

after(async () => {
  if (mcpClient) await mcpClient.close();
  if (mcpProcess && mcpProcess.exitCode === null) {
    const exited = once(mcpProcess, "exit");
    mcpProcess.kill("SIGTERM");
    await Promise.race([exited, delay(5_000)]);
    if (mcpProcess.exitCode === null) mcpProcess.kill("SIGKILL");
  }
  if (backend?.listening) await close(backend);
});

test("MCP client discovers tools and calls the health check over Streamable HTTP", async () => {
  const listed = await mcpClient.listTools();
  const names = listed.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "health_check",
    "compare_articles",
    "compare_article_sections",
  ]);

  const result = await mcpClient.callTool({
    name: "health_check",
    arguments: {},
  });
  assert.equal(result.isError, undefined);
  const health = JSON.parse(result.content[0].text);
  assert.equal(health.ok, true);
  assert.equal(health.endpoint, "/mcp");
  assert.equal(health.transport, "streamable-http");
});

test("compare_articles forwards text and comparison options to Symmetry", async () => {
  const input = {
    original_article_content: "Source article text.",
    translated_article_content: "Translated article text.",
    original_language: "en",
    translated_language: "fr",
    similarity_threshold: 0.82,
    model_name: "sentence-transformers/LaBSE",
  };
  const result = await mcpClient.callTool({
    name: "compare_articles",
    arguments: input,
  });

  assert.equal(result.isError, undefined);
  const response = JSON.parse(result.content[0].text);
  assert.equal(response.path, "/symmetry/v1/articles/compare");
  assert.deepEqual(response.body, input);
  assert.deepEqual(backendRequests.at(-1), {
    path: "/symmetry/v1/articles/compare",
    body: input,
  });
});
