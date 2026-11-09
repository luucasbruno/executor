---
"@executor-js/mcp": patch
"@executor-js/app-templates": patch
---

Images that app tools return, including those of a remote MCP server behind
`mcpRouter`, now reach the MCP client as image content from `execute`,
`call` and `resume`. They used to arrive only as base64 inside the JSON
text result, twice, so the model could not see them and they cost their size
in text. The program and the JSON result now see
`{ type: "image", mimeType, imageIndex }` in each image's place. The
code-mode skill states this.
