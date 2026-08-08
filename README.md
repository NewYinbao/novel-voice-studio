# 声绘 Studio

一个本地优先的多角色有声书制作工具：导入小说，自动拆章，把正文整理成带角色、情绪和停顿的配音剧本，再为角色绑定声音样本并批量生成、试听和导出音频。

当前版本是可运行的 MVP，前端和 Node 服务零第三方依赖；真实 TTS 放在独立的 Python 模型工作器里，避免污染系统 Python 或现有 `torch` 环境。

## 已完成的能力

- TXT、Markdown、EPUB 导入；UTF-8、UTF-16、GB18030 自动识别。
- 中文章节标题识别，无标题长文自动按段落安全切块。
- 三档剧本策略：忠实朗读、轻度剧本化、广播剧化。
- 本地规则引擎可立即识别引号对白、推断角色并标注情绪；低置信度结果会标为“待确认”。
- Codex 多轮剧本协作室：持久 session、模型选择、对话微调、逐句人工编辑，以及任务包手工交接。
- 多角色编辑器：说话人、朗读文本、情绪、强度、语速、停顿均可局部修改。
- 音色库：麦克风录制、短音频导入，以及从长视频/音频中定位、试听并裁剪 3–60 秒素材；保留参考文本、标签、授权确认和来源区间。
- 角色—音色绑定，单句/本章/整书 TTS 队列，按句缓存和失败隔离。
- 本机 GPU、显存、内存、工具和工作器检测；按效果/速度偏好自动选模型。
- 真实模型离线时可生成明确标记的“演示音轨”，用来验收队列、播放器和导出流程。
- 不依赖 FFmpeg 即可拼接同规格 16-bit PCM WAV；安装 FFmpeg 后可继续扩展 MP3/M4B、响度归一化和章节元数据。
- 所有作品、原文、剧本、录音和生成音频只保存在本机 `data/`。

## 已验证配置与模型推荐

当前版本已在以下开发机配置完成端到端验证：

- NVIDIA GeForce RTX 5060 Ti，16GB 显存，Compute Capability 12.0（Blackwell `sm_120`）
- AMD Ryzen 7 9700X，8 核 / 16 线程
- 系统可见内存约 15.1GB
- Node.js 24
- 系统目前没有 FFmpeg；全局 Python 3.13 对多数 TTS 项目过新

推荐路由：

1. 默认效果/速度均衡：CosyVoice 3 0.5B。
2. 原生 Windows 最容易先跑通：Qwen3-TTS 0.6B Base。
3. 强情绪重点对白：IndexTTS2（许可证和 Windows 加速依赖需单独核对）。
4. 少样本角色专属权重：GPT-SoVITS。
5. Fish Speech S2-Pro 官方要求至少 24GB 显存且商业使用需书面授权，因此本机不会自动启用。

因为系统内存只有 16GB，模型工作器会懒加载，并在切换引擎时卸载上一模型。不要同时运行大型本地 LLM、视频模型和多个 TTS。

本机已完成实际部署与验证：

- 隔离环境：`%USERPROFILE%\micromamba-root\envs\novel-voice`
- 模型目录由 `.runtime/worker.env.json` 记录；当前验证使用外置磁盘上的 Qwen3-TTS 0.6B Base（约 2.34GB）
- 运行栈：PyTorch `2.13.0+cu130`，CUDA 可用，Compute Capability `12.0`
- 已用本地参考音完成 6.56 秒、24kHz 中文 WAV 的真实合成；验证文件在 `data/.tmp/qwen-smoke.wav`

## 立即启动 UI

不需要安装 npm 依赖：

```powershell
cd .\novel-voice-studio
npm start
```

浏览器打开：

```text
http://127.0.0.1:4317
```

第一次启动会生成一个可编辑的示例作品。没有模型工作器时，可以在制作台选择“演示音轨”完整走通制作与 WAV 导出。

## 用 micromamba 创建隔离模型环境

安装脚本只创建新的 `novel-voice` 环境，不会改现有 `torch` 环境；它会自动发现 `%USERPROFILE%\micromamba-root\condabin\micromamba.bat` 等常见 micromamba/conda 路径，并沿用现有 root prefix。

