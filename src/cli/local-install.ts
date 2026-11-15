/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

export const LOCAL_INSTALL_MARKER = '.mwg-local-fork';

/** User-home skill folders read by the common coding agents. */
export const HOME_SKILL_DIRS = [
  '.agents/skills',
  '.claude/skills',
  '.cursor/skills',
  '.codex/skills',
  '.gemini/skills',
  '.gemini/antigravity/skills',
  '.grok/skills',
  '.kimi/skills',
  '.github/skills',
];

/** Project skill folders written beside the directory where install is run. */
export const PROJECT_SKILL_DIRS = [
  '.agents/skills',
  '.claude/skills',
  '.cursor/skills',
  '.github/skills',
];

export const PUBLISHED_PACKAGE_NAME = '@hylouis233/modern-web-guidance';

export interface PackageIdentity {
  name: string;
  version: string;
}

export function resolveBundledSkillsRoot(fromDir: string): string {
  const candidates = [
    path.resolve(fromDir, '..'),
    path.resolve(fromDir, '../../dist/skills-cli/skills'),
    path.resolve(fromDir, '../../../modern-web-guidance/skills'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'modern-web-guidance', 'SKILL.md'))) return dir;
  }
  throw new Error('Could not find the skill files shipped with this CLI.');
}

export function listBundledSkills(skillsRoot: string): string[] {
  if (!fs.existsSync(skillsRoot)) return [];
  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(skillsRoot, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort();
}

export function readPackageIdentity(fromDir: string): PackageIdentity {
  const candidates = [
    path.resolve(fromDir, '../../package.json'),
    path.resolve(fromDir, 'template/package.json'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; version?: string; bin?: Record<string, string> };
    if (pkg.name === PUBLISHED_PACKAGE_NAME && pkg.bin?.['modern-web-guidance']) {
      return { name: pkg.name, version: pkg.version || '1.0.0' };
    }
  }
  return { name: PUBLISHED_PACKAGE_NAME, version: '1.0.0' };
}

export interface LocalInstallRequest {
  skillsRoot: string;
  skillNames: string[];
  homeDir: string;
  projectDir: string;
  scope: 'both' | 'home' | 'project';
  packageName: string;
  version: string;
}

function destinationRoots(req: Pick<LocalInstallRequest, 'homeDir' | 'projectDir' | 'scope'>): string[] {
  const roots: string[] = [];
  if (req.scope !== 'project') {
    for (const rel of HOME_SKILL_DIRS) roots.push(path.join(req.homeDir, rel));
  }
  if (req.scope !== 'home') {
    for (const rel of PROJECT_SKILL_DIRS) roots.push(path.join(req.projectDir, rel));
  }
  return roots;
}

export function installLocalSkills(req: LocalInstallRequest): string[] {
  const written: string[] = [];
  for (const root of destinationRoots(req)) {
    for (const name of req.skillNames) {
      const src = path.join(req.skillsRoot, name);
      if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
        throw new Error(`Skill not in this package: ${name}. Available: ${listBundledSkills(req.skillsRoot).join(', ')}`);
      }
      const dest = path.join(root, name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      fs.cpSync(src, dest, { recursive: true, dereference: true });
      fs.writeFileSync(
        path.join(dest, LOCAL_INSTALL_MARKER),
        `${req.packageName}\n${req.version}\nlocal-only\n`,
        'utf8',
      );
      written.push(dest);
    }
  }
  return written;
}

export function uninstallLocalSkills(homeDir: string, projectDir: string): string[] {
  const removed: string[] = [];
  const roots = [
    ...HOME_SKILL_DIRS.map(rel => path.join(homeDir, rel)),
    ...PROJECT_SKILL_DIRS.map(rel => path.join(projectDir, rel)),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dest = path.join(root, entry.name);
      if (!fs.existsSync(path.join(dest, LOCAL_INSTALL_MARKER))) continue;
      fs.rmSync(dest, { recursive: true, force: true });
      removed.push(dest);
    }
  }
  return removed;
}

export function parseInstallArgs(argv: string[], available: string[]): { scope: 'both' | 'home' | 'project'; skillNames: string[] } {
  let scope: 'both' | 'home' | 'project' = 'both';
  const requested: string[] = [];
  let choose = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-g' || arg === '--global') scope = 'home';
    else if (arg === '--project') scope = 'project';
    else if (arg === '--choose') choose = true;
    else if (arg === '--skill') {
      const name = argv[++i];
      if (!name) throw new Error('--skill needs a skill name.');
      requested.push(name);
    } else if (arg.startsWith('--skill=')) {
      requested.push(arg.slice('--skill='.length));
    }
  }
  const skillNames = choose ? available : (requested.length > 0 ? requested : ['modern-web-guidance']);
  const missing = skillNames.filter(name => !available.includes(name));
  if (missing.length > 0) {
    throw new Error(`Unknown skill: ${missing.join(', ')}. Available: ${available.join(', ')}`);
  }
  return { scope, skillNames };
}
