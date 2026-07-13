# MCP Client Configuration

The Greenscreen Studio MCP server is a local stdio server.

Run it manually from the repository root:

```bash
npm run mcp
```

Generic MCP client JSON:

```json
{
  "mcpServers": {
    "greenscreen-studio": {
      "command": "node",
      "args": ["C:/path/to/greenscreen-studio/mcp/server.mjs"],
      "cwd": "C:/path/to/greenscreen-studio"
    }
  }
}
```

Use an absolute path in `args[0]`. On Windows, forward slashes are accepted by Node and avoid JSON escaping mistakes.

Recommended client behavior:

- Set a longer request timeout for full-length video exports.
- Use small `range` values for smoke tests.
- Read `greenscreen://presets/default` after connecting to discover defaults.
- Call `get_project_info` to confirm the server is running from the expected repo.

Do not wrap `npm run mcp` as the command inside clients that do not support shell execution. Prefer `command: "node"` and `args: [".../mcp/server.mjs"]`.
