import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BRIDGE_ENCRYPTION,
  BRIDGE_PUBLIC_KEY_INPUT,
  cleanupImageBridge,
  extractUploadCapability,
  findPastedImage,
  mcpResult,
  parseImageReference,
  prepareImageBridge,
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

test('extracts upload secrets from MCP content metadata and rejects insecure URLs', () => {
  const capability = extractUploadCapability([
    {
      type: 'text',
      text: JSON.stringify({ status: 'upload_pending' }),
      _meta: {
        'control-tower/task-image-upload': {
          upload_url: 'https://control.example/mcp/task-image-uploads/7',
          upload_token: 'secret',
        },
      },
    },
  ]);
  assert.equal(capability.upload_token, 'secret');

  assert.throws(() => extractUploadCapability({
    _meta: { 'control-tower/task-image-upload': {
      upload_url: 'http://control.example/upload', upload_token: 'secret',
    } },
  }), /insecure/);
});

test('prepares an ephemeral bridge key without changing the model-provided fields', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'control-tower-bridge-'));
  const output = prepareImageBridge({
    tool_use_id: 'toolu_prepare_1',
    tool_input: { task_id: 47, image_ref: 'Image #4', placement: 'attachment' },
  }, directory);

  const hook = output.hookSpecificOutput;
  assert.equal(hook.hookEventName, 'PreToolUse');
  assert.equal(hook.permissionDecision, 'allow');
  assert.equal(hook.updatedInput.task_id, 47);
  assert.equal(hook.updatedInput.image_ref, 'Image #4');
  assert.match(hook.updatedInput[BRIDGE_PUBLIC_KEY_INPUT], /BEGIN PUBLIC KEY/);

  const keyFile = path.join(directory, 'bridge-keys', 'toolu_prepare_1.pem');
  assert.match(await fs.readFile(keyFile, 'utf8'), /BEGIN PRIVATE KEY/);
  assert.equal((await fs.stat(keyFile)).mode & 0o777, 0o600);

  cleanupImageBridge({ tool_use_id: 'toolu_prepare_1' }, directory);
  await assert.rejects(() => fs.readFile(keyFile));
});

test('uploads the original bytes and replaces the MCP result', async () => {
  const file = await transcript([imageRecord([4], [{ mimeType: 'image/png', bytes: PNG }])]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'control-tower-bridge-'));
  const toolInput = { image_ref: 'Image #4' };
  const prepared = prepareImageBridge({
    tool_use_id: 'toolu_upload_1',
    tool_input: toolInput,
  }, directory);
  const publicKey = prepared.hookSpecificOutput.updatedInput[BRIDGE_PUBLIC_KEY_INPUT];
  const encryptedToken = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha1',
    },
    Buffer.from('secret')
  ).toString('base64');
  let request;
  const fakeFetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ status: 'attached', task_id: 47 }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const output = await runHook({
    tool_use_id: 'toolu_upload_1',
    transcript_path: file,
    tool_input: toolInput,
    tool_response: JSON.stringify({
      status: 'upload_pending',
      'control-tower/task-image-upload': {
        upload_url: 'https://control.example/mcp/task-image-uploads/7',
        encrypted_upload_token: encryptedToken,
        encryption: BRIDGE_ENCRYPTION,
        filename: 'bug.png',
      },
    }),
  }, fakeFetch, directory);

  assert.equal(request.url, 'https://control.example/mcp/task-image-uploads/7');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  const content = output.hookSpecificOutput.updatedMCPToolOutput;
  assert.ok(Array.isArray(content));
  assert.equal(JSON.parse(content[0].text).status, 'attached');
  await assert.rejects(() => fs.readFile(path.join(directory, 'bridge-keys', 'toolu_upload_1.pem')));
});

test('deletes the ephemeral key when an encrypted capability cannot be decrypted', async () => {
  const file = await transcript([imageRecord([5], [{ mimeType: 'image/png', bytes: PNG }])]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'control-tower-bridge-'));
  prepareImageBridge({
    tool_use_id: 'toolu_bad_token_1',
    tool_input: { image_ref: 'Image #5' },
  }, directory);

  await assert.rejects(() => runHook({
    tool_use_id: 'toolu_bad_token_1',
    transcript_path: file,
    tool_input: { image_ref: 'Image #5' },
    tool_response: JSON.stringify({
      'control-tower/task-image-upload': {
        upload_url: 'https://control.example/mcp/task-image-uploads/8',
        encrypted_upload_token: 'not-valid-ciphertext',
        encryption: BRIDGE_ENCRYPTION,
      },
    }),
  }, undefined, directory), /could not decrypt/);

  await assert.rejects(() => fs.readFile(path.join(directory, 'bridge-keys', 'toolu_bad_token_1.pem')));
});

test('returns the MCP content-block array expected by Claude Code', () => {
  const output = mcpResult({ status: 'attachment_failed', message: 'Try again.' });
  const content = output.hookSpecificOutput.updatedMCPToolOutput;

  assert.deepEqual(content, [
    {
      type: 'text',
      text: JSON.stringify({ status: 'attachment_failed', message: 'Try again.' }),
    },
  ]);
  assert.equal(
    content.reduce((length, block) => length + (block.type === 'text' ? block.text.length : 0), 0),
    content[0].text.length
  );
});

test('fails clearly for missing and spoofed images', async () => {
  const missing = await transcript([]);
  await assert.rejects(() => findPastedImage(missing, 9), /not available/);

  const spoofed = await transcript([imageRecord([1], [{ mimeType: 'image/png', bytes: JPEG }])]);
  await assert.rejects(() => findPastedImage(spoofed, 1), /does not match/);
});
