import test from 'node:test';
import assert from 'node:assert/strict';
import { OPEN_SOURCE_VOICE_PRESETS, VOICE_PRESET_CATEGORIES } from '../scripts/voice-preset-catalog.mjs';

test('常用角色预置音色目录完整且可幂等导入', () => {
  assert.equal(OPEN_SOURCE_VOICE_PRESETS.length, 15);
  assert.deepEqual([...new Set(OPEN_SOURCE_VOICE_PRESETS.map((item) => item.category))], VOICE_PRESET_CATEGORIES);

  const keys = new Set();
  const speakers = new Set();
  const markers = new Set();
  for (const item of OPEN_SOURCE_VOICE_PRESETS) {
    assert.match(item.key, /^[a-z0-9-]+$/);
    assert.match(item.speakerId, /^SSB\d{4}$/);
    assert.equal(item.marker, `AISHELL-3/${item.speakerId}`);
    assert.ok(item.tags.length <= 10);
    assert.ok(item.tags.includes(item.marker));
    assert.ok(item.tags.includes(item.category));
    assert.ok(item.transcript.length >= 4);
    assert.ok(item.files.length >= 1);
    for (const [file, sha256] of item.files) {
      assert.match(file, new RegExp(`^test/wav/${item.speakerId}/${item.speakerId}\\d{4}\\.wav$`));
      assert.match(sha256, /^[0-9a-f]{64}$/);
    }
    assert.equal(keys.has(item.key), false);
    assert.equal(speakers.has(item.speakerId), false);
    assert.equal(markers.has(item.marker), false);
    keys.add(item.key);
    speakers.add(item.speakerId);
    markers.add(item.marker);
  }

  for (const category of VOICE_PRESET_CATEGORIES) {
    assert.equal(OPEN_SOURCE_VOICE_PRESETS.filter((item) => item.category === category).length, 3);
  }
});

test('预置年龄标签不把风格名当成精确身份', () => {
  for (const item of OPEN_SOURCE_VOICE_PRESETS) {
    if (item.category === '年长教师感') assert.equal(item.ageGroup, 'D组 >41');
    if (item.category.startsWith('中年')) assert.equal(item.ageGroup, 'C组 26–40');
    if (['少女感', '少年感'].includes(item.category)) assert.equal(item.ageGroup, 'B组 14–25');
  }
});
