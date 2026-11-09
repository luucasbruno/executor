/** Images that app tools return reach MCP clients as image content, from execute and call alike. */
import { createServer } from "node:http";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { mcpSdkVersion, withApps } from "../support/apps-release.ts";

/** A one-pixel PNG for the upstream MCP server, and another for the app's own tool. */
const upstreamPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQWPX/PwAFgALJpImt0wAAAABJRU5ErkJggg==";
const authoredPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const Rpc = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
});

/** A synthetic upstream MCP server whose `screenshot` tool returns text and an image. */
const upstream = Effect.gen(function* () {
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rpc = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rpc)));
    if (rpc.id === undefined) return HttpServerResponse.empty({ status: 202 });
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "synthetic-images", version: "1" },
          }
        : rpc.method === "tools/list"
          ? {
              tools: [
                {
                  name: "screenshot",
                  description: "Capture a synthetic screen",
                  inputSchema: { type: "object", properties: {} },
                  annotations: { readOnlyHint: true },
                },
              ],
            }
          : rpc.method === "tools/call"
            ? {
                content: [
                  { type: "text", text: "Screen captured" },
                  { type: "image", mimeType: "image/png", data: upstreamPng },
                ],
              }
            : {};
    return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: rpc.id, result });
  }).pipe(Effect.orDie);
  const services = yield* Layer.build(
    HttpRouter.serve(HttpRouter.add("POST", "/mcp", handler), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address))
    return yield* Effect.die("The MCP fixture requires a TCP listener");
  return `http://127.0.0.1:${server.address.port}/mcp`;
});

/** An app that wraps the upstream server with mcpRouter beside a tool of its own. */
const source = (url: string) => `import { defineApp, query, object, router } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({}, async () => ({ tools: router({
  remote: await mcpRouter({ url: ${JSON.stringify(url)} }),
  photo: query({ input: object({}), description: "Return a photo" },
    async () => ({ content: [{ type: "image", mimeType: "image/png", data: ${JSON.stringify(authoredPng)} }] })),
}) }));`;

const Content = Schema.Array(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
    Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
  ]),
);
const Placeholder = Schema.Struct({
  type: Schema.Literal("image"),
  mimeType: Schema.Literal("image/png"),
  imageIndex: Schema.Number,
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});

layer(HostedLive, { excludeTestServices: true })("MCP images", (it) => {
  it.effect(scenarios.mcpImages.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "MCP images",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `MCP images ${randomUUID().slice(0, 8)}`,
          files: [
            { path: "index.ts", content: source(yield* upstream) },
            {
              path: "package.json",
              content: JSON.stringify({
                dependencies: withApps({ "@modelcontextprotocol/sdk": mcpSdkVersion }),
              }),
            },
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "images", {
          organization: actors.organization.id,
        });
        const remote = `tools[${JSON.stringify(app.slug)}].remote.screenshot`;
        const photo = `tools[${JSON.stringify(app.slug)}].photo`;

        /** Call one MCP tool; return its result's images and its completed value. */
        const images = (label: string, name: string, args: Record<string, unknown>) =>
          Effect.gen(function* () {
            const result = yield* client.use(label, (client, signal) =>
              client.callTool({ name, arguments: args }, undefined, { signal }),
            );
            yield* evidence.json(
              `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.json`,
              result,
            );
            expect(result.isError).not.toBe(true);
            const content = Schema.decodeUnknownSync(Content)(result.content);
            const text = content.flatMap((block) => (block.type === "text" ? [block.text] : []));
            // The JSON text and structured content name each image without its bytes.
            expect(text).toHaveLength(1);
            for (const data of [upstreamPng, authoredPng]) {
              expect(text[0]).not.toContain(data);
              expect(JSON.stringify(result.structuredContent)).not.toContain(data);
            }
            expect(result.structuredContent).not.toHaveProperty("images");
            const completed = Schema.decodeUnknownSync(Completed)(result.structuredContent);
            expect(JSON.parse(text[0] ?? "")).toEqual(result.structuredContent);
            return {
              images: content.flatMap((block) => (block.type === "image" ? [block] : [])),
              value: completed.execution.value,
            };
          });
        const upstreamImage = { type: "image", mimeType: "image/png", data: upstreamPng };
        const authoredImage = { type: "image", mimeType: "image/png", data: authoredPng };

        // A top-level call to a tool that mcpRouter wraps.
        const called = yield* images("Call the wrapped screenshot tool", "call", {
          calls: { path: remote, input: {} },
        });
        expect(called.images).toEqual([upstreamImage]);
        expect(called.value).toMatchObject({
          ok: true,
          value: {
            content: [
              { type: "text", text: "Screen captured" },
              { type: "image", mimeType: "image/png", imageIndex: 0 },
            ],
          },
        });

        // Concurrent calls may return in either order; each placeholder names its own image.
        const batch = yield* images("Call both image tools", "call", {
          calls: [
            { path: remote, input: {} },
            { path: photo, input: {} },
          ],
        });
        const [screen, picture] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([
            Schema.Struct({
              value: Schema.Struct({ content: Schema.Tuple([Schema.Unknown, Placeholder]) }),
            }),
            Schema.Struct({ value: Schema.Struct({ content: Schema.Tuple([Placeholder]) }) }),
          ]),
        )(batch.value);
        expect(batch.images).toHaveLength(2);
        expect(batch.images[screen.value.content[1].imageIndex]).toEqual(upstreamImage);
        expect(batch.images[picture.value.content[0].imageIndex]).toEqual(authoredImage);

        // A program sees the placeholders and returns what it chooses; the images still arrive.
        const executed = yield* images("Execute a program over both image tools", "execute", {
          code: `const screen = await ${remote}({});
const picture = await ${photo}({});
return { caption: screen.content[0].text, photo: picture.content[0] };`,
        });
        expect(executed.images).toEqual([upstreamImage, authoredImage]);
        expect(executed.value).toEqual({
          caption: "Screen captured",
          photo: { type: "image", mimeType: "image/png", imageIndex: 1 },
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
