import assert from 'node:assert/strict';
import test from 'node:test';
import { TRANSLATIONS } from '../app/i18n.ts';
import {
  REFERENCE_TOPICS,
  appendNarrationChunk,
  dropTrailingSummaryEcho,
  presentToolActivity,
} from '../app/lib/tool-activity.ts';
import { summarizeToolInput } from '../agents/utils/_activity.ts';
import { MAKERS_REFERENCE_SKILL_NAMES } from '../agents/tools/_makers-skills.ts';

test('direct Makers CLI dev and deploy commands have distinct actions', () => {
  const deploy = presentToolActivity({
    name: 'mcp__edgeone-sandbox__commands',
    inputSummary: 'edgeone makers deploy -n demo --json',
  });
  assert.equal(deploy.action, 'Deploy project');
  const dev = presentToolActivity({
    name: 'commands',
    inputSummary: 'edgeone makers dev --port 8088 --skip-env-sync --name demo',
  });
  assert.equal(dev.action, 'Create preview');
});

test('npm run build is a run command', () => {
  const build = presentToolActivity({
    name: 'mcp__edgeone-sandbox__commands',
    inputSummary: 'cd <project> && npm run build',
  });
  assert.equal(build.action, 'Run command');
  assert.equal(build.target, 'cd <project> && npm run build');
});

test('npm run dev is a run command, not create preview', () => {
  const dev = presentToolActivity({
    name: 'commands',
    inputSummary: 'npm run dev -- --host 0.0.0.0 --port 3000',
  });
  assert.equal(dev.action, 'Run command');
});

test('files_make_dir is create folder, not a command', () => {
  const mkdir = presentToolActivity({
    name: 'mcp__edgeone-sandbox__files_make_dir',
    inputSummary: JSON.stringify({ path: 'src/lib' }, null, 2),
  });
  assert.equal(mkdir.action, 'Create folder');
  assert.equal(mkdir.target, 'src/lib');
});

// A document id is internal on two counts: it carries the platform tier, and it
// names a file the user cannot open. The row says what the agent is reading up
// on instead, and it must do so for an id nobody has mapped yet — falling back
// to the id would put the one string this indirection exists to hide on screen.
test('a reference load reads as a topic, never as the document id', () => {
  for (const inputSummary of [
    'edgeone-makers-tools',
    JSON.stringify({ skill: 'edgeone-makers-tools' }, null, 2),
  ]) {
    const skill = presentToolActivity({ name: 'Skill', inputSummary });
    assert.equal(skill.action, 'Load skill');
    assert.equal(skill.topic, 'platform');
    assert.equal(skill.target, undefined);
  }

  const agents = presentToolActivity({
    name: 'mcp__edgeone-sandbox__load_makers_skill',
    inputSummary: 'makers-agents',
  });
  assert.equal(agents.action, 'Load skill');
  assert.equal(agents.topic, 'aiEndpoint');
  assert.equal(agents.target, undefined);

  const unmapped = presentToolActivity({
    name: 'mcp__edgeone-sandbox__load_makers_skill',
    inputSummary: 'makers-something-new',
  });
  assert.equal(unmapped.topic, 'platform');
  assert.equal(unmapped.target, undefined);
});

// The agent reads a deeper document straight after the overview it belongs to,
// so the two rows sit next to each other and the timeline reads as stuck unless
// the second one says it went further.
test('a deeper document is the same topic, marked as going further', () => {
  const summary = summarizeToolInput('mcp__edgeone-sandbox__load_makers_skill', {
    skill: 'makers-storage',
    ref: 'blob.md',
  });
  const detailed = presentToolActivity({ name: 'load_makers_skill', inputSummary: summary });
  assert.equal(detailed.topic, 'storage');
  assert.equal(detailed.detailed, true);

  const overview = presentToolActivity({
    name: 'load_makers_skill',
    inputSummary: summarizeToolInput('load_makers_skill', { skill: 'makers-storage' }),
  });
  assert.equal(overview.topic, 'storage');
  assert.equal(overview.detailed, false);
  assert.equal(
    summarizeToolInput('load_makers_skill', { skill: 'makers-storage' }),
    'makers-storage',
    'an overview keeps the plain summary every earlier conversation persisted',
  );
});