原生 Windows 建议先装 Qwen3-TTS：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-worker.ps1 -Engine qwen
```

如果 `conda` 只在 zsh 中是 alias、PowerShell 找不到它，请传入实际程序路径：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-worker.ps1 `
  -Engine qwen `
  -Runner "C:\实际路径\micromamba.exe"
```

模型较大时建议放到 D: 或 G:：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-worker.ps1 `
  -Engine qwen `
  -ModelDir "D:\AIModels\voice-studio"
```

安装器会把 runner、环境名和模型目录写到 `.runtime/worker.env.json`，之后 `start-all.ps1` 会自动复用，不必重复传 `-ModelDir`。

若模型已经下载，或想在首次推理时再下载：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-worker.ps1 -Engine qwen -SkipModelDownload
```

同时启动工作器和 UI：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-all.ps1
```

也可以分别启动：

```powershell
micromamba run -n novel-voice python .\worker\server.py
npm start
```

工作器监听 `127.0.0.1:7861`，健康检查为 `http://127.0.0.1:7861/health`。

### 从长视频或音频制作音色

进入“音色库”并选择“制作新音色 → 从长媒体裁剪”：

1. 选择本机视频或音频，在浏览器中预览并定位说话片段。
2. 用“取当前”设置起点和终点，或直接输入秒数；片段须为 3–60 秒，建议 10–30 秒。
3. 试听选中范围，确认只包含一位说话人、背景声尽量少，并逐字填写该片段的准确台词。
4. 确认声音与素材授权后提交。原文件以二进制流上传到本机服务，工作器用 FFmpeg/FFprobe 标准化提取为 24kHz 单声道 PCM WAV，再加入音色库。

单个长媒体默认上限为 1GB，不使用 Base64、不会整体读入内存；裁剪任务串行执行。提交成功或失败后会清理来源和中间文件，应用重启时也会回收未完成任务的临时素材。浏览器无法预览的容器或编码需先转为 MP4、WebM、WAV、MP3 或 M4A。

### 导入默认开源测试音色

应用和模型工作器启动后，可一次性导入 AISHELL-3 的两位男声和一位女声，并自动绑定到指定作品：

```powershell
npm run seed:voices -- --project-id project_xxxxxxxxxxxxxxxx
```

再加 `--render` 会为前三个不同角色各生成一句真实语音，并校验媒体接口返回的是有效 WAV：

```powershell
npm run seed:voices -- --project-id project_xxxxxxxxxxxxxxxx --render
```

