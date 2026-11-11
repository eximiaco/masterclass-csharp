// Suite de integração dos wrappers de segredos (unit mcp-runtime-secrets-wrappers, SPEC §6/§8).
// Driver no host; os comandos exercitam o binário Rust compondo os binários
// NATIVOS sops/age (sem mocks): secrets init/edit e keys add/remove com
// reencapsulação real via `sops updatekeys`. Segredos dummy só no CONTEÚDO.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { findSecretsTools } from '../helpers.mjs';

const ART_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = process.env.MCP_RUNTIME_BIN;
if (!BIN) {
  throw new Error('MCP_RUNTIME_BIN não definido; o runner deve construir o binário Rust e injetar o caminho');
}

const CTX = `teste-secrets-${randomBytes(3).toString('hex')}`;
const CTX2 = `${CTX}-b`;
let pub1 = '';
const CONFIG_ROOT = mkdtempSync(join(tmpdir(), 'mcp-secrets-wrappers-'));
const ENV = { ...process.env, MCP_RUNTIME_CONFIG_DIR: CONFIG_ROOT };

// Resolução do driver: bin-dir próprio → PATH (mesma ordem do produto, SPEC §7).
function findNativeTool(name) {
  const binDir = join(homedir(), '.config', 'ai-playbook', 'bin');
  for (const candidate of [join(binDir, name), join(binDir, `${name}.exe`)]) {
    if (existsSync(candidate)) return candidate;
  }
  const found = findSecretsTools(process.env)[{ age: 'age', 'age-keygen': 'ageKeygen', sops: 'sops' }[name]];
  if (!found) throw new Error(`ferramenta nativa ${name} não encontrada (bin-dir próprio e PATH)`);
  return found;
}
const SOPS = findNativeTool('sops');
const AGE_KEYGEN = findNativeTool('age-keygen');

function runBin(...args) {
  return spawnSync(BIN, args, { env: ENV, encoding: 'utf8', timeout: 120_000, windowsHide: true });
}

function pathsFor(context) {
  return {
    key: join(CONFIG_ROOT, 'keys', `${context}.agekey`),
    ctxDir: join(CONFIG_ROOT, 'contexts', context),
    sopsFile: join(CONFIG_ROOT, 'contexts', context, 'secrets.sops.env'),
    recipients: join(CONFIG_ROOT, 'contexts', context, 'recipients.txt'),
    sopsConfig: join(CONFIG_ROOT, 'contexts', context, '.sops.yaml'),
  };
}

