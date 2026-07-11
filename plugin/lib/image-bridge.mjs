import fs from 'node:fs';
import readline from 'node:readline';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg']);

export function parseImageReference(imageRef) {
  const match = /^\s*Image\s+#(\d+)\s*$/i.exec(String(imageRef ?? ''));
  if (!match) {
    throw new Error('Use the exact pasted-image reference, for example "Image #2".');
  }

  return Number(match[1]);
}

export async function findPastedImage(transcriptPath, imageId) {
  const input = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let found = null;

  for await (const line of lines) {
    if (!line.includes('imagePasteIds')) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (!Array.isArray(record.imagePasteIds) || !Array.isArray(record.message?.content)) continue;

    const images = record.message.content.filter((block) => block?.type === 'image');
    for (let index = 0; index < record.imagePasteIds.length; index += 1) {
      if (Number(record.imagePasteIds[index]) !== imageId) continue;

      const source = images[index]?.source;
      if (source?.type === 'base64' && typeof source.data === 'string') {
        found = { mimeType: source.media_type, data: source.data };
      }
    }
  }

  if (!found) throw new Error(`Image #${imageId} is not available in this Claude Code session.`);
  if (!ALLOWED_MIME_TYPES.has(found.mimeType)) {
    throw new Error('Control Tower task image uploads support PNG and JPEG only.');
  }

  const bytes = Buffer.from(found.data, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('The pasted image is empty or exceeds the 10 MiB limit.');
  }
  validateSignature(bytes, found.mimeType);

  return { mimeType: found.mimeType, bytes };
}

function validateSignature(bytes, mimeType) {
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((mimeType === 'image/png' && !png) || (mimeType === 'image/jpeg' && !jpeg)) {
    throw new Error('The pasted image data does not match its declared format.');
  }
}

export function extractUploadCapability(toolResponse) {
  const seen = new Set();

  function visit(value, depth = 0) {
    if (depth > 10 || value == null) return null;
    if (typeof value === 'string') {
      if (!value.trim().startsWith('{')) return null;
      try {
        return visit(JSON.parse(value), depth + 1);
      } catch {
        return null;
      }
    }
    if (typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);

    const direct = value['control-tower/task-image-upload'];
    if (direct && typeof direct === 'object') return direct;

    for (const child of Object.values(value)) {
      const result = visit(child, depth + 1);
      if (result) return result;
    }
    return null;
  }

  const capability = visit(toolResponse);
  if (!capability || typeof capability.upload_url !== 'string' || typeof capability.upload_token !== 'string') {
    throw new Error('Control Tower did not return an image upload capability. Update the MCP server and plugin, then retry.');
  }

  const url = new URL(capability.upload_url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Control Tower returned an insecure image upload URL.');
  }

  return { ...capability, uploadUrl: url.toString() };
}

export function mcpResult(result) {
  const content = [{ type: 'text', text: JSON.stringify(result) }];

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      // Claude Code stores an MCP tool's output as the content-block array itself.
      // Returning a CallToolResult wrapper here causes Claude Code 2.1.207 to call
      // Array#reduce on an object while rendering the replacement.
      updatedMCPToolOutput: content,
    },
  };
}

export async function runHook(input, fetchImpl = globalThis.fetch) {
  const imageId = parseImageReference(input.tool_input?.image_ref);
  const image = await findPastedImage(input.transcript_path, imageId);
  const capability = extractUploadCapability(input.tool_response);
  const extension = image.mimeType === 'image/png' ? 'png' : 'jpg';
  const filename = capability.filename || `screenshot-${imageId}.${extension}`;

  const form = new FormData();
  form.append('file', new Blob([image.bytes], { type: image.mimeType }), filename);

  const response = await fetchImpl(capability.uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${capability.upload_token}`, Accept: 'application/json' },
    body: form,
  });
  const text = await response.text();

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = { message: response.ok ? 'Control Tower returned an invalid upload response.' : 'Control Tower rejected the image upload.' };
  }

  if (!response.ok) {
    throw new Error(typeof result.message === 'string' ? result.message : `Control Tower image upload failed (${response.status}).`);
  }

  return mcpResult(result);
}
