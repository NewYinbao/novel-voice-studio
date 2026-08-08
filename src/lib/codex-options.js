export const DEFAULT_CODEX_MODEL = 'gpt-5.6-terra';
export const DEFAULT_CODEX_REASONING_EFFORT = 'medium';
export const CODEX_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const DEFAULT_CODEX_TIMEOUT_MINUTES = 10;
export const MIN_CODEX_TIMEOUT_MINUTES = 5;
export const MAX_CODEX_TIMEOUT_MINUTES = 120;

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const REASONING_CONFIG_ARGS = Object.freeze(Object.fromEntries(
  CODEX_REASONING_EFFORTS.map((effort) => [effort, `model_reasoning_effort="${effort}"`])
));

function httpError(message, code) {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

export function normalizeCodexModel(value, { fallback = DEFAULT_CODEX_MODEL } = {}) {
  const selected = value === undefined || value === null || value === '' ? fallback : value;
  if (typeof selected !== 'string') throw httpError('Codex 模型名称格式无效。', 'CODEX_MODEL_INVALID');
  const candidate = selected.trim();
  if (!MODEL_PATTERN.test(candidate)) {
    throw httpError('Codex 模型名称格式无效。', 'CODEX_MODEL_INVALID');
  }
  return candidate;
}

export function normalizeCodexReasoningEffort(value) {
  const selected = value === undefined || value === null || value === ''
    ? DEFAULT_CODEX_REASONING_EFFORT
    : value;
  if (typeof selected !== 'string') {
    throw httpError('Codex 推理强度无效。', 'CODEX_REASONING_EFFORT_INVALID');
  }
  const candidate = selected.trim().toLowerCase();
  if (!CODEX_REASONING_EFFORTS.includes(candidate)) {
    throw httpError('Codex 推理强度无效。', 'CODEX_REASONING_EFFORT_INVALID');
  }
  return candidate;
}

export function normalizeCodexTimeoutMinutes(value, { fallback = DEFAULT_CODEX_TIMEOUT_MINUTES } = {}) {
  const selected = value === undefined || value === null ? fallback : value;
  if (
    typeof selected !== 'number'
    || !Number.isInteger(selected)
    || selected < MIN_CODEX_TIMEOUT_MINUTES
    || selected > MAX_CODEX_TIMEOUT_MINUTES
  ) {
    throw httpError(
      `Codex 超时时间必须是 ${MIN_CODEX_TIMEOUT_MINUTES} 到 ${MAX_CODEX_TIMEOUT_MINUTES} 分钟之间的整数。`,
      'CODEX_TIMEOUT_MINUTES_INVALID'
    );
  }
  return selected;
}

/** Converts the bounded public minute value into an exact, safe timer duration. */
export function codexTimeoutMinutesToMs(value) {
  const minutes = normalizeCodexTimeoutMinutes(value);
  const timeoutMs = minutes * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 2_147_483_647) {
    throw httpError('Codex 超时时间超出安全计时范围。', 'CODEX_TIMEOUT_MINUTES_INVALID');
  }
  return timeoutMs;
}

/** Returns one fixed TOML override; callers must pass it as its own argv item after `-c`. */
export function codexReasoningConfigArg(value) {
  return REASONING_CONFIG_ARGS[normalizeCodexReasoningEffort(value)];
}