// The loader and the topic table are edited in different places, and a reference
// added on one side without the other silently degrades to the generic topic.
test('every loadable reference has its own topic in both languages', () => {
  for (const skill of MAKERS_REFERENCE_SKILL_NAMES) {
    const topic = REFERENCE_TOPICS[skill];
    assert.ok(topic, `${skill} has no topic, so its row would read as generic`);
    assert.ok(TRANSLATIONS.zh.workspace.referenceTopics[topic]);
    assert.ok(TRANSLATIONS.en.workspace.referenceTopics[topic]);
  }
  for (const topic of Object.values(REFERENCE_TOPICS)) {
    assert.ok(TRANSLATIONS.zh.workspace.referenceTopics[topic]);
    assert.ok(TRANSLATIONS.en.workspace.referenceTopics[topic]);
  }
});

test('zh and en tool action labels cover every action', () => {
  const actions = [
    'Environment Preparing',
    'Glob',
    'Read file',
    'Write file',
    'Edit file',
    'Create folder',
    'Delete file',
    'Create preview',
    'Deploy project',
    'Load skill',
    'Search web',
    'Run command',
  ] as const;
  for (const action of actions) {
    assert.ok(TRANSLATIONS.zh.workspace.toolActions[action]);
    assert.ok(TRANSLATIONS.en.workspace.toolActions[action]);
  }
  assert.equal(TRANSLATIONS.zh.workspace.toolActions['Read file'], '读取文件');
  assert.equal(TRANSLATIONS.en.workspace.toolActions['Read file'], 'Read file');
});

// Every label the conversation renders comes from here, so the platform tier
// leaking back into one of them is a leak the display filter cannot catch.
test('no visible copy names the platform tier', () => {
  // Makers Models is the model gateway's own product name and the one place the
  // word is what a user would look up. Everything else — the CLI above all,
  // which users install as EdgeOne's — reads as the tier leaking.
  const visible = JSON.stringify(TRANSLATIONS).replaceAll('Makers Models', '');
  assert.ok(!/makers/i.test(visible), 'UI copy must speak of EdgeOne, not the tier below it');
});

// The example chips are the only thing a user sees before typing, so a chip
// that exists in one language but not the other silently changes what the
// product looks capable of.
test('the landing examples stay in sync across languages', () => {
  const { zh, en } = TRANSLATIONS;
  assert.equal(zh.home.examples.length, en.home.examples.length);
  for (const example of [...zh.home.examples, ...en.home.examples]) {
    assert.ok(example.label.trim().length > 0, 'an empty label would render as a blank button');
    assert.ok(example.prompt.trim().length > 0, 'an empty prompt would clear the composer on click');
    // The button is the whole request, not a title for one. A label that
    // summarised a longer prompt sent the user something they had not read —
    // in the one case where it happened, a specification for six pages.
    assert.equal(
      example.prompt,
      example.label,
      'a landing example must send exactly the sentence on its button',
    );
  }
});

test('the landing platform cards stay in sync across languages', () => {
  const { zh, en } = TRANSLATIONS;
  assert.deepEqual(
    zh.home.features.map((feature) => feature.icon),
    en.home.features.map((feature) => feature.icon),
    'both languages must describe the same capabilities in the same order',
  );
  for (const feature of [...zh.home.features, ...en.home.features]) {
    for (const field of [feature.title, feature.desc]) {
      assert.ok(field.trim().length > 0, 'an empty field would render as a blank card');
    }
  }
  // The cards are numbered as an ordered run, so the count is what the ordinals
  // are read against: a language short one card would number the same phase
  // differently from the other.
  assert.equal(
    zh.home.features.length,
    en.home.features.length,
    'the ordinals number the cards, so both languages must run the same length',
  );
  // A ribbon above the title used to name these phases a second time, and the
  // subtitle names them a third — in prose, which is the version that stays.
  // A card title lifted verbatim out of that sentence puts the same words on
  // screen twice, which is what retired the ribbon.
  for (const { subtitle, features } of [zh.home, en.home]) {
    for (const feature of features) {
      assert.ok(
        !subtitle.includes(feature.title),
        `card "${feature.title}" repeats the subtitle verbatim`,
      );
    }
  }
});

