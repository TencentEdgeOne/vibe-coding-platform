import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  MAKERS_REFERENCE_SKILL_NAMES,
  listMakersSkillReferences,
  resolveMakersSkillDirectory,
  resolveMakersSkillReferencePath,
} from '../agents/tools/_makers-skills.ts';
import type { MakersReferenceSkillName } from '../agents/tools/_makers-skills.ts';

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectMarkdownFiles(full)));
    } else if (entry.name.endsWith('.md')) {
      found.push(full);
    }
  }
  return found;
}

// Markdown links and backticked paths that point at a skill's own deeper docs.
// Globs such as `references/*-route.md` are prose, not loadable targets.
function extractReferenceLinks(markdown: string) {
  const targets = new Set<string>();
  for (const pattern of [/\]\((references\/[^)\s]+\.md)\)/g, /`(references\/[^`\s]+\.md)`/g]) {
    for (const match of markdown.matchAll(pattern)) {
      const target = match[1];
      if (target && !target.includes('*')) {
        targets.add(target);
      }
    }
  }
  return [...targets];
}

test('every cross-link inside a vendored SKILL.md is loadable through load_makers_skill', async () => {
  let checked = 0;
  for (const skill of MAKERS_REFERENCE_SKILL_NAMES) {
    const markdown = await readFile(
      path.join(resolveMakersSkillDirectory(skill), 'SKILL.md'),
      'utf8',
    );
    for (const link of extractReferenceLinks(markdown)) {
      const resolved = resolveMakersSkillReferencePath(skill, link);
      assert.ok(resolved, `${skill} links to ${link} but it does not resolve`);
      const stats = await stat(resolved).catch(() => null);
      assert.ok(stats?.isFile(), `${skill} links to ${link} but no such file exists`);
      checked += 1;
    }
  }
  // makers-agents alone documents more than a dozen; guard against the
  // extractor silently matching nothing and making this test vacuous.
  assert.ok(checked >= 20, `expected to check at least 20 cross-links, checked ${checked}`);
});

test('every vendored reference document on disk is reachable', async () => {
  let total = 0;
  for (const skill of MAKERS_REFERENCE_SKILL_NAMES) {
    const root = path.join(resolveMakersSkillDirectory(skill), 'references');
    const files = await collectMarkdownFiles(root);
    const indexed = await listMakersSkillReferences(skill);

    assert.deepEqual(
      [...indexed].sort(),
      files.map((file) => path.relative(root, file).replaceAll(path.sep, '/')).sort(),
      `${skill} index does not match the files on disk`,
    );

    for (const relative of indexed) {
      assert.equal(
        resolveMakersSkillReferencePath(skill, relative),
        path.join(root, relative),
        `${skill}/${relative} did not resolve to its own file`,
      );
    }
    total += indexed.length;
  }
  // An exact count, because the tree is vendored rather than followed: it only
  // changes when someone runs `npm run sync:skills`, and then the number here
  // moves with it in the same commit. A floor would pass a sync that silently
  // dropped documents, which is the failure this is here to catch.
  assert.equal(
    total,
    45,
    `the vendored skill tree should expose 45 deeper reference documents, saw ${total}`,
  );
});

test('a reference path is accepted in both spellings used by the documents', async () => {
  const skill: MakersReferenceSkillName = 'makers-agents';
  const bare = resolveMakersSkillReferencePath(skill, 'platform/sse-protocol.md');
  const linkForm = resolveMakersSkillReferencePath(skill, 'references/platform/sse-protocol.md');
  const dotted = resolveMakersSkillReferencePath(skill, './references/platform/sse-protocol.md');

  assert.ok(bare);
  assert.equal(linkForm, bare);
  assert.equal(dotted, bare);
  assert.ok((await stat(bare)).isFile());
});

test('reference resolution refuses to escape the skill directory', () => {
  const skill: MakersReferenceSkillName = 'makers-agents';
  for (const ref of [
    '../SKILL.md',
    '../../makers-deploy/SKILL.md',
    '../../../../../../etc/passwd.md',
    '/etc/passwd.md',
    'platform/../../../SKILL.md',
  ]) {
    assert.equal(
      resolveMakersSkillReferencePath(skill, ref),
      null,
      `${ref} should not resolve`,
    );
  }
});

test('reference resolution only serves markdown', () => {
  const skill: MakersReferenceSkillName = 'makers-agents';
  for (const ref of ['', '   ', 'platform/', 'platform/node-entry', '../../../../.env']) {
    assert.equal(resolveMakersSkillReferencePath(skill, ref), null, `${ref} should not resolve`);
  }
});

test('skills without deeper documents report an empty index', async () => {
  for (const skill of ['makers-cli', 'makers-edge-functions', 'makers-middleware'] as const) {
    assert.deepEqual(await listMakersSkillReferences(skill), []);
  }
  assert.ok((await listMakersSkillReferences('makers-storage')).includes('blob.md'));
});
