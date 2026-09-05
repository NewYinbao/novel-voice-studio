import { id, nowIso } from './utils.js';
import { readJson, writeJsonAtomic } from './utils.js';

function compactJob(job) {
  if (job.type !== 'voice_analyze' || !job.result?.analysis) return job;
  const { analysis, ...result } = job.result;
  return { ...job, result: { ...result, analysisId: result.analysisId || analysis.id } };
}

export class JobManager {
  #jobs = new Map();
  #gpuQueue = Promise.resolve();
  #mediaQueue = Promise.resolve();
  #storagePath;
  #saveTimer;
  #persistQueue = Promise.resolve();

  constructor(storagePath = null) {
    this.#storagePath = storagePath;
  }

  async init() {
    if (!this.#storagePath) return;
    const stored = await readJson(this.#storagePath, []);
    for (const item of Array.isArray(stored) ? stored : []) {
      const job = { ...item };
      if (['queued', 'running'].includes(job.state)) {
        job.state = 'failed';
        job.error = { code: 'WORKER_INTERRUPTED', message: '应用在任务执行期间重启，可重新提交该任务。' };
        job.message = job.error.message;
        job.updatedAt = nowIso();
      }
      this.#jobs.set(job.id, job);
    }
    await this.#persist();
  }

  #schedulePersist() {
    if (!this.#storagePath) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#persist().catch((error) => console.error('保存任务记录失败', error)), 80);
  }

  async #persist() {
    if (!this.#storagePath) return;
    this.#persistQueue = this.#persistQueue.catch(() => {}).then(() => writeJsonAtomic(this.#storagePath, this.list()));
    await this.#persistQueue;
  }

  async flush() {
    clearTimeout(this.#saveTimer);
    await this.#persist();
  }

  create(type, payload, handler, { gpu = false, media = false } = {}) {
    if (gpu && media) throw new TypeError('任务不能同时加入 GPU 与媒体队列');
    const job = {
      id: id('job'), type, state: 'queued', progress: 0, message: '已加入队列',
      payload, result: null, error: null, createdAt: nowIso(), updatedAt: nowIso()
    };
    this.#jobs.set(job.id, job);
    this.#schedulePersist();
    const execute = async () => {
      job.state = 'running';
      job.message = '正在处理';
      job.updatedAt = nowIso();
      const update = (progress, message, extra = {}) => {
        job.progress = Math.max(0, Math.min(100, Math.round(progress)));
        job.message = message || job.message;
        job.updatedAt = nowIso();
        Object.assign(job, extra);
        this.#schedulePersist();
      };
      try {
        job.result = await handler(update, job);
        job.state = 'completed';
        job.progress = 100;
        job.message = '已完成';
      } catch (error) {
        job.state = 'failed';
        job.error = { code: error.code || 'JOB_FAILED', message: error.message, detail: error.detail || null };
        job.message = error.message;
      }
      job.updatedAt = nowIso();
      this.#schedulePersist();
      return job;
    };
    if (media) {
      this.#mediaQueue = this.#mediaQueue.catch(() => {}).then(execute);
    } else if (gpu) {
      this.#gpuQueue = this.#gpuQueue.catch(() => {}).then(execute);
    } else {
      queueMicrotask(execute);
    }
    return compactJob(job);
  }

  get(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
    return compactJob(job);
  }

  findActive(predicate = () => true) {
    return [...this.#jobs.values()].find((job) => (
      ['queued', 'running'].includes(job.state) && predicate(job)
    )) || null;
  }

  list() {
    let completedCount = 0;
    return [...this.#jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).filter((job) => (
      ['queued', 'running'].includes(job.state) || completedCount++ < 100
    )).map(compactJob);
  }
}
