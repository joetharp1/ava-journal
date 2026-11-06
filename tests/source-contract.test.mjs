import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FILE_PREFIX } from '../core.mjs';
const root = process.env.ST_SOURCE;
const read = file => readFileSync(path.join(root, file), 'utf8');
test('ST 1.19 source supports dry-run normal-context assembly and quiet tool suppression', { skip: !root }, () => {
    const script = read('public/script.js'), tools = read('public/scripts/tool-calling.js');
    assert.match(script, /export async function Generate\(type,.*dryRun = false/s);
    assert.match(script, /getWorldInfoPrompt\(chatForWI, this_max_context, dryRun/);
    assert.match(script, /eventSource.emit\(event_types.GENERATE_AFTER_DATA, generate_data, dryRun\);\s+if \(dryRun\) \{\s+return Promise.resolve/);
    assert.match(tools, /noToolCallTypes = \['impersonate', 'quiet', 'continue'\]/);
});
test('ST file upload, verification and disabled Data Bank registrations match adapters', { skip: !root }, () => {
    const files = read('src/endpoints/files.js'), chats = read('public/scripts/chats.js'), cleanup = read('src/endpoints/data-maid.js');
    assert.match(files, /router.post\('\/upload'/); assert.match(files, /router.post\('\/verify'/);
    assert.match(files, /path.join\(request.user.directories.files, request.body.name\)/);
    assert.match(files, /writeFileSyncAtomic\(pathToUpload, request.body.data, 'base64'\)/);
    assert.match(files, /return response.send\(\{ path: url \}\)/);
    assert.match(files, /verified\[url\] = fileExists/);
    assert.match(read('src/users.js'), /router.use\('\/user\/files\/\*', createRouteHandler\(req => req.user.directories.files\)\)/);
    assert.match(chats, /disabled_attachments.includes/); assert.match(cleanup, /settings.extension_settings.character_attachments/);
    const cleanupFileSection = cleanup.slice(cleanup.indexOf('settings.extension_settings.character_attachments'), cleanup.indexOf('settings.extension_settings.character_attachments') + 850);
    assert.ok(!cleanupFileSection.includes('disabled_attachments'));
});
test('native directory template and URL helper produce the adapter prefix, including leading slash', { skip: !root }, async () => {
    const { USER_DIRECTORY_TEMPLATE: dirs } = await import(pathToFileURL(path.join(root, 'src/constants.js')));
    const helper = read('src/util.js').match(/export (function clientRelativePath\(root, inputPath\) \{[\s\S]*?\n\})/);
    assert.ok(helper, 'native URL helper found');
    const clientRelativePath = new Function('path', `return ${helper[1]}`)(path);
    const userRoot = path.join('/data', 'test-user', dirs.root);
    const name = 'ava-log-2026-11-06.md';
    assert.equal(clientRelativePath(userRoot, path.join(userRoot, dirs.files, name)), `${FILE_PREFIX}${name}`);
});
test('native request parameter builder and successful settings-save receipt are exported', { skip: !root }, () => {
    assert.match(read('public/scripts/openai.js'), /export async function createGenerationParameters/);
    assert.match(read('public/scripts/openai.js'), /export function getChatCompletionModel\(settings = null\)/);
    assert.match(read('public/scripts/chats.js'), /export function hasPendingFileAttachment\(\)/);
    const script = read('public/script.js'); assert.match(script, /export function setSendButtonState/); assert.match(script, /export async function saveSettings/); assert.match(script, /await eventSource.emit\(event_types.SETTINGS_UPDATED\)/);
});
test('ST exports the same per-message tokenizer used by its Chat Completion Message class', { skip: !root }, () => {
    const tokenizer = read('public/scripts/tokenizers.js'), openai = read('public/scripts/openai.js');
    assert.match(tokenizer, /export async function countTokensOpenAIAsync\(messages, full = false\)/);
    assert.match(tokenizer, /if \(!Array.isArray\(messages\)\) \{\s+messages = \[messages\]/);
    assert.match(openai, /new TokenHandler\(countTokensOpenAIAsync\)/);
    assert.match(openai, /tokenHandler.countAsync\(\{ role: message.role, content: message.content \}\)/);
});
