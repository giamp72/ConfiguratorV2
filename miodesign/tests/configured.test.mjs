import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const setup = source.slice(source.indexOf('const configured ='), source.indexOf('const { loadConditionRules'));
const login = source.slice(source.indexOf('function viewLogin()'), source.indexOf('// ---------- menu ----------'));

function render(url, key) {
  const app = {}, form = {};
  let clients = 0;
  const context = {
    SUPABASE_URL: url, SUPABASE_ANON_KEY: key, app,
    createClient: () => { clients++; return {}; },
    $: () => form,
  };
  vm.runInNewContext(`${setup}\n${login}\nviewLogin();`, context);
  return { html: app.innerHTML, clients };
}

test('empty configuration shows setup instructions without creating a client', () => {
  for (const [url, key] of [['', ''], ['  ', 'key'], ['https://example.supabase.co', '  '], ['https://YOUR-PROJECT.supabase.co', 'key']]) {
    const result = render(url, key);
    assert.equal(result.clients, 0);
    assert.match(result.html, /Configura SUPABASE_URL e SUPABASE_ANON_KEY/);
    assert.match(result.html, /disabled/);
  }
});

test('nonempty configuration creates a client and enables login', () => {
  const result = render('https://example.supabase.co', 'key');
  assert.equal(result.clients, 1);
  assert.doesNotMatch(result.html, /Configura SUPABASE_URL e SUPABASE_ANON_KEY|disabled/);
});
