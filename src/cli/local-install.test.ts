import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installLocalSkills,
  listBundledSkills,
  LOCAL_INSTALL_MARKER,
  parseInstallArgs,
  uninstallLocalSkills,
} from './local-install.ts';

function writeSkill(root: string, name: string, body: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
}

test('install copies skills onto this machine and uninstall removes only those copies', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mwg-local-install-'));
  const skillsRoot = path.join(tmp, 'skills');
  const home = path.join(tmp, 'home');
  const project = path.join(tmp, 'project');
  writeSkill(skillsRoot, 'modern-web-guidance', '# local skill\n');
  writeSkill(skillsRoot, 'chrome-extensions', '# extensions\n');
  fs.writeFileSync(path.join(skillsRoot, 'modern-web-guidance', 'guides.txt'), 'stay local', 'utf8');

  const written = installLocalSkills({
    skillsRoot,
    skillNames: ['modern-web-guidance'],
    homeDir: home,
    projectDir: project,
    scope: 'both',
    packageName: '@hylouis233/modern-web-guidance',
    version: '1.0.0',
  });

  assert.ok(written.length > 1);
  const homeSkill = path.join(home, '.agents', 'skills', 'modern-web-guidance', 'SKILL.md');
  const projectSkill = path.join(project, '.claude', 'skills', 'modern-web-guidance', 'guides.txt');
  assert.equal(fs.readFileSync(homeSkill, 'utf8'), '# local skill\n');
  assert.equal(fs.readFileSync(projectSkill, 'utf8'), 'stay local');
  assert.equal(
    fs.existsSync(path.join(home, '.agents', 'skills', 'chrome-extensions')),
    false,
  );

  const removed = uninstallLocalSkills(home, project);
  assert.ok(removed.includes(path.join(home, '.agents', 'skills', 'modern-web-guidance')));
  assert.equal(fs.existsSync(homeSkill), false);
  assert.equal(fs.existsSync(path.join(project, '.claude', 'skills', 'modern-web-guidance')), false);
});

test('uninstall leaves a skill that this installer did not write', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mwg-local-uninstall-'));
  const home = path.join(tmp, 'home');
  const foreign = path.join(home, '.agents', 'skills', 'modern-web-guidance');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'SKILL.md'), '# someone else\n', 'utf8');

  const removed = uninstallLocalSkills(home, path.join(tmp, 'project'));
  assert.deepEqual(removed, []);
  assert.equal(fs.readFileSync(path.join(foreign, 'SKILL.md'), 'utf8'), '# someone else\n');
  assert.equal(fs.existsSync(path.join(foreign, LOCAL_INSTALL_MARKER)), false);
});

test('parseInstallArgs defaults to the modern-web-guidance skill', () => {
  const available = listBundledSkills(path.join(os.tmpdir(), 'does-not-exist'));
  assert.deepEqual(available, []);
  assert.deepEqual(parseInstallArgs([], ['modern-web-guidance', 'chrome-extensions']), {
    scope: 'both',
    skillNames: ['modern-web-guidance'],
  });
  assert.deepEqual(parseInstallArgs(['-g', '--choose'], ['chrome-extensions', 'modern-web-guidance']).scope, 'home');
  assert.deepEqual(parseInstallArgs(['--project', '--skill', 'chrome-extensions'], ['chrome-extensions', 'modern-web-guidance']), {
    scope: 'project',
    skillNames: ['chrome-extensions'],
  });
  assert.throws(() => parseInstallArgs(['--skill', 'missing'], ['modern-web-guidance']), /Unknown skill/);
});