脚本可重复执行，不会重复创建已经就绪的默认音色。样本来自 [AISHELL-3](https://huggingface.co/datasets/AISHELL/AISHELL-3)，数据集标注为 Apache-2.0；音色卡会保留 `AISHELL-3`、许可证和说话人编号标签。这些默认项只用于本地开发与流程测试，发布成品前仍应按作品用途自行复核许可和声音权利。

### CosyVoice 3 注意事项

CosyVoice 3 是默认的硬件/质量推荐，但官方安装目标是 Linux，`ttsfrd` 等可选组件也提供 Linux wheel。Windows 上建议通过 WSL2 手动安装官方仓库和模型，再在 WSL 中启动工作器；当前 `start-all.ps1` 只负责原生 Windows 环境，不冒充 WSL 安装器。原生 Windows 安装脚本中的 `-Engine cosyvoice` 是尽力兼容路径，不宣称官方支持。

官方最小加载/推理接口已经封装在 `worker/providers/cosyvoice.py`：

- `AutoModel(model_dir=..., load_trt=False, load_vllm=False, fp16=True)`
- 中性声音克隆：`inference_zero_shot(...)`
- 带情绪/语速指令：`inference_instruct2(...)`
- 内部统一输出 24kHz WAV

### Blackwell 显卡注意事项

RTX 5060 Ti 是 `sm_120`。很多旧 TTS 仓库锁定的 PyTorch、FlashAttention、xFormers 二进制包不包含该架构。安装脚本优先使用 CUDA 13.0 PyTorch，并在 Qwen3-TTS 中使用原生 SDPA，避免强装旧 `flash-attn` wheel。

## Codex 剧本润色

剧本处理有四条路径：本地规则引擎、Codex 剧本协作室、Codex 任务包手工交接，以及本地 Ollama。润色档位与处理路径彼此独立，均可选择忠实朗读、轻度剧本化或广播剧化。

Codex 剧本协作室使用持久会话：首次运行 `codex exec --sandbox read-only --json --output-schema ... -`，从 JSONL 中记录 `thread_id`；后续通过 `codex exec resume <SESSION_ID>` 在同一个 session 中继续调整。窗口支持每轮选择模型、查看会话历史，并在右侧手工修改台词、角色、情绪、强度、语速和停顿。下一轮会把制作台中的最新完整剧本带回同一 session，因此人工改动会成为新的编辑基线。

Windows 下会先探测设置中的命令；默认 `codex` 若命中不可启动的 WindowsApps 副本，还会自动搜索 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`。未登录时，可在 Codex 剧本协作室或模型中心点击“登录 Codex”：本地服务会启动官方 `codex login` 浏览器认证，并在界面中等待结果。账号、密码、验证码和令牌始终由 OpenAI 登录页与 Codex CLI 处理，不会进入本项目的页面、接口响应或项目数据。缓存目录名可能随 Codex App 更新变化，不要手工硬编码哈希目录。认证方式见 [OpenAI Authentication](https://learn.chatgpt.com/docs/auth)。

直接使用 Codex 会把当前章节原文以及后续轮次的当前剧本发送给已登录的 Codex 服务；本地规则和 Ollama 路径不会。任务包只有在你主动复制给 Codex 时才会离开本机。

直接协作进程会在独立的空临时工作目录运行，只继承登录、网络和系统运行所需的环境变量，并忽略用户配置/规则，关闭 shell、Apps、浏览器、计算机控制、图像生成和 hooks；它只通过标准输入接收当前章节，并读取复制后的剧本 Schema。这样不会把项目目录或其他应用环境变量暴露给本轮剧本任务。

Codex 官方文档确认 `codex exec` 支持 JSONL 事件、JSON Schema 结构化输出，以及 `exec resume <SESSION_ID>` 续接非交互会话：[Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) · [Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)。

## 项目结构

```text
novel-voice-studio/
├─ public/                 # 零依赖单页 UI
├─ src/
│  ├─ server.js            # 本地 HTTP API、媒体流与任务入口
│  └─ lib/
│     ├─ config.js         # 引擎目录与硬件选择器
│     ├─ novel.js          # 文本解码、章节拆分
│     ├─ epub.js           # 安全的最小 EPUB 解析器
│     ├─ script-engine.js  # 规则、Codex、Ollama 剧本 Provider
│     ├─ codex-sessions.js # Codex 会话记录、轮次摘要与持久化边界
│     ├─ store.js          # 原子 JSON 持久化与音色版本
│     ├─ tts.js            # 逐句缓存、工作器调用与队列
│     ├─ video-voice.js    # 长媒体流式上传、裁剪任务与临时素材
│     └─ audio.js          # PCM WAV 生成、解析与拼接
├─ worker/
│  ├─ server.py            # FastAPI 单 GPU 工作器
│  ├─ audio_extract.py     # FFmpeg 安全裁剪与 24kHz 单声道标准化
│  └─ providers/           # CosyVoice / Qwen3-TTS 适配器
├─ schemas/                # Codex 结构化剧本 Schema
├─ scripts/                # micromamba 安装与启动脚本
├─ tests/                  # Node 内置测试
└─ data/                   # 本地作品与音频（git 忽略）
```

## API 摘要

```text
GET    /api/bootstrap
GET    /api/system?refresh=1
GET    /api/codex/auth/login
POST   /api/codex/auth/login
DELETE /api/codex/auth/login
POST   /api/projects
POST   /api/projects/:id/import
POST   /api/projects/:id/script
GET    /api/projects/:id/chapters/:chapterId/codex-sessions
POST   /api/projects/:id/chapters/:chapterId/codex-sessions
POST   /api/projects/:id/chapters/:chapterId/codex-sessions/:sessionId/messages
GET    /api/projects/:id/chapters/:chapterId/codex-package
POST   /api/projects/:id/chapters/:chapterId/script-import
PATCH  /api/projects/:id/lines/:lineId
PATCH  /api/projects/:id/characters/:roleId
POST   /api/voices
POST   /api/voice-sources?fileName=...
POST   /api/voice-sources/:sourceId/extract
DELETE /api/voice-sources/:sourceId
POST   /api/projects/:id/render
POST   /api/projects/:id/export
GET    /api/jobs/:jobId
```

耗时操作返回 `202` 和任务 ID；TTS 任务在单 GPU 队列中串行执行。每句音频按引擎、音色版本、参考音频哈希、文本、情绪和参数生成缓存键，只重做发生变化的片段。

## 测试

```powershell
npm run verify
```

模型工作器的真实 FFmpeg 裁剪测试可在隔离环境中运行：

```powershell
cd .\worker
& "$env:USERPROFILE\micromamba-root\envs\novel-voice\python.exe" -m unittest discover -s tests -v
```

测试覆盖章节拆分（含标题独占一行）、标准 EPUB spine 提取、中文对白/情绪识别、Codex JSONL/session 续接、手工剧本带入下一轮、硬件/已安装 Provider 路由、剧本参数边界、流式 WAV 拼接、中文编码/BOM、项目路径防护、长媒体流式限额、裁剪范围、原子 claim/delete、媒体任务串行化、成功/失败清理以及真实 FFmpeg 输出格式。

## Git 与本地数据

仓库只管理源码、Schema、脚本和文档。`data/` 中的小说、音色与生成音频，以及 `.runtime/` 中的本机路径和缓存均由 `.gitignore` 排除。开发约定和提交前检查见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

项目暂未附加开源许可证；在仓库所有者明确选择许可证之前，不应假定代码或随附资产可被再分发。

## 模型与许可

应用不会替你取得小说或真人声音的权利。录入真人声音前必须获得本人明确授权；导入开源音色时必须遵守对应许可证。制作和发布有声书还需确认小说的复制、改编、表演及网络传播等权利。

- CosyVoice 3：Apache-2.0，默认商业友好基线。[官方仓库](https://github.com/QwenAudio/CosyVoice) · [模型卡](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)
- Qwen3-TTS：Apache-2.0；Base checkpoint 支持三秒克隆，但不接受 `instruct` 情绪参数，情绪主要继承参考音频。[官方仓库](https://github.com/QwenLM/Qwen3-TTS) · [0.6B Base 模型卡](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base)
- GPT-SoVITS：代码及官方权重为 MIT；适合 Windows 音色制作和少样本训练。[官方仓库](https://github.com/RVC-Boss/GPT-SoVITS)
- IndexTTS2：使用 Index Model License 2.2；达到月活/营收阈值需另行书面许可，且有下游和用途约束。[官方仓库](https://github.com/index-tts/index-tts) · [许可证](https://huggingface.co/IndexTeam/IndexTTS-2/blob/main/LICENSE.txt)
- Fish Speech S2：Fish Audio Research License 不授予商业使用权，商业产品或企业内部运营需另签书面许可；官方要求至少 24GB VRAM。[官方仓库](https://github.com/fishaudio/fish-speech) · [安装要求](https://github.com/fishaudio/fish-speech/blob/main/docs/en/install.md)

ChatTTS 和 F5-TTS 官方预训练权重含非商业限制，也没有进入默认可商用路径。

## 当前边界

- MVP 持久化使用原子 JSON；大规模生产版建议迁移 SQLite WAL、不可变剧本修订和持久化任务 lease。
- 内置工作器目前完整实现 CosyVoice3 与 Qwen3-TTS 适配器；IndexTTS2、GPT-SoVITS 和 Fish 会在模型目录中展示许可证和硬件信息，但在适配器完成前保持不可选择。
- 没有 FFmpeg 时只导出 WAV；MP3、M4B、封面/章节标记和 LUFS 归一化是下一阶段。
- EPUB 支持标准 OPF/spine 的文本型书籍；加密 DRM、扫描 PDF、DOCX 和 OCR 不在 MVP 范围。
