export const SCRIPT_STRUCTURE_LIMITS = Object.freeze({
  roles: 100,
  aliasesPerRole: 20,
  scenes: 200,
  linesPerScene: 500,
  totalLines: 5_000,
  warnings: 200,
  chapterTitleChars: 300,
  roleNameChars: 120,
  aliasChars: 120,
  roleDescriptionChars: 1_000,
  sceneTitleChars: 300,
  sceneContextChars: 4_000,
  speakerChars: 120,
  lineTextChars: 12_000,
  emotionNoteChars: 500,
  warningChars: 2_000,
  serializedBytes: 4 * 1024 * 1024,
  chapterSnapshotsBytes: 32 * 1024 * 1024
});

function limitError(message, code, statusCode) {
  const error = Object.assign(new Error(message), { code });
  if (statusCode) error.statusCode = statusCode;
  return error;
}

function assertText(value, maximum, label, options) {
  if (value === undefined || value === null) return;
  let text;
  try { text = String(value); } catch {
    throw limitError('剧本文本格式无效。', options.code, options.statusCode);
  }
  if (text.length > maximum) {
    throw limitError(`${label}超过安全长度上限。`, options.code, options.statusCode);
  }
}

export function scriptSerializedBytes(script, { code = 'SCRIPT_SCHEMA_INVALID', statusCode } = {}) {
  let serialized;
  try { serialized = JSON.stringify(script); } catch {
    throw limitError('剧本无法安全序列化。', code, statusCode);
  }
  if (typeof serialized !== 'string') {
    throw limitError('剧本无法安全序列化。', code, statusCode);
  }
  return Buffer.byteLength(serialized, 'utf8');
}

/**
 * Enforces one shared, fail-closed budget for model output, imports, live commits
 * and private version snapshots. It never truncates script content silently.
 */
export function assertScriptStructureLimits(script, {
  code = 'SCRIPT_SCHEMA_INVALID',
  statusCode,
  maxSerializedBytes = SCRIPT_STRUCTURE_LIMITS.serializedBytes
} = {}) {
  const options = { code, statusCode };
  if (!script || typeof script !== 'object' || Array.isArray(script)) {
    throw limitError('剧本结构无效。', code, statusCode);
  }
  assertText(script.chapterTitle, SCRIPT_STRUCTURE_LIMITS.chapterTitleChars, '章节标题', options);

  const roles = Array.isArray(script.roles) ? script.roles : [];
  if (roles.length > SCRIPT_STRUCTURE_LIMITS.roles) {
    throw limitError('剧本角色数量超过安全上限。', code, statusCode);
  }
  for (const role of roles) {
    if (!role || typeof role !== 'object' || Array.isArray(role)) {
      throw limitError('剧本角色结构无效。', code, statusCode);
    }
    assertText(role.name, SCRIPT_STRUCTURE_LIMITS.roleNameChars, '角色名称', options);
    assertText(role.description, SCRIPT_STRUCTURE_LIMITS.roleDescriptionChars, '角色说明', options);
    const aliases = Array.isArray(role.aliases) ? role.aliases : [];
    if (aliases.length > SCRIPT_STRUCTURE_LIMITS.aliasesPerRole) {
      throw limitError('角色别名数量超过安全上限。', code, statusCode);
    }
    for (const alias of aliases) assertText(alias, SCRIPT_STRUCTURE_LIMITS.aliasChars, '角色别名', options);
  }

  const scenes = Array.isArray(script.scenes) ? script.scenes : [];
  if (scenes.length > SCRIPT_STRUCTURE_LIMITS.scenes) {
    throw limitError('剧本场景数量超过安全上限。', code, statusCode);
  }
  let totalLines = 0;
  for (const scene of scenes) {
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
      throw limitError('剧本场景结构无效。', code, statusCode);
    }
    assertText(scene.title, SCRIPT_STRUCTURE_LIMITS.sceneTitleChars, '场景标题', options);
    assertText(scene.context, SCRIPT_STRUCTURE_LIMITS.sceneContextChars, '场景说明', options);
    const lines = Array.isArray(scene.lines) ? scene.lines : [];
    if (lines.length > SCRIPT_STRUCTURE_LIMITS.linesPerScene) {
      throw limitError('单个场景台词数量超过安全上限。', code, statusCode);
    }
    totalLines += lines.length;
    if (totalLines > SCRIPT_STRUCTURE_LIMITS.totalLines) {
      throw limitError('剧本台词总数超过安全上限。', code, statusCode);
    }
    for (const line of lines) {
      if (!line || typeof line !== 'object' || Array.isArray(line)) {
        throw limitError('剧本台词结构无效。', code, statusCode);
      }
      assertText(line.speaker, SCRIPT_STRUCTURE_LIMITS.speakerChars, '台词角色', options);
      assertText(line.sourceText, SCRIPT_STRUCTURE_LIMITS.lineTextChars, '台词原文', options);
      assertText(line.spokenText, SCRIPT_STRUCTURE_LIMITS.lineTextChars, '朗读文本', options);
      assertText(line.emotionNote, SCRIPT_STRUCTURE_LIMITS.emotionNoteChars, '情绪说明', options);
    }
  }

  const warnings = Array.isArray(script.warnings) ? script.warnings : [];
  if (warnings.length > SCRIPT_STRUCTURE_LIMITS.warnings) {
    throw limitError('剧本警告数量超过安全上限。', code, statusCode);
  }
  for (const warning of warnings) assertText(warning, SCRIPT_STRUCTURE_LIMITS.warningChars, '剧本警告', options);

  if (maxSerializedBytes === null) return { serializedBytes: null, totalLines };
  const serializedBytes = scriptSerializedBytes(script, options);
  if (serializedBytes > maxSerializedBytes) {
    throw limitError('剧本总大小超过安全上限。', code, statusCode);
  }
  return { serializedBytes, totalLines };
}
