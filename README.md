# Control Tower for Claude Code

This plugin lets Claude Code attach PNG and JPEG images pasted into a conversation directly to Control Tower tasks. It contains no credentials and does not replace the authenticated Control Tower MCP connection.

## Requirements

- Claude Code 2.1.207 or newer
- Node.js 20 or newer
- A Control Tower MCP connection named `control-tower`

## Install

```bash
claude plugin marketplace add Black-Airplane/control-tower-claude-plugin
claude plugin install control-tower@black-airplane
claude mcp add --transport http control-tower https://YOUR-CONTROL-TOWER/mcp/control-tower
```

Open `/mcp` in Claude Code, authenticate Control Tower, then run `/reload-plugins`.

Already installed? Update to the latest bridge, then reload it:

```bash
claude plugin marketplace update black-airplane
claude plugin update control-tower@black-airplane
```

Run `/reload-plugins` after the update. Existing Claude Code sessions keep using the previous plugin version until they are reloaded.

Paste an image into Claude Code and ask: “Attach Image #1 to task 47.” Images go to the task's Media & Files gallery by default. Ask to put the image “in the description” to embed it in the task body as well.

## Security

Before the MCP call, the plugin creates an ephemeral encryption keypair and adds only the public key to the tool input. Control Tower encrypts the two-minute, one-use upload token to that key. After the tool succeeds, the plugin reads only the requested `Image #N` from the current transcript, decrypts the token locally, deletes the private key, and sends the original bytes directly to Control Tower. Image bytes, private keys, and plaintext upload tokens are never logged or placed in model-visible text.