// The browser sees the same token-sized chunks the runtime does, so the same
// rule applies: a short chunk is text, never a replay to skip.
test('streamed chunks are appended even when they repeat what came before', () => {
  const url = 'https://demo-preview-yy3vnimd.example.com?eo_token=example-token-aa';
  const activities = ['站点已上线。https://demo-preview-y', 'y', '3vnimd.example.com?eo_token=example-token-a', 'a']
    .reduce<ReturnType<typeof appendNarrationChunk>>(
      (current, chunk) => appendNarrationChunk(current, chunk),
      [],
    );

  assert.deepEqual(activities, [{ kind: 'text', content: `站点已上线。${url}` }]);

  // A resumed turn replays whole blocks, and those are long enough to tell.
  const replayed = appendNarrationChunk(activities, `站点已上线。${url}`);
  assert.deepEqual(replayed, activities);

  // Narration that follows a tool call starts its own block.
  const tool = { kind: 'tool' as const, toolUseId: 'a', name: 'commands', status: 'completed' as const };
  assert.deepEqual(
    appendNarrationChunk([tool], '好的'),
    [tool, { kind: 'text', content: '好的' }],
  );
});

// A deploy turn ends with the model announcing the result, and that same
// sentence comes back as the turn summary. Rendering both makes the agent look
// like it is repeating itself at the one moment the user is reading closely.
test('the closing narration gives way to the turn summary', () => {
  const narration = { kind: 'text' as const, content: '部署成功，Todolist 已发布到 EdgeOne Makers 线上环境。' };
  const tool = { kind: 'tool' as const, toolUseId: 'a', name: 'commands', status: 'completed' as const };

  // The summary carries the live URL the narration lacks, and the streamed
  // deltas broke the product name across chunks, so only whitespace-insensitive
  // containment recognises the echo.
  const deployed = dropTrailingSummaryEcho(
    [tool, { ...narration, content: '部署成功，Todolist已发布到EdgeOneMakers线上环境。' }],
    `${narration.content}\n\n线上地址：https://example.edgeone.app`,
  );
  assert.deepEqual(deployed, [tool]);

  // Compaction can also cut the narration down rather than extend it: the
  // dropped tail was judged not user-facing, so re-showing it above the summary
  // would put back exactly what compaction removed.
  assert.deepEqual(
    dropTrailingSummaryEcho(
      [tool, { ...narration, content: `${narration.content}构建产物在 dist 目录，用时 12 秒。` }],
      narration.content,
    ),
    [tool],
  );

  // The summary lifts the deployment URL onto its own line, sometimes behind a
  // label, so only the prose is comparable.
  assert.deepEqual(
    dropTrailingSummaryEcho(
      [tool, { ...narration, content: '部署已完成，站点已上线。https://demo.edgeone.app?eo_token=abc' }],
      '部署已完成，站点已上线。\n\n线上地址：https://demo.edgeone.app?eo_token=abc',
    ),
    [tool],
  );

  // Narration that says something the summary does not is progress, not an echo.
  assert.deepEqual(
    dropTrailingSummaryEcho([tool, narration], '预览已刷新，可以在右侧查看。'),
    [tool, narration],
  );
  // Only the trailing block is a candidate; earlier steps stay.
  assert.deepEqual(
    dropTrailingSummaryEcho([narration, tool], narration.content),
    [narration, tool],
  );
});
