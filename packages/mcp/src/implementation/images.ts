/** Images that app tools return reach the MCP client as image content, not as base64 in JSON text. */
import { Effect, Layer, Option, Schema } from "effect";
import { McpSchema, McpServer, type Tool, type Toolkit } from "effect/ai";
import type { Json, JsonObject } from "@executor-js/sdk/core";
import type { McpImage } from "../contracts/execute.ts";

const isObject = (value: Json): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
// One character class, so a large image does not exhaust the regular expression's stack.
const base64 = (data: string) => data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(data);

/**
 * Move the MCP image blocks of one tool result into `images`, leaving
 * `{ type: "image", mimeType, imageIndex }` where each was. Only a bare image block and the
 * blocks of an MCP `content` array count, not images nested anywhere else in an app's data. A
 * block whose data is not base64 stays as it is.
 */
export const collectImages = (images: Array<McpImage>, value: Json): Json => {
  const collect = (block: Json): Json => {
    if (
      !isObject(block) ||
      block.type !== "image" ||
      typeof block.mimeType !== "string" ||
      !block.mimeType.startsWith("image/") ||
      typeof block.data !== "string" ||
      !base64(block.data)
    )
      return block;
    images.push({ type: "image", data: block.data, mimeType: block.mimeType });
    return { type: "image", mimeType: block.mimeType, imageIndex: images.length - 1 };
  };
  return isObject(value) && Array.isArray(value.content)
    ? { ...value, content: value.content.map(collect) }
    : collect(value);
};

const WithImages = Schema.Struct({ images: Schema.Array(McpSchema.ImageContent) });

/**
 * Register a toolkit whose execution results may carry `images`. The result's JSON text and
 * structured content keep every other field, and each image follows as its own content block.
 */
export const imageToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
) =>
  Layer.effectDiscard(
    McpServer.registerToolkit(toolkit).pipe(
      Effect.updateService(McpServer.McpServer, (registry) => ({
        ...registry,
        addTool: (options) =>
          registry.addTool({
            ...options,
            handle: (payload) =>
              options.handle(payload).pipe(
                Effect.map((result) => {
                  if (!(result instanceof McpSchema.CallToolResult) || result.isError)
                    return result;
                  const decoded = Schema.decodeUnknownOption(WithImages)(result.structuredContent);
                  if (Option.isNone(decoded)) return result;
                  const { images: _images, ...structuredContent } =
                    result.structuredContent as Record<string, unknown>;
                  return new McpSchema.CallToolResult({
                    ...result,
                    structuredContent,
                    content: [
                      { type: "text", text: JSON.stringify(structuredContent) },
                      ...decoded.value.images,
                    ],
                  });
                }),
              ),
          }),
      })),
    ),
  ).pipe(Layer.provide(McpServer.McpServer.layer));
