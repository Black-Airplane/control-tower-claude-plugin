import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  extractUploadCapability,
  findPastedImage,
  parseImageReference,
  runHook,
} from '../plugin/lib/image-bridge.mjs';

const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a46494600', 'hex');

async function transcript(records) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'control-tower-plugin-'));
  const file = path.join(directory, 'session.jsonl');
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join('\n'));
  return file;
}

function imageRecord(ids, images) {
  return {
    type: 'user',
    imagePasteIds: ids,
    message: {
      role: 'user',
      content: images.map(({ mimeType, bytes }) => ({
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: bytes.toString('base64') },
      })),
    },
  };
}

test('parses exact Claude Code image references', () => {
  assert.equal(parseImageReference('Image #12'), 12);
  assert.throws(() => parseImageReference('/tmp/image.png'), /exact pasted-image reference/);
});

test('resolves the requested image id across turns and formats', async () => {
  const file = await transcript([
    imageRecord([1], [{ mimeType: 'image/png', bytes: PNG }]),
    { type: 'assistant', message: { content: [] } },
    imageRecord([2, 3], [
      { mimeType: 'image/jpeg', bytes: JPEG },
      { mimeType: 'image/png', bytes: PNG },
    ]),
  ]);

  const image = await findPastedImage(file, 2);
  assert.equal(image.mimeType, 'image/jpeg');
  assert.deepEqual(image.bytes, JPEG);
});

test('extracts upload secrets from nested MCP metadata and rejects insecure URLs', () => {
  const capability = extractUploadCapability({
    mcpMeta: { _meta: { 'control-tower/task-image-upload': {
      upload_url: 'https://control.example/mcp/task-image-uploads/7',
      upload_token: 'secret',
    } } },
  });
  assert.equal(capability.upload_token, 'secret');

  assert.throws(() => extractUploadCapability({
    _meta: { 'control-tower/task-image-upload': {
      upload_url: 'http://control.example/upload', upload_token: 'secret',
    } },
  }), /insecure/);
});

test('uploads the original bytes and replaces the MCP result', async () => {
  const file = await transcript([imageRecord([4], [{ mimeType: 'image/png', bytes: PNG }])]);
  let request;
  const fakeFetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ status: 'attached', task_id: 47 }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const output = await runHook({
    transcript_path: file,
    tool_input: { image_ref: 'Image #4' },
    tool_response: { mcpMeta: { _meta: { 'control-tower/task-image-upload': {
      upload_url: 'https://control.example/mcp/task-image-uploads/7',
      upload_token: 'secret',
      filename: 'bug.png',
    } } } },
  }, fakeFetch);

  assert.equal(request.url, 'https://control.example/mcp/task-image-uploads/7');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.equal(output.hookSpecificOutput.updatedMCPToolOutput.structuredContent.status, 'attached');
});

test('fails clearly for missing and spoofed images', async () => {
  const missing = await transcript([]);
  await assert.rejects(() => findPastedImage(missing, 9), /not available/);

  const spoofed = await transcript([imageRecord([1], [{ mimeType: 'image/png', bytes: JPEG }])]);
  await assert.rejects(() => findPastedImage(spoofed, 1), /does not match/);
});
