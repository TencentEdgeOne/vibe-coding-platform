'use client';

export type Locale = 'zh' | 'en';

export const LANGUAGE_STORAGE_KEY = 'vibe-coding-agent-cli-language';

export type HomeFeatureIcon = 'agent' | 'functions' | 'cli' | 'edge';

// One phase of a run, described by what the generated project gets out of the
// platform during it rather than by what the platform offers. The distinction is
// the whole point of these cards: a capability list belongs on a product site,
// but the question being asked here is what comes back from the prompt below.
//
// The four are ordered, and `home-stage.tsx` numbers them in array order. A
// phase ribbon above the title used to name them separately; it said the same
// four things the subtitle says in prose, so these are now the only place they
// are named.
type HomeFeature = {
  readonly icon: HomeFeatureIcon;
  readonly title: string;
  readonly desc: string;
};

// A landing-page example chip. Both fields hold the same sentence: the chip and
// the typewriter placeholder show it, and clicking it sends it unchanged. So it
// has to work as both — short enough to read on one line, complete enough to
// build from. A label that summarised a longer prompt once sent a user a
// six-page specification they had not read, so a test holds the two equal.
type HomeExample = {
  readonly label: string;
  readonly prompt: string;
};

export const TRANSLATIONS = {
  zh: {
    languageToggleAria: 'Switch language to English',
    // Two editions of this template ship side by side and the UI is the same in
    // both. The one beside the wordmark drives the CLI inside the sandbox, so it
    // says so: everything below about preview and deploy only holds here.
    brandTag: '平台版',
    // Two deployments live in this UI and they are easy to confuse: the panel
    // icon publishes the project the user just generated, the top-bar button
    // takes a copy of this template itself.
    deployLabel: '部署项目',
    templateDeployLabel: '部署模板',
    templateSourceLabel: '模板源码',
    home: {
      titleBefore: '一句话，',
      titleAccent: '生成并上线',
      titleAfter: '你的应用',
      subtitle: '内置平台规范与命令行，在沙箱中生成、校验、预览，再部署到 EdgeOne 全球边缘网络。',
      placeholder: '请输入你想构建的内容',
      fastBuild: '极速生成',
      // Short enough that four chips share one row, and still the whole
      // request: label and prompt are held identical by test, because a chip
      // that summarised a longer prompt once sent someone a six-page
      // specification they had never read.
      examples: [
        {
          label: '做一个 AI 聊天助手',
          prompt: '做一个 AI 聊天助手',
        },
        {
          label: '做一个持久化留言板',
          prompt: '做一个持久化留言板',
        },
        {
          label: '做一个 Next.js SSR 应用',
          prompt: '做一个 Next.js SSR 应用',
        },
        // Names a framework other than the default one on purpose: asking for a
        // specific framework is a thing you can do here, and one example that
        // says Next.js reads as the only one on offer.
        {
          label: '做一个 Astro 博客站点',
          prompt: '做一个 Astro 博客站点',
        },
      ] as readonly HomeExample[],
      // Each card names a capability of the platform, then says what this
      // template does with it — because the platform having a capability and a
      // generated project using it correctly are two different claims, and only
      // the second one is this page's to make. Written the other way round, the
      // four cards read as an EdgeOne service list that would be equally true
      // with no template involved at all.
      features: [
        {
          icon: 'agent',
          title: '多模型驱动生成',
          desc: '通过 Makers Models 统一接入多家供应商，结合平台 Skills 加载最新规范，生成的代码直接符合平台要求。',
        },
        {
          icon: 'functions',
          title: '框架适配与校验',
          desc: '内置主流框架的平台适配，适配器、产物目录与构建命令自动就绪。部署前自动执行兼容性检查，失败时尝试自动修复。',
        },
        {
          icon: 'cli',
          title: '沙箱实时预览',
          desc: '沙箱内置 EdgeOne CLI，右侧面板实时展示与线上一致的生产预览，Cloud Functions、Blob 等平台能力直接可用。',
        },
        {
          icon: 'edge',
          title: '一键边缘部署',
          desc: '点击部署按钮即可发布到 EdgeOne 全球边缘网络，全程自动完成构建与发布，无需手动操作 CLI。',
        },
      ] as readonly HomeFeature[],
    },
    response: {
      noDisplay: '已编写完成，请查看结果。',
      requestFailedPrefix: '请求失败：',
      unknownError: '未知错误',
      agentFlowEnded: 'Agent 流程已结束。',
      processingFailed: '请求处理失败。',
    },
    workspace: {
      changePlaceholder: '描述你想修改的内容',
      send: '发送',
      stop: '停止生成',
      // Labels the picker for screen readers only; the control itself shows the
      // model's own name, which is the more useful thing to read sighted.
      modelLabel: '选择模型',
      activityRunning: '正在执行',
      activityCompleted: '已完成',
      activityFailed: '失败',
      activityStopped: '已停止',
      activityInput: '输入',
      activityOutput: '输出',
      toolActions: {
        'Environment Preparing': '环境准备',
        Glob: '搜索文件',
        'Read file': '读取文件',
        'Write file': '写入文件',
        'Edit file': '编辑文件',
        'Create folder': '创建目录',
        'Delete file': '删除文件',
        'Create preview': '创建预览',
        'Deploy project': '部署项目',
        'Load skill': '查阅文档',
        'Search web': '搜索网页',
        'Run command': '运行命令',
      },
      // What each reference load is about. The tool is handed a document id, and
      // these are the words that stand in for it, so they have to read as a
      // subject the user recognises rather than as a filename.
      referenceTopics: {
        platform: '平台能力',
        structure: '项目结构',
        serverApi: '服务端 API',
        edgeApi: '边缘函数',
        aiEndpoint: 'AI 接口',
        storage: '数据存储',
        middleware: '请求中间件',
        migration: '项目迁移',
        cli: '命令行',
        deployment: '部署上线',
        environment: '环境适配',
        framework: '框架适配',
      },
      /** Marks the row where the agent goes past the overview of a topic. */
      referenceDetail: '详细用法',
      // An address the agent writes out in full — a live site, a preview — is
      // something the user takes elsewhere, so the reply offers to copy it.
      copyLink: '复制链接',
      linkCopied: '已复制',
      // The wording the deploy button sends as the user's turn, so the
      // transcript reads the same whether it was clicked or typed.
      deployRequest: '把这个项目部署到线上',
      deployNeedsProject: '生成项目后即可一键部署',
      deployNeedsIdle: '当前任务结束后即可部署',
      preview: '预览',
      code: '代码',
      refreshPreview: '刷新预览',
      copyPreviewPath: '复制当前路径',
      previewPathCopied: '已复制当前路径',
      openPreview: '在新窗口打开预览',
      // The viewport buttons are icon-only, so these are the accessible name as
      // well as the tooltip.
      viewportGroup: '预览宽度',
      viewportDesktop: '桌面宽度',
      viewportMobile: '移动宽度',
      downloadSource: '下载源码',
      downloading: '打包中...',
      exportTranscript: '导出 Log',
      exportTranscriptEmpty: '暂无对话可导出',
      back: '返回首页',
      newProjectConfirmTitle: '返回首页？',
      newProjectConfirmDescription: '当前任务仍在运行，返回会停止本次生成。是否继续？',
      newProjectConfirmCancel: '取消',
      newProjectConfirmContinue: '停止并返回',
      resuming: '正在加载对话…',
      restoringWorkspace: '正在还原代码与预览…',
      previewStarting: '预览启动中…',
      downloadFailed: '下载失败，请重试。',
      loadingPreview: '正在加载实时预览...',
      previewUnavailable: '预览连接已失效，正在等待重新连接。',
      // Short on purpose: the conversation already narrates the publish, and
      // this only has to say why this one pane stopped answering.
      previewPausedForDeploy: '正在发布，预览暂停',
      retryPreview: '重新连接',
      previewEmpty: '首次构建完成后会在这里显示预览。',
      constructionDisclaimer: '当前仅为模板演示流程使用，模型效果可能较差，简易部署后替换自有模型',
      previewError: '预览错误：',
      downloadError: '下载错误：',
      buildFailedMessage: '构建失败。源码包仍保留当前文件，便于调试。',
      buildFailedAfter: (attempts: number) =>
        `自动修复 ${attempts} 次后构建仍失败。源码包仍保留当前文件，便于调试。`,
    },
    files: {
      empty: '暂无文件。',
      refreshing: '加载中...',
      projectFiles: '项目文件',
      selectFile: '从左侧选择一个文件以预览内容。',
      loading: (path: string) => `正在加载 ${path}...`,
      readFailed: '读取失败',
      requestFailed: '请求失败',
      lines: (count: number) => `${count} 行`,
      truncated: '已截断',
      capabilities: {
        agent: 'AI 接口',
        'cloud-function': '服务端 API',
        'edge-function': '边缘接口',
        middleware: '请求中间件',
        config: '运行配置',
      },
      route: (route: string) => `路由 ${route}`,
    },
  },
  en: {
    languageToggleAria: '切换语言为中文',
    brandTag: 'Platform edition',
    deployLabel: 'Deploy project',
    templateDeployLabel: 'Deploy template',
    templateSourceLabel: 'Template source',
    home: {
      titleBefore: 'Describe it.',
      titleAccent: 'Ship it',
      titleAfter: 'to the edge.',
      // Kept short enough to hold one line at the container's 820px. The cells
      // below spell the run out phase by phase, so the sentence that used to
      // name all four of them here can afford to name fewer.
      subtitle: 'Platform conventions and the EdgeOne CLI, built in. Generate, validate and ship to the edge.',
      placeholder: "Let's build a",
      fastBuild: 'Fast build',
      examples: [
        {
          label: 'Build an AI chat assistant',
          prompt: 'Build an AI chat assistant',
        },
        {
          label: 'Build a persistent guestbook',
          prompt: 'Build a persistent guestbook',
        },
        {
          label: 'Build a Next.js SSR app',
          prompt: 'Build a Next.js SSR app',
        },
        {
          label: 'Build an Astro blog site',
          prompt: 'Build an Astro blog site',
        },
      ] as readonly HomeExample[],
      features: [
        {
          icon: 'agent',
          title: 'Multi-model generation',
          desc: 'Access multiple providers through Makers Models with one API Key. Platform Skills load the current spec, so generated code meets it out of the box.',
        },
        {
          icon: 'functions',
          title: 'Framework adaptation & checks',
          desc: 'Built-in adaptation for major frameworks — adapters, output dirs and build commands auto-configured. Compatibility checks and auto-fix run before deploy.',
        },
        {
          icon: 'cli',
          title: 'Live sandbox preview',
          desc: 'The sandbox ships the EdgeOne CLI with a production-grade preview panel. Cloud Functions, Blob and other platform capabilities work out of the box.',
        },
        {
          icon: 'edge',
          title: 'One-click edge deploy',
          desc: 'Hit the deploy button to publish to the EdgeOne global edge network. Build and release are fully automated — no manual CLI needed.',
        },
      ] as readonly HomeFeature[],
    },
    response: {
      noDisplay: 'The agent did not return anything displayable.',
      requestFailedPrefix: 'Request failed: ',
      unknownError: 'unknown error',
      agentFlowEnded: 'Agent flow has ended.',
      processingFailed: 'Request processing failed.',
    },
    workspace: {
      changePlaceholder: 'Ask for a change',
      send: 'Send',
      stop: 'Stop generation',
      modelLabel: 'Select model',
      activityRunning: 'Running',
      activityCompleted: 'Completed',
      activityFailed: 'Failed',
      activityStopped: 'Stopped',
      activityInput: 'Input',
      activityOutput: 'Output',
      toolActions: {
        'Environment Preparing': 'Environment Preparing',
        Glob: 'Glob',
        'Read file': 'Read file',
        'Write file': 'Write file',
        'Edit file': 'Edit file',
        'Create folder': 'Create folder',
        'Delete file': 'Delete file',
        'Create preview': 'Create preview',
        'Deploy project': 'Deploy project',
        'Load skill': 'Read docs',
        'Search web': 'Search web',
        'Run command': 'Run command',
      },
      referenceTopics: {
        platform: 'Platform basics',
        structure: 'Project structure',
        serverApi: 'Server APIs',
        edgeApi: 'Edge functions',
        aiEndpoint: 'AI endpoints',
        storage: 'Data storage',
        middleware: 'Request middleware',
        migration: 'Project migration',
        cli: 'CLI commands',
        deployment: 'Deployment',
        environment: 'Environment setup',
        framework: 'Framework setup',
      },
      referenceDetail: 'in depth',
      copyLink: 'Copy link',
      linkCopied: 'Copied',
      deployRequest: 'Deploy this project to production',
      deployNeedsProject: 'Deploy becomes available once a project is generated',
      deployNeedsIdle: 'Deploy becomes available once the current task finishes',
      preview: 'Preview',
      code: 'Code',
      refreshPreview: 'Refresh preview',
      copyPreviewPath: 'Copy current path',
      previewPathCopied: 'Current path copied',
      openPreview: 'Open preview in a new window',
      // The viewport buttons are icon-only, so these are the accessible name as
      // well as the tooltip.
      viewportGroup: 'Preview width',
      viewportDesktop: 'Desktop width',
      viewportMobile: 'Mobile width',
      downloadSource: 'Download source',
      downloading: 'Packaging...',
      exportTranscript: 'Export log',
      exportTranscriptEmpty: 'No conversation to export yet',
      back: 'Back to home',
      newProjectConfirmTitle: 'Leave this project?',
      newProjectConfirmDescription: 'A task is still running. Leaving will stop the current generation. Do you want to continue?',
      newProjectConfirmCancel: 'Cancel',
      newProjectConfirmContinue: 'Stop and leave',
      resuming: 'Loading conversation…',
      restoringWorkspace: 'Restoring code and preview…',
      previewStarting: 'Starting preview…',
      downloadFailed: 'Download failed, please retry.',
      loadingPreview: 'Loading live preview...',
      previewUnavailable: 'The preview connection expired. Reconnect to continue.',
      previewPausedForDeploy: 'Preview is paused while the project publishes',
      retryPreview: 'Reconnect',
      previewEmpty: 'Preview will appear after the first build finishes.',
      constructionDisclaimer: 'This is only a template demo flow. Model quality may be limited; replace it with your own model after simple deployment.',
      previewError: 'Preview error: ',
      downloadError: 'Download error: ',
      buildFailedMessage: 'Build failed. The source package still keeps the current files for debugging.',
      buildFailedAfter: (attempts: number) =>
        `Build failed after ${attempts} auto-fix attempt${attempts === 1 ? '' : 's'}. The source package still keeps the current files for debugging.`,
    },
    files: {
      empty: 'No files captured yet.',
      refreshing: 'Loading...',
      projectFiles: 'Project files',
      selectFile: 'Select a file from the left to preview its contents.',
      loading: (path: string) => `Loading ${path}...`,
      readFailed: 'Read failed',
      requestFailed: 'Request failed',
      lines: (count: number) => `${count} line${count === 1 ? '' : 's'}`,
      truncated: 'truncated',
      capabilities: {
        agent: 'AI endpoint',
        'cloud-function': 'Server API',
        'edge-function': 'Edge API',
        middleware: 'Request middleware',
        config: 'Runtime config',
      },
      route: (route: string) => `Route ${route}`,
    },
  },
} as const;

export type UiCopy = (typeof TRANSLATIONS)[Locale];
export type FileCopy = UiCopy['files'];
