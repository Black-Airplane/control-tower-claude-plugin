---
name: task-images
description: Attach PNG or JPEG images pasted into Claude Code to Control Tower tasks through the control-tower MCP server. Use when the user asks to add, attach, upload, embed, or include an Image #N in a Control Tower task.
---

# Control Tower task images

When a user asks to attach a pasted image to a Control Tower task:

1. Resolve or create the task first. If creating it, wait for `create-task` to return the new task id.
2. Call `mcp__control-tower__attach-task-image` once per image.
3. Pass `image_ref` exactly as shown in the conversation, such as `Image #2`.
4. Use `placement: "attachment"` unless the user explicitly asks to put the image inline, in the body, or in the description; then use `placement: "description"`.
5. Supply a concise filename when useful. For description placement, supply concise accessible `alt_text` based only on what is visibly shown.
6. Do not claim the image is attached until the tool returns `status: "attached"`. If the upload fails, report the task as created/updated but the image as not attached, and retry only the image when appropriate.

Never encode the image as base64 in a tool argument, invent a local path, or replace the image with a textual description.