function decryptWith(keyPath, sopsFile) {
  return spawnSync(SOPS, ['-d', '--input-type', 'env', '--output-type', 'env', sopsFile], {
    env: { ...ENV, SOPS_AGE_KEY_FILE: keyPath },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
}

function recipientsOf(context) {
  const paths = pathsFor(context);
  return readFileSync(paths.recipients, 'utf8').split(/\r?\n/).filter(Boolean);
}

after(() => {
  rmSync(CONFIG_ROOT, { recursive: true, force: true });
});

test('secrets init cria identidade, recipients, sops.yaml e arquivo cifrado', () => {
  const result = runBin('secrets', 'init', '--context', CTX);
  assert.equal(result.status, 0, `secrets init falhou:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /chave pública: age1/);
  assert.match(result.stdout, /edite com: mcp-runtime secrets edit/);

  const paths = pathsFor(CTX);
  assert.ok(existsSync(paths.key), `chave ausente: ${paths.key}`);
  assert.ok(existsSync(paths.sopsFile));
  assert.ok(existsSync(paths.recipients));
  assert.ok(existsSync(paths.sopsConfig));
  if (process.platform !== 'win32') {
    const mode = statSync(paths.key).mode & 0o777;
    assert.equal(mode, 0o600, `permissão da chave: ${mode.toString(8)}`);
  }
  pub1 = readFileSync(paths.recipients, 'utf8').trim();
  assert.match(pub1, /^age1/);
  const keyText = readFileSync(paths.key, 'utf8');
  assert.ok(keyText.includes(`# public key: ${pub1}`), 'comentário da public key ausente na chave');
  const sopsConfig = readFileSync(paths.sopsConfig, 'utf8');
  assert.equal(sopsConfig, `creation_rules:\n  - age: "${pub1}"\n`);
  const sopsText = readFileSync(paths.sopsFile, 'utf8');
  assert.ok(sopsText.startsWith('#ENC['), 'secrets.sops.env não está cifrado');

  const decrypted = decryptWith(paths.key, paths.sopsFile);
  assert.equal(decrypted.status, 0, `decifra com a chave do contexto falhou:\n${decrypted.stderr}`);
  assert.ok(decrypted.stdout.includes('GITHUB_PERSONAL_ACCESS_TOKEN='));
  assert.ok(decrypted.stdout.includes('ADO_ORG='));
});

test('secrets init em contexto existente falha', () => {
  const result = runBin('secrets', 'init', '--context', CTX);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /já existe/);
});

test('secrets init em contexto novo gera outra identidade (base do keys add)', () => {
  const result = runBin('secrets', 'init', '--context', CTX2);
  assert.equal(result.status, 0, `secrets init (2º contexto) falhou:\n${result.stderr}`);
});

test('doctor aponta secrets init quando o contexto está ausente', () => {
  const result = runBin('doctor', '--context', 'contexto-inexistente-xyz');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /crie com: mcp-runtime secrets init --context contexto-inexistente-xyz/);
});

test('keys add reencapsula para o segundo recipient', () => {
  const paths = pathsFor(CTX);
  const pub2 = recipientsOf(CTX2)[0];
  assert.match(pub2, /^age1/);

  const result = runBin('keys', 'add', '--context', CTX, '--recipient', pub2);
  assert.equal(result.status, 0, `keys add falhou:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /reencapsulado/);

  const recipients = readFileSync(paths.recipients, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(recipients.length, 2);
  const config = readFileSync(paths.sopsConfig, 'utf8');
  assert.ok(config.includes(','), `.sops.yaml sem lista de recipients:\n${config}`);

  const asKey1 = decryptWith(paths.key, paths.sopsFile);
  assert.equal(asKey1.status, 0, `decifra com key1 falhou:\n${asKey1.stderr}`);
  const asKey2 = decryptWith(pathsFor(CTX2).key, paths.sopsFile);
  assert.equal(asKey2.status, 0, `decifra com key2 falhou:\n${asKey2.stderr}`);
});

test('keys add do mesmo recipient falha', () => {
  const pub2 = recipientsOf(CTX2)[0];
  const result = runBin('keys', 'add', '--context', CTX, '--recipient', pub2);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /já está presente/);
});

test('keys add com recipient inválido falha', () => {
  const result = runBin('keys', 'add', '--context', CTX, '--recipient', 'nao-e-age');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--recipient inválido/);
});

test('keys remove reencapsula e remove o acesso do recipient removido', () => {
  const paths = pathsFor(CTX);
  const pub2 = recipientsOf(CTX2)[0];
  const result = runBin('keys', 'remove', '--context', CTX, '--recipient', pub2);
  assert.equal(result.status, 0, `keys remove falhou:\n${result.stdout}\n${result.stderr}`);

  const recipients = readFileSync(paths.recipients, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0], pub1);

  const asKey1 = decryptWith(paths.key, paths.sopsFile);
  assert.equal(asKey1.status, 0, `decifra com key1 falhou:\n${asKey1.stderr}`);
  const asKey2 = decryptWith(pathsFor(CTX2).key, paths.sopsFile);
  assert.notEqual(asKey2.status, 0, 'key2 ainda decifra após keys remove');
});

test('keys remove de recipient ausente e do último falham', () => {
  const pub2 = recipientsOf(CTX2)[0];
  const missing = runBin('keys', 'remove', '--context', CTX, '--recipient', pub2);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /não está presente/);

  const last = runBin('keys', 'remove', '--context', CTX, '--recipient', pub1);
  assert.notEqual(last.status, 0);
  assert.match(last.stderr, /último recipient/);
  const pathsAfter = pathsFor(CTX);
  const stillOk = decryptWith(pathsAfter.key, pathsAfter.sopsFile);
  assert.equal(stillOk.status, 0, 'arquivo deixou de decifrar após tentativa inválida');
});

test('secrets edit (EDITOR=true) sai 0 e o arquivo continua decifrável', () => {
  const paths = pathsFor(CTX);
  const result = spawnSync(BIN, ['secrets', 'edit', '--context', CTX], {
    env: { ...ENV, EDITOR: 'true' },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `secrets edit falhou:\n${result.stdout}\n${result.stderr}`);
  const decrypted = decryptWith(paths.key, paths.sopsFile);
  assert.equal(decrypted.status, 0, `decifra pós-edit falhou:\n${decrypted.stderr}`);
});
