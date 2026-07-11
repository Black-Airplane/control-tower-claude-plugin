import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg']);
export const BRIDGE_PUBLIC_KEY_INPUT = '_control_tower_bridge_public_key';
export const BRIDGE_ENCRYPTION = 'rsa-oaep-sha1';
const BRIDGE_KEY_MAX_AGE_MS = 5 * 60 * 1000;

function bridgeDataDirectory(dataDirectory) {
  return dataDirectory || process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'control-tower-claude-plugin');
}

function bridgeKeyPath(input, dataDirectory) {
  const toolUseId = String(input.tool_use_id ?? '');
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(toolUseId)) {
    throw new Error('Claude Code did not provide a valid tool-use id for the image bridge.');
  }

  return path.join(bridgeDataDirectory(dataDirectory), 'bridge-keys', `${toolUseId}.pem`);
}

function removeBridgeKey(input, dataDirectory) {
  try {
    fs.rmSync(bridgeKeyPath(input, dataDirectory), { force: true });
  } catch {
    // Cleanup must never hide the attachment result.
  }
}

export function cleanupImageBridge(input, dataDirectory) {
  removeBridgeKey(input, dataDirectory);
}

function pruneBridgeKeys(directory) {
  const cutoff = Date.now() - BRIDGE_KEY_MAX_AGE_MS;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.pem')) continue;
    const filename = path.join(directory, entry.name);
    try {
      if (fs.statSync(filename).mtimeMs < cutoff) fs.rmSync(filename, { force: true });
    } catch {
      // A concurrent hook may have consumed the key already.
    }
  }
}

export function prepareImageBridge(input, dataDirectory) {
  const filename = bridgeKeyPath(input, dataDirectory);
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  pruneBridgeKeys(directory);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fs.rmSync(filename, { force: true });
  fs.writeFileSync(filename, privateKey, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.chmodSync(filename, 0o600);

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Adds an ephemeral public key required to encrypt the one-time image upload token.',
      updatedInput: {
        ...input.tool_input,
        [BRIDGE_PUBLIC_KEY_INPUT]: publicKey,
      },
    },
  };
}

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
  const hasToken = typeof capability?.upload_token === 'string';
  const hasEncryptedToken = typeof capability?.encrypted_upload_token === 'string';
  if (!capability || typeof capability.upload_url !== 'string' || (!hasToken && !hasEncryptedToken)) {
    throw new Error('Control Tower did not provide an encrypted image upload capability. Update the MCP server and plugin, then retry.');
  }

  const url = new URL(capability.upload_url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Control Tower returned an insecure image upload URL.');
  }

  return { ...capability, uploadUrl: url.toString() };
}

function resolveUploadToken(capability, input, dataDirectory) {
  if (typeof capability.upload_token === 'string') return capability.upload_token;
  if (capability.encryption !== BRIDGE_ENCRYPTION) {
    throw new Error('Control Tower returned an unsupported image upload encryption method.');
  }

  const filename = bridgeKeyPath(input, dataDirectory);
  let privateKey;
  try {
    privateKey = fs.readFileSync(filename, 'utf8');
  } catch {
    throw new Error('The ephemeral image bridge key is unavailable. Retry the attachment once.');
  } finally {
    fs.rmSync(filename, { force: true });
  }

  try {
    return crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha1',
      },
      Buffer.from(capability.encrypted_upload_token, 'base64')
    ).toString('utf8');
  } catch {
    throw new Error('Control Tower returned an image upload token that this bridge could not decrypt.');
  }
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

export async function runHook(input, fetchImpl = globalThis.fetch, dataDirectory) {
  try {
    const imageId = parseImageReference(input.tool_input?.image_ref);
    const image = await findPastedImage(input.transcript_path, imageId);
    const capability = extractUploadCapability(input.tool_response);
    const uploadToken = resolveUploadToken(capability, input, dataDirectory);
    const extension = image.mimeType === 'image/png' ? 'png' : 'jpg';
    const filename = capability.filename || `screenshot-${imageId}.${extension}`;

    const form = new FormData();
    form.append('file', new Blob([image.bytes], { type: image.mimeType }), filename);

    const response = await fetchImpl(capability.uploadUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${uploadToken}`, Accept: 'application/json' },
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
  } finally {
    removeBridgeKey(input, dataDirectory);
  }
}
