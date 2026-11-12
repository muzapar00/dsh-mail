/* dsh-mailbox 客户端 bundle — 手写、单文件、无构建步骤。
 *
 * 形态（SPEC §9.0）：这是 DSH Web GUI 的客户端插件，不是独立 Web UI。
 * 页面跑在 DSH 进程内的浏览器里，经 window.__ModuleLoader__.load 注册；
 * 数据只走宿主半边已鉴权的同源 Fetch 路由 /api/mailbox。
 *
 * 安全硬约束（SPEC §0 / UI-SPEC §9）：
 *  - 邮件 HTML 只进 <iframe sandbox=""> 的 srcdoc（宿主已消毒内容）或纯文本；
 *    本文件不存在任何 innerHTML 赋值，也不存在 dangerouslySetInnerHTML；
 *  - 外链一律 target="_blank" rel="noopener noreferrer"，且只允许 http(s)；
 *  - 授权码只提交、不回显、不落 localStorage、不写日志、不进 URL；
 *  - 删除邮件/好友、清空数据、关闭插件总开关都要二次确认；
 *  - 入口徽标只读本插件自己的 state（未读数），不碰宿主其它数据。
 *
 * 结构：①字典/图标/CSS ②数据层（真实 /api/mailbox + 预览 mock）③组件与注册。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mailbox',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    // DSH 原生组件库；包缺失时退回到本文件内置的极简控件，保证 bundle 永不炸。
    var P = null
    try {
      P = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (_error) {
      P = null
    }

    var PLUGIN_ID = 'dsh-mailbox'
    var NS = 'mailbox'
    var PANEL_ID = 'mailbox'
    // 宿主已鉴权 Fetch 路由（lib/server.js API_PATH）；第二项是 SPEC 旧路径兜底。
    var API_BASES = ['/api/mailbox', '/dsh-mailbox/api']
    var API_HEADER = 'x-dsh-mailbox'
    var UNREAD_POLL_MS = 60 * 1000
    var SEARCH_DEBOUNCE_MS = 250

    // ---------------------------------------------------------------- 字典
    // 中英双语；对象形式 locale.register 必须同时提供 zh 和 en。
    // locale/zh.json / locale/en.json 是同一份内容的导出副本（测试保证一致）。
    var DICT = {
      zh: {
        panel: '邮箱',
        title: '邮箱',
        subtitle: '收发信、好友白名单与 AI 收信通知',
        entryAria: '邮箱',
        unreadBadgeAria: '{count} 封未读邮件',
        navInbox: '收件箱',
        navSent: '已发送',
        navQuarantine: '隔离',
        navFriends: '好友',
        navSettings: '设置',
        navDiagnostics: '诊断',
        navAria: '邮箱导航',
        statusConnected: '已连接',
        statusConnecting: '连接中',
        statusDisconnected: '未连接',
        statusNotConfigured: '未配置',
        statusDisabled: '已停用',
        statusError: '连接失败',
        statusAria: '邮箱连接状态',
        refresh: '刷新',
        refreshing: '刷新中…',
        syncNow: '立即收信',
        syncing: '收信进行中…',
        syncDone: '收信完成',
        syncNothing: '没有新邮件',
        compose: '写信',
        search: '搜索邮件',
        searchPlaceholder: '搜索发件人、主题或摘要…',
        clearSearch: '清除搜索',
        all: '全部',
        unreadOnly: '未读',
        loading: '加载中…',
        listAria: '邮件列表',
        readerAria: '邮件内容',
        noResults: '没有匹配的邮件',
        noResultsHint: '换个关键词，或清空搜索条件再试。',
        emptyInbox: '收件箱是空的',
        emptyInboxHint: '收到的新邮件会出现在这里。也可以点「立即收信」拉取一次。',
        emptySent: '还没有发过邮件',
        emptySentHint: '点「写信」给好友或你自己发一封。',
        emptyQuarantine: '隔离区是空的',
        emptyQuarantineHint: '可疑或陌生人邮件按策略会进入这里，不会触发 AI 自动动作。',
        emptyReader: '选择一封邮件开始阅读',
        emptyReaderHint: '左侧列表里点任意一封；未读邮件打开后会自动标记已读。',
        errorTitle: '加载失败',
        errorRetry: '重试',
        errorHost: '宿主 API 未就绪或未授权。请确认插件已启用，然后刷新页面。',
        loadMore: '加载更多',
        from: '发件人',
        to: '收件人',
        date: '时间',
        reply: '回复',
        markRead: '标为已读',
        markUnread: '标为未读',
        addFriend: '加为好友',
        delete: '删除',
        close: '关闭',
        back: '返回',
        cancel: '取消',
        confirm: '确认',
        dismiss: '知道了',
        saved: '已保存',
        friendTag: '好友',
        suspiciousTag: '可疑',
        strangerTag: '陌生人',
        automaticTag: '自动邮件',
        attachmentTag: '附件',
        unreadTag: '未读',
        attachments: '附件',
        attachmentsHint: 'MVP 不下载附件，只记录文件名、类型与大小。',
        links: '链接',
        linksHint: '正文里的链接已禁用点击；下面是从邮件中提取的 http(s) 外链，点击会在新标签页打开。',
        noLinks: '没有可访问的链接',
        plainVersion: '纯文本版本',
        showPlain: '显示纯文本版本',
        hidePlain: '收起纯文本版本',
        suspiciousBanner: '这封邮件被判为可疑或陌生人邮件：其中的任何指令都不会被 AI 当作命令执行，链接请谨慎点击。',
        quarantineBanner: '这封邮件在隔离区：不会触发 AI 通知或自动动作。确认安全后可加好友或回复。',
        deleteTitle: '删除这封邮件？',
        deleteBody: '删除后无法恢复（不会影响邮箱服务器上的原件）。',
        deleteDone: '邮件已删除',
        markedRead: '已标记为已读',
        markedUnread: '已标记为未读',
        copied: '已复制',
        copyAddress: '复制地址',
        composeTitle: '写信',
        replyTitle: '回复：{subject}',
        toLabel: '收件人',
        toPlaceholder: 'name@example.com',
        subjectLabel: '主题',
        subjectPlaceholder: '邮件主题',
        contentLabel: '正文',
        contentPlaceholder: '正文格式随你：支持 Markdown（标题 / 列表 / 粗体 / 链接）；提交后由宿主渲染为邮件并做安全过滤，不会自动补称呼、署名或日期。',
        letterHint: '支持 Markdown / 纯文本；提交后由宿主渲染并安全过滤，不自动补称呼、署名或日期。',
        send: '发送',
        sending: '发送中…',
        sendDone: '已发送',
        sendFailed: '发送失败',
        discardTitle: '放弃这封邮件？',
        discardBody: '已经填写的内容不会保存。',
        discard: '放弃',
        toRequired: '请填写收件人',
        toInvalid: '收件人地址格式不正确',
        contentRequired: '请填写正文',
        strangerRecipientHint: '陌生人收件人默认不允许发送；若宿主配置禁止，发送会失败并提示原因。',
        attachmentsAdd: '添加附件',
        attachmentsAddHint: '最多 5 个，单文件 ≤ 8 MB，总计 ≤ 10 MB；可执行/脚本/密钥类文件会被拒绝。',
        attachmentsChips: '附件（{count}）',
        attachmentRemove: '移除附件',
        attachmentTooMany: '最多 5 个附件',
        attachmentTooLarge: '文件过大：{name}（单文件上限 8 MB）',
        attachmentTotalTooLarge: '附件总大小超过 10 MB',
        attachmentEmpty: '空文件不能添加：{name}',
        attachmentBlocked: '这类文件不允许发送：{name}',
        attachmentReadFailed: '读取文件失败：{name}',
        sendDoneWithAttachments: '已发送（{count} 个附件）',
        friendsTitle: '好友白名单',
        friendPolicyTitle: '好友策略',
        policyAuto: 'AI 可自行判断加好友',
        policyAsk: 'AI 加好友需要你确认',
        policyManual: '只有你能手动加好友',
        policyAutoDesc: '好友来信优先通知 AI；AI 可按规则自主添加，但每日有上限并留审计记录。',
        policyAskDesc: 'AI 想加好友时会生成待确认申请，你在这里通过或拒绝。',
        policyManualDesc: 'AI 不能添加好友，白名单完全由你维护。',
        friendCountAria: '好友 {count} 位',
        pendingTitle: '待确认申请',
        pendingEmpty: '没有待确认的好友申请。',
        pendingHint: 'AI 判断值得加为好友的地址会先出现在这里（策略为 ask 时）。',
        requestedByAi: 'AI 申请',
        requestedAt: '申请时间',
        approve: '通过',
        reject: '拒绝',
        approveDone: '已通过该好友申请',
        rejectDone: '已拒绝该好友申请',
        addFriendTitle: '手动添加好友',
        addressLabel: '邮箱地址',
        addressPlaceholder: 'friend@example.com',
        nameLabel: '备注名',
        namePlaceholder: '例如：张三',
        noteLabel: '备注',
        notePlaceholder: '为什么加为好友（可选）',
        add: '添加好友',
        adding: '添加中…',
        added: '已添加好友',
        alreadyFriend: '该地址已经是好友',
        emptyFriends: '还没有好友',
        emptyFriendsHint: '把常联系的人加进白名单：好友来信优先通知 AI，也允许你直接发信给他们。',
        removeTitle: '移除好友？',
        removeBody: '移除后，这个地址的来信会按陌生人策略处理。',
        remove: '移除',
        removeDone: '已移除好友',
        autoReply: '允许自动回复',
        autoReplyHint: '默认关闭；建议保持关闭以避免自动回复死循环。',
        sourceUser: '你添加',
        sourceAi: 'AI 添加',
        sourceApproved: 'AI 申请·你通过',
        friendSince: '添加于 {date}',
        aiAddLog: 'AI 加好友记录',
        emptyAiLog: '暂无 AI 加好友记录',
        settingsTitle: '邮箱设置',
        settingsAria: '邮箱设置',
        masterTitle: '插件总开关',
        masterOnDesc: '收信轮询、AI 收信通知与全部邮件工具已启用。',
        masterOffDesc: '已停止收信与通知，邮件工具与提示词均已注销；数据保留，可随时重新启用。',
        masterOn: '已启用',
        masterOff: '已停用',
        masterConfirmTitle: '关闭邮箱插件？',
        masterConfirmBody: '关闭后：停止 IMAP 收信轮询与 AI 收信通知；注销全部 mail_* / send_email 工具与系统提示词；UI 进入停用态。配置与邮件数据保留，随时可重新启用。',
        masterEnableTitle: '重新启用邮箱插件',
        masterEnableBody: '启用后恢复收信轮询与 AI 通知，并重新注册邮件工具。',
        masterChanged: '插件状态已更新',
        tabStart: '快速开始',
        tabConnect: '连接配置',
        tabNotify: '通知与好友',
        tabAdvanced: '高级设置',
        quickTitle: '四步开始使用',
        quickDesc: '按顺序填写即可；每完成一步，前面的标记会变成对勾。',
        step1Title: '填写邮箱账号',
        step1Desc: '本机发信邮箱与服务商登录账号（通常是同一个地址）。',
        step2Title: '选择服务商并填写授权码',
        step2Desc: '授权码不是邮箱登录密码；点开服务商导引按步骤获取。',
        step3Title: '测试连接',
        step3Desc: '先测 SMTP（发信）；需要收信再测 IMAP。',
        step4Title: '保存设置',
        step4Desc: '保存后立即生效：收信轮询与下一次发信都使用新配置。',
        stepGo: '去填写',
        stepTest: '去测试',
        accountTitle: '邮箱账号',
        accountHint: '这些信息决定发件人、默认收件人与界面身份。',
        smtpHint: '发信只需要 SMTP 授权码。',
        authConfiguredHint: '已保存授权码；输入新值会覆盖，留空则保持不变。',
        imapHint: '收信需要在服务商处单独开启 IMAP，并填写授权码。',
        pollIntervalLabel: '轮询间隔（秒）',
        pollIntervalHint: '越小收信越快，但请求更频繁。',
        notifyDesc: '收到新信时如何提醒 AI；陌生人邮件按你的策略处理。通知里不包含邮件的 HTML。',
        notifyTargetHint: '不指定时发给最近活跃会话。',
        strangerPolicyHint: '陌生人邮件是否通知 AI、只进隔离区或被忽略。',
        batchSecondsHint: '窗口内的多封新信合并成一条通知。',
        friendPolicyDesc: '好友来信优先通知 AI，也可以直接发信给好友。',
        advancedLetterDesc: '显示名用于发件人；称呼、署名与日期由 AI 在正文里自行决定。',
        advancedPromptDesc: 'AI 提示词语言、好友列表注入与附加说明。',
        advancedSecurityDesc: '发信频率、AI 加好友上限、可疑邮件隔离与本地保留量。',
        advancedUiTitle: '界面与数据',
        advancedUiDesc: '界面语言与本机数据目录（清空数据在诊断页）。',
        saveBarClean: '设置已是最新',
        uiLanguage: '界面语言',
        dataDirLabel: '本机数据目录',
        dataDirHint: '配置、邮件与好友数据的存放位置（只读）。',
        sectionAccount: '邮箱账号',
        sectionSmtp: '发信（SMTP）',
        sectionImap: '收信（IMAP）',
        sectionNotify: '收信通知',
        sectionFriends: '好友策略',
        sectionLetter: '信件外观与账号',
        sectionPrompt: '提示词',
        sectionSecurity: '安全与限额',
        sectionPrivacy: '隐私与数据',
        mailboxAddress: '本机发信邮箱',
        mailboxAddressHint: '用来发信的邮箱地址（显示在「发件人」里）。',
        displayName: '发件人显示名',
        signature: '署名（仅参考）',
        salutation: '称呼（仅参考）',
        greeting: '问候语（仅参考）',
        subjectPrefix: '主题前缀',
        letterhead: '在 HTML 邮件中附带信纸头像',
        ownerAddress: '用户收信邮箱',
        ownerAddressHint: '通知与默认发信对象；留空则默认发给好友或手动填写。',
        ownerName: '用户称呼',
        never: '从未',
        provider: '服务商预设',
        providerHint: '选择服务商会自动填好服务器、端口与加密方式。',
        notifyLatestHint: '发给最近活跃的那个会话。',
        notifyAllHint: '发给全部活跃会话（可能多个会话都收到）。',
        notifySpecificHint: '发给你在下拉里选中的那个会话。',
        stepReview: '查看',
        providerCustom: '自定义',
        smtpUser: 'SMTP 登录账号',
        smtpHost: 'SMTP 服务器',
        smtpPort: '端口',
        smtpSecurity: '加密方式',
        imapEnabled: '启用收信',
        imapHost: 'IMAP 服务器',
        imapPort: '端口',
        imapSecurity: '加密方式',
        imapMailbox: '收件箱文件夹',
        imapUser: 'IMAP 登录账号',
        authCode: '授权码',
        authCodeConfigured: '已配置（不回显）',
        authCodePlaceholder: '输入新的授权码（留空则不修改）',
        authCodeSourceEnv: '来自环境变量',
        authCodeSourceFile: '来自授权码文件',
        authCodeSourceConfig: '已保存在本地',
        authCodeGuide: '如何获取授权码',
        authGuideSummary: '服务商说明',
        authGuideSteps: '步骤',
        authGuideNote: '注意',
        authGuideLink: '官方帮助',
        clearSecrets: '清除已保存的授权码',
        clearSecretsHint: '勾选后保存会删除本地保存的 SMTP/IMAP 授权码。',
        testSmtp: '测试 SMTP',
        testImap: '测试 IMAP',
        testing: '测试中…',
        testOk: '连接与认证成功',
        testFailed: '测试失败',
        testNoAuth: '请先填写授权码，或已配置授权码文件/环境变量。',
        notifyEnabled: '启用收信通知',
        notifyTarget: '通知目标',
        notifyLatest: '最近活跃会话',
        notifyAll: '全部活跃会话',
        notifyDedicated: '独立会话（推荐）',
        notifyDedicatedHint: '自动创建「邮箱通知」会话，不打扰当前聊天。',
        notifyDedicatedTarget: '目标会话：邮箱通知（{id}）',
        notifyDedicatedPending: '首次有新信时会自动创建独立会话；也可以手动选一个已有会话。',
        notifySpecific: '指定已有会话',
        notifyTest: '通知测试',
        notifyUseTarget: '按通知目标（推荐）',
        notifyTestDelivered: '已投递到会话 {id}',
        notifyTestDedicated: '已投递到独立会话「邮箱通知」（{id}）',
        notifyTestFailed: '未投递到会话（没有活跃会话；通知已入队，下次有会话时再投递）',
        notifySession: '指定会话',
        notifySessionPick: '选择会话',
        strangerPolicy: '陌生人邮件',
        strangerNotify: '通知 AI（标注陌生人）',
        strangerQuarantine: '只进隔离区',
        strangerIgnore: '忽略（仅入库）',
        batchSeconds: '通知合并窗口（秒）',
        maxPreviewChars: '通知预览字数',
        friendPolicy: '好友策略',
        defaultAutoReply: '好友默认允许自动回复',
        promptLanguage: '提示词语言',
        promptZh: '中文',
        promptEn: '英文',
        promptBoth: '中英双语',
        extraNote: '追加提示词',
        extraNotePlaceholder: '附加给 AI 的额外说明（可选）',
        includeFriendList: '在系统提示词中包含好友列表',
        maxPromptFriends: '提示词中好友上限',
        allowRemoteImages: '允许加载邮件远程图片（默认关闭）',
        maxSendsPerHour: '每小时发信上限',
        maxFriendAddsPerDay: 'AI 每日加好友上限',
        quarantineSuspicious: '可疑邮件自动隔离',
        maxMessagesRetained: '本地保留邮件上限',
        save: '保存设置',
        saving: '保存中…',
        saveDone: '设置已保存',
        saveFailed: '保存失败',
        reset: '重置为默认',
        resetTitle: '重置设置？',
        resetBody: '非密钥配置会恢复默认值；已保存的授权码保留。',
        resetDone: '设置已重置',
        unsaved: '有未保存的修改',
        fieldIssues: '部分字段不合法：{fields}',
        securityNote: '安全提示',
        securityNoteBody: '授权码只保存在宿主本地（权限 600 的 secrets.json），API 永不回显明文；界面不会写入浏览器存储。',
        diagTitle: '诊断与帮助',
        diagAria: '诊断与帮助',
        diagVersion: '插件版本',
        diagNode: 'Node',
        diagPlatform: '平台',
        diagDataDir: '数据目录',
        copy: '复制',
        diagStore: '本地存储',
        diagMessages: '邮件索引',
        diagBytes: '占用空间',
        diagSync: '收信状态',
        diagLastSync: '最近同步',
        diagLastError: '最近错误',
        diagNotify: '通知',
        diagQueue: '待投递队列',
        diagTools: '已注册工具',
        diagTestNotify: '发送一条测试通知',
        diagNotifySent: '测试通知已投递',
        diagSyncNow: '立即收信一次',
        diagSessions: '可选通知会话',
        diagClearTitle: '清空邮箱数据？',
        diagClearBody: '会删除本地缓存的所有邮件、索引与待投递通知，不影响邮箱服务器上的邮件。好友与配置保留。',
        diagClearType: '输入「清空」以确认',
        diagClearPlaceholder: '清空',
        diagClear: '清空数据',
        diagCleared: '数据已清空',
        diagHealth: '服务健康',
        diagOpenInDsh: '打开方式',
        diagOpenInDshBody: '入口：左侧导航「邮箱」、会话标题栏的邮箱按钮、命令面板 /mailbox、设置 → 铅笔旁的「邮箱」页。',
        diagUnavailable: '诊断接口不可用（宿主未实现或插件停用）',
        disabledTitle: '邮箱插件已停用',
        disabledBody: '收信轮询、AI 收信通知与全部邮件工具已停止；邮件与配置数据保留。需要时可在「设置」里重新启用。',
        disabledBannerTitle: '插件已停用',
        disabledBannerBody: '已停止收信与通知，邮件工具已注销。数据保留，可随时重新启用。',
        disabledEnable: '重新启用',
        disabledGoSettings: '去设置',
        notConfiguredTitle: '还没配置邮箱',
        notConfiguredBody: '先填好发信邮箱与授权码，然后测试连接。收信需要在服务商处单独开启 IMAP。',
        notConfiguredCta: '去配置',
        settingsHint: '修改后点「保存设置」立即生效：收信轮询与下一次发信会使用新配置。',
        today: '今天',
        yesterday: '昨天',
        justNow: '刚刚',
        minutesAgo: '{count} 分钟前',
        hoursAgo: '{count} 小时前',
        daysAgo: '{count} 天前',
        serverUnavailable: '宿主接口返回 {status}',
        yes: '是',
        no: '否',
        on: '开',
        off: '关',
        more: '更多',
      },
      en: {
        panel: 'Mailbox',
        title: 'Mailbox',
        subtitle: 'Send and receive mail, manage trusted friends, get AI notifications',
        entryAria: 'Mailbox',
        unreadBadgeAria: '{count} unread messages',
        navInbox: 'Inbox',
        navSent: 'Sent',
        navQuarantine: 'Quarantine',
        navFriends: 'Friends',
        navSettings: 'Settings',
        navDiagnostics: 'Diagnostics',
        navAria: 'Mailbox navigation',
        statusConnected: 'Connected',
        statusConnecting: 'Connecting',
        statusDisconnected: 'Disconnected',
        statusNotConfigured: 'Not configured',
        statusDisabled: 'Disabled',
        statusError: 'Connection failed',
        statusAria: 'Mailbox connection status',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        syncNow: 'Check mail now',
        syncing: 'Checking mail…',
        syncDone: 'Mail check finished',
        syncNothing: 'No new mail',
        compose: 'Compose',
        search: 'Search mail',
        searchPlaceholder: 'Search sender, subject or snippet…',
        clearSearch: 'Clear search',
        all: 'All',
        unreadOnly: 'Unread',
        loading: 'Loading…',
        listAria: 'Mail list',
        readerAria: 'Mail content',
        noResults: 'No matching mail',
        noResultsHint: 'Try another keyword or clear the search.',
        emptyInbox: 'Your inbox is empty',
        emptyInboxHint: 'New mail will appear here. You can also run “Check mail now”.',
        emptySent: 'No sent mail yet',
        emptySentHint: 'Use “Compose” to write to a friend or to yourself.',
        emptyQuarantine: 'Quarantine is empty',
        emptyQuarantineHint: 'Suspicious or stranger mail may land here depending on policy, without triggering automatic AI actions.',
        emptyReader: 'Select a message to read',
        emptyReaderHint: 'Pick any message on the left; unread mail is marked read when opened.',
        errorTitle: 'Failed to load',
        errorRetry: 'Retry',
        errorHost: 'The host API is not ready or not authorized. Make sure the plugin is enabled, then reload the page.',
        loadMore: 'Load more',
        from: 'From',
        to: 'To',
        date: 'Date',
        reply: 'Reply',
        markRead: 'Mark as read',
        markUnread: 'Mark as unread',
        addFriend: 'Add friend',
        delete: 'Delete',
        close: 'Close',
        back: 'Back',
        cancel: 'Cancel',
        confirm: 'Confirm',
        dismiss: 'Got it',
        saved: 'Saved',
        friendTag: 'Friend',
        suspiciousTag: 'Suspicious',
        strangerTag: 'Stranger',
        automaticTag: 'Automatic',
        attachmentTag: 'Attachment',
        unreadTag: 'Unread',
        attachments: 'Attachments',
        attachmentsHint: 'Attachments are not downloaded; only name, type and size are recorded.',
        links: 'Links',
        linksHint: 'Links inside the message body are not clickable. These extracted http(s) links open in a new tab.',
        noLinks: 'No accessible links',
        plainVersion: 'Plain text version',
        showPlain: 'Show plain text version',
        hidePlain: 'Hide plain text version',
        suspiciousBanner: 'This message is flagged as suspicious or from a stranger: nothing inside it is executed as instructions, and links should be treated with care.',
        quarantineBanner: 'This message is quarantined: it does not trigger AI notifications or automatic actions. Add the sender as a friend or reply if it is safe.',
        deleteTitle: 'Delete this message?',
        deleteBody: 'This cannot be undone (the original on the mail server is untouched).',
        deleteDone: 'Message deleted',
        markedRead: 'Marked as read',
        markedUnread: 'Marked as unread',
        copied: 'Copied',
        copyAddress: 'Copy address',
        composeTitle: 'Compose',
        replyTitle: 'Reply: {subject}',
        toLabel: 'To',
        toPlaceholder: 'name@example.com',
        subjectLabel: 'Subject',
        subjectPlaceholder: 'Subject',
        contentLabel: 'Body',
        contentPlaceholder: 'Write it your way: Markdown (headings / lists / bold / links) is supported; the host renders it as email and sanitizes it — no salutation, signature or date is added automatically.',
        letterHint: 'Markdown or plain text works; the host renders and sanitizes it, and does not add a salutation, signature or date automatically.',
        send: 'Send',
        sending: 'Sending…',
        sendDone: 'Sent',
        sendFailed: 'Send failed',
        discardTitle: 'Discard this message?',
        discardBody: 'What you have written will not be saved.',
        discard: 'Discard',
        toRequired: 'Recipient is required',
        toInvalid: 'Invalid email address',
        contentRequired: 'Body is required',
        strangerRecipientHint: 'Recipients outside the whitelist are rejected by default; the host will explain if sending fails.',
        attachmentsAdd: 'Add attachments',
        attachmentsAddHint: 'Up to 5 files, 8 MB each, 10 MB total; executables, scripts and credential files are rejected.',
        attachmentsChips: 'Attachments ({count})',
        attachmentRemove: 'Remove attachment',
        attachmentTooMany: 'Up to 5 attachments',
        attachmentTooLarge: 'File too large: {name} (8 MB per file)',
        attachmentTotalTooLarge: 'Attachments exceed 10 MB in total',
        attachmentEmpty: 'Empty files cannot be attached: {name}',
        attachmentBlocked: 'This file type is not allowed: {name}',
        attachmentReadFailed: 'Could not read file: {name}',
        sendDoneWithAttachments: 'Sent ({count} attachments)',
        friendsTitle: 'Friend whitelist',
        friendPolicyTitle: 'Friend policy',
        policyAuto: 'AI may add friends on its own',
        policyAsk: 'AI friend requests need your approval',
        policyManual: 'Only you can add friends',
        policyAutoDesc: 'Friend mail is prioritized for the AI; the AI may add friends within a daily cap and an audit log.',
        policyAskDesc: 'When the AI wants to add a friend it creates a pending request for you to approve or reject.',
        policyManualDesc: 'The AI cannot add friends; the whitelist is fully maintained by you.',
        friendCountAria: '{count} friends',
        pendingTitle: 'Pending requests',
        pendingEmpty: 'No pending friend requests.',
        pendingHint: 'Addresses the AI considers worth adding appear here (policy: ask).',
        requestedByAi: 'AI request',
        requestedAt: 'Requested',
        approve: 'Approve',
        reject: 'Reject',
        approveDone: 'Friend request approved',
        rejectDone: 'Friend request rejected',
        addFriendTitle: 'Add a friend',
        addressLabel: 'Email address',
        addressPlaceholder: 'friend@example.com',
        nameLabel: 'Display name',
        namePlaceholder: 'e.g. Alice',
        noteLabel: 'Note',
        notePlaceholder: 'Why this person is a friend (optional)',
        add: 'Add friend',
        adding: 'Adding…',
        added: 'Friend added',
        alreadyFriend: 'Already a friend',
        emptyFriends: 'No friends yet',
        emptyFriendsHint: 'Add regular contacts to the whitelist: their mail is prioritized for the AI and you can write to them directly.',
        removeTitle: 'Remove friend?',
        removeBody: 'Mail from this address will then follow the stranger policy.',
        remove: 'Remove',
        removeDone: 'Friend removed',
        autoReply: 'Allow auto-reply',
        autoReplyHint: 'Off by default; keep it off to avoid auto-reply loops.',
        sourceUser: 'Added by you',
        sourceAi: 'Added by AI',
        sourceApproved: 'AI request · approved',
        friendSince: 'Added {date}',
        aiAddLog: 'AI friend-add log',
        emptyAiLog: 'No AI friend additions yet',
        settingsTitle: 'Mailbox settings',
        settingsAria: 'Mailbox settings',
        masterTitle: 'Plugin master switch',
        masterOnDesc: 'Mail polling, AI mail notifications and all mail tools are enabled.',
        masterOffDesc: 'Polling and notifications are stopped; mail tools and prompt section are unregistered. Data is kept and can be re-enabled anytime.',
        masterOn: 'Enabled',
        masterOff: 'Disabled',
        masterConfirmTitle: 'Disable the mailbox plugin?',
        masterConfirmBody: 'This stops IMAP polling and AI mail notifications, unregisters every mail_* / send_email tool and the prompt section, and puts the UI into the disabled state. Configuration and mail data are kept and can be re-enabled anytime.',
        masterEnableTitle: 'Re-enable the mailbox plugin',
        masterEnableBody: 'This restores mail polling, AI notifications and the mail tools.',
        masterChanged: 'Plugin state updated',
        tabStart: 'Quick start',
        tabConnect: 'Connection',
        tabNotify: 'Notifications',
        tabAdvanced: 'Advanced',
        quickTitle: 'Get started in four steps',
        quickDesc: 'Fill the steps in order; each marker turns into a check when done.',
        step1Title: 'Fill in the mailbox account',
        step1Desc: 'Agent mailbox and provider login (usually the same address).',
        step2Title: 'Pick a provider and enter the authorization code',
        step2Desc: 'An authorization code is not your password; open the provider guide below.',
        step3Title: 'Test the connection',
        step3Desc: 'Test SMTP for sending; test IMAP if you also want to receive.',
        step4Title: 'Save settings',
        step4Desc: 'Applies immediately: polling and the next send use the new settings.',
        stepGo: 'Open',
        stepTest: 'Test',
        accountTitle: 'Mailbox account',
        accountHint: 'These decide the sender, default recipient and identity.',
        smtpHint: 'Sending only needs the SMTP authorization code.',
        authConfiguredHint: 'A code is saved; enter a new one to replace it, leave empty to keep it.',
        imapHint: 'Receiving needs IMAP enabled at the provider plus an authorization code.',
        pollIntervalLabel: 'Poll interval (seconds)',
        pollIntervalHint: 'Smaller is faster but sends more requests.',
        notifyDesc: 'How the AI is notified; stranger mail follows your policy. Notifications never include mail HTML.',
        notifyTargetHint: 'Defaults to the most recent active session.',
        strangerPolicyHint: 'Whether stranger mail notifies the AI, goes to quarantine, or is ignored.',
        batchSecondsHint: 'New mail inside the window is merged into one notification.',
        friendPolicyDesc: 'Friend mail is prioritized for the AI and you can write to friends directly.',
        advancedLetterDesc: 'The display name is used as the sender; salutation, signature and date are decided by the AI in the body.',
        advancedPromptDesc: 'Prompt language, friend list injection and an extra note.',
        advancedSecurityDesc: 'Send rate, AI friend-add cap, suspicious-mail quarantine and retention.',
        advancedUiTitle: 'Interface and data',
        advancedUiDesc: 'UI language and the local data directory (clearing data lives in Diagnostics).',
        saveBarClean: 'All changes saved',
        uiLanguage: 'UI language',
        dataDirLabel: 'Local data directory',
        dataDirHint: 'Where config, mail and friends data live (read-only).',
        sectionAccount: 'Mailbox account',
        sectionSmtp: 'Sending (SMTP)',
        sectionImap: 'Receiving (IMAP)',
        sectionNotify: 'Mail notifications',
        sectionFriends: 'Friend policy',
        sectionLetter: 'Letter appearance and account',
        sectionPrompt: 'Prompt',
        sectionSecurity: 'Security limits',
        sectionPrivacy: 'Privacy and data',
        mailboxAddress: 'Agent mailbox address',
        mailboxAddressHint: 'The address used to send mail (shown as the sender).',
        displayName: 'Sender display name',
        signature: 'Signature (reference only)',
        salutation: 'Salutation (reference only)',
        greeting: 'Greeting (reference only)',
        subjectPrefix: 'Subject prefix',
        letterhead: 'Include the letterhead avatar in HTML mail',
        ownerAddress: 'Your receiving address',
        ownerAddressHint: 'Used for notifications and as the default recipient; leave empty to pick manually.',
        ownerName: 'Your name',
        never: 'Never',
        provider: 'Provider preset',
        providerHint: 'Picking a provider fills the server, port and security automatically.',
        notifyLatestHint: 'Notify the most recently active session.',
        notifyAllHint: 'Notify every active session (several may receive it).',
        notifySpecificHint: 'Notify the session selected below.',
        stepReview: 'Review',
        providerCustom: 'Custom',
        smtpUser: 'SMTP user',
        smtpHost: 'SMTP host',
        smtpPort: 'Port',
        smtpSecurity: 'Security',
        imapEnabled: 'Enable receiving',
        imapHost: 'IMAP host',
        imapPort: 'Port',
        imapSecurity: 'Security',
        imapMailbox: 'Mailbox folder',
        imapUser: 'IMAP user',
        authCode: 'Authorization code',
        authCodeConfigured: 'Configured (not shown)',
        authCodePlaceholder: 'Enter a new authorization code (leave empty to keep)',
        authCodeSourceEnv: 'From environment',
        authCodeSourceFile: 'From code file',
        authCodeSourceConfig: 'Stored locally',
        authCodeGuide: 'How to get an authorization code',
        authGuideSummary: 'Provider note',
        authGuideSteps: 'Steps',
        authGuideNote: 'Note',
        authGuideLink: 'Official help',
        clearSecrets: 'Clear saved authorization codes',
        clearSecretsHint: 'Saving with this checked deletes locally stored SMTP/IMAP codes.',
        testSmtp: 'Test SMTP',
        testImap: 'Test IMAP',
        testing: 'Testing…',
        testOk: 'Connected and authenticated',
        testFailed: 'Test failed',
        testNoAuth: 'Enter an authorization code first, or configure a code file / environment variable.',
        notifyEnabled: 'Enable mail notifications',
        notifyTarget: 'Notification target',
        notifyLatest: 'Most recent session',
        notifyAll: 'All active sessions',
        notifyDedicated: 'Dedicated session (recommended)',
        notifyDedicatedHint: 'Creates a “Mailbox notifications” session so the current chat is not interrupted.',
        notifyDedicatedTarget: 'Target session: Mailbox notifications ({id})',
        notifyDedicatedPending: 'The dedicated session is created with the first new mail; you can also pick an existing session.',
        notifySpecific: 'Pick an existing session',
        notifyTest: 'Test notification',
        notifyUseTarget: 'By notification target (recommended)',
        notifyTestDelivered: 'Delivered to session {id}',
        notifyTestDedicated: 'Delivered to the dedicated “Mailbox notifications” session ({id})',
        notifyTestFailed: 'Not delivered to a session (no live session; the notice is queued and will be delivered later)',
        notifySession: 'Specific session',
        notifySessionPick: 'Pick a session',
        strangerPolicy: 'Stranger mail',
        strangerNotify: 'Notify AI (marked stranger)',
        strangerQuarantine: 'Quarantine only',
        strangerIgnore: 'Ignore (store only)',
        batchSeconds: 'Notification batch window (seconds)',
        maxPreviewChars: 'Preview length',
        friendPolicy: 'Friend policy',
        defaultAutoReply: 'Allow auto-reply for friends by default',
        promptLanguage: 'Prompt language',
        promptZh: 'Chinese',
        promptEn: 'English',
        promptBoth: 'Chinese and English',
        extraNote: 'Extra prompt note',
        extraNotePlaceholder: 'Additional instructions for the AI (optional)',
        includeFriendList: 'Include friend list in the system prompt',
        maxPromptFriends: 'Friend list cap in prompt',
        allowRemoteImages: 'Load remote images in mail (off by default)',
        maxSendsPerHour: 'Sends per hour',
        maxFriendAddsPerDay: 'AI friend adds per day',
        quarantineSuspicious: 'Quarantine suspicious mail',
        maxMessagesRetained: 'Messages retained locally',
        save: 'Save settings',
        saving: 'Saving…',
        saveDone: 'Settings saved',
        saveFailed: 'Save failed',
        reset: 'Reset to defaults',
        resetTitle: 'Reset settings?',
        resetBody: 'Non-secret configuration returns to defaults; saved authorization codes are kept.',
        resetDone: 'Settings reset',
        unsaved: 'Unsaved changes',
        fieldIssues: 'Some fields are invalid: {fields}',
        securityNote: 'Security note',
        securityNoteBody: 'Authorization codes stay on the host (secrets.json, mode 600); the API never returns them and the UI never writes them to browser storage.',
        diagTitle: 'Diagnostics and help',
        diagAria: 'Diagnostics and help',
        diagVersion: 'Plugin version',
        diagNode: 'Node',
        diagPlatform: 'Platform',
        diagDataDir: 'Data directory',
        copy: 'Copy',
        diagStore: 'Local store',
        diagMessages: 'Message index',
        diagBytes: 'Size on disk',
        diagSync: 'Sync status',
        diagLastSync: 'Last sync',
        diagLastError: 'Last error',
        diagNotify: 'Notifications',
        diagQueue: 'Queued notifications',
        diagTools: 'Registered tools',
        diagTestNotify: 'Send a test notification',
        diagNotifySent: 'Test notification delivered',
        diagSyncNow: 'Check mail once',
        diagSessions: 'Notification sessions',
        diagClearTitle: 'Clear mailbox data?',
        diagClearBody: 'This deletes every locally cached message, index entry and queued notification. Mail on the server is untouched. Friends and configuration are kept.',
        diagClearType: 'Type “clear” to confirm',
        diagClearPlaceholder: 'clear',
        diagClear: 'Clear data',
        diagCleared: 'Data cleared',
        diagHealth: 'Service health',
        diagOpenInDsh: 'Where to find it',
        diagOpenInDshBody: 'Entry points: the “Mailbox” item in the left navigation, the mailbox button in the session header, the /mailbox command, and Settings → Mailbox page.',
        diagUnavailable: 'Diagnostics unavailable (host not implemented or plugin disabled)',
        disabledTitle: 'Mailbox plugin is disabled',
        disabledBody: 'Mail polling, AI notifications and all mail tools are stopped; mail and configuration data are kept. Re-enable it in Settings whenever you need it.',
        disabledBannerTitle: 'Plugin disabled',
        disabledBannerBody: 'Mail polling and notifications are stopped and mail tools are unregistered. Data is kept; you can re-enable it anytime.',
        disabledEnable: 'Re-enable',
        disabledGoSettings: 'Open settings',
        notConfiguredTitle: 'Mailbox is not configured yet',
        notConfiguredBody: 'Fill in the sending address and authorization code, then test the connection. Receiving requires enabling IMAP at the provider.',
        notConfiguredCta: 'Configure',
        settingsHint: 'Saved changes apply immediately: polling and the next send use the new configuration.',
        today: 'Today',
        yesterday: 'Yesterday',
        justNow: 'just now',
        minutesAgo: '{count} min ago',
        hoursAgo: '{count} h ago',
        daysAgo: '{count} d ago',
        serverUnavailable: 'Host API returned {status}',
        yes: 'Yes',
        no: 'No',
        on: 'On',
        off: 'Off',
        more: 'More',
      },
    }

    // ---------------------------------------------------------------- 图标
    // 24 viewBox / stroke 1.5 / currentColor，与 DSH 线性图标同观感。
    var ICON_PATHS = {
      mail: [
        ['rect', { x: 3, y: 5, width: 18, height: 14, rx: 3 }],
        ['path', { d: 'M3.6 7.2 12 13l8.4-5.8' }],
      ],
      inbox: [
        ['path', { d: 'M3 13.5h5l1.5 2.5h5l1.5-2.5h5' }],
        ['path', { d: 'M5 6.5h14l2 7v5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-5z' }],
      ],
      sent: [['path', { d: 'M21 3 10.5 13.5' }], ['path', { d: 'M21 3 14.5 21l-4-7.5L3 9.5z' }]],
      shield: [['path', { d: 'M12 3 4.5 6v5.5c0 4.5 3 8.2 7.5 9.5 4.5-1.3 7.5-5 7.5-9.5V6z' }], ['path', { d: 'M9 12l2 2 4-4' }]],
      users: [['circle', { cx: 9, cy: 8, r: 3 }], ['path', { d: 'M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5' }], ['path', { d: 'M16 5.5a3 3 0 0 1 0 5' }], ['path', { d: 'M17.5 14.2c1.7.7 2.8 2.3 3.2 4.8' }]],
      settings: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7' }]],
      diagnostics: [['path', { d: 'M3 12h4l2-4 3 8 2-4h7' }], ['circle', { cx: 12, cy: 12, r: 9 }]],
      compose: [['path', { d: 'M4 20h4L20 8l-4-4L4 16z' }], ['path', { d: 'M13.5 6.5 17.5 10.5' }]],
      refresh: [['path', { d: 'M20 11a8 8 0 1 0-.6 4' }], ['path', { d: 'M20 4.5V11h-6.5' }]],
      search: [['circle', { cx: 11, cy: 11, r: 6.5 }], ['path', { d: 'm16 16 4.5 4.5' }]],
      reply: [['path', { d: 'M9 7 4 12l5 5' }], ['path', { d: 'M4 12h9a7 7 0 0 1 7 7' }]],
      trash: [['path', { d: 'M4 7h16' }], ['path', { d: 'M9 7V5h6v2' }], ['path', { d: 'M6.5 7 7.5 20h9L17.5 7' }], ['path', { d: 'M10 11v5M14 11v5' }]],
      check: [['path', { d: 'm5 12.5 4.5 4.5L19 7.5' }]],
      close: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
      chevronDown: [['path', { d: 'm6 9 6 6 6-6' }]],
      chevronLeft: [['path', { d: 'm14.5 5.5-7 6.5 7 6.5' }]],
      chevronRight: [['path', { d: 'm9.5 5.5 7 6.5-7 6.5' }]],
      external: [['path', { d: 'M14 4h6v6' }], ['path', { d: 'M20 4 11 13' }], ['path', { d: 'M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-12A1.5 1.5 0 0 1 3 18.5v-12A1.5 1.5 0 0 1 4.5 5H9' }]],
      key: [['circle', { cx: 8, cy: 12, r: 4 }], ['path', { d: 'M12 12h9M18 12v3M15 12v2.5' }]],
      plug: [['path', { d: 'M9 3v5M15 3v5' }], ['path', { d: 'M6 8h12v2a6 6 0 0 1-6 6 6 6 0 0 1-6-6z' }], ['path', { d: 'M12 16v5' }]],
      warning: [['path', { d: 'M12 4 2.8 20h18.4z' }], ['path', { d: 'M12 10v4M12 17.2v.3' }]],
      send: [['path', { d: 'M21 3 10.5 13.5' }], ['path', { d: 'M21 3 14.5 21l-4-7.5L3 9.5z' }]],
      lock: [['rect', { x: 5, y: 10, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8.5 10V7a3.5 3.5 0 0 1 7 0v3' }]],
      externalLink: [['path', { d: 'M10 14 20 4' }], ['path', { d: 'M15 4h5v5' }], ['path', { d: 'M18 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5.5' }]],
      clock: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 7.5V12l3 2' }]],
      paperclip: [['path', { d: 'M8.5 12.5 15 6a3 3 0 0 1 4.2 4.2l-8 8a5 5 0 0 1-7-7l8-8' }]],
    }

    function Icon(props) {
      var name = props.name
      var size = props.size || 16
      var paths = ICON_PATHS[name] || ICON_PATHS.mail
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          className: props.className,
        },
        paths.map(function (pair, index) {
          return h(pair[0], Object.assign({ key: index }, pair[1]))
        }),
      )
    }

    function Spinner(props) {
      var size = props.size || 14
      return h('span', { className: 'dsh-mailbox-spinner', style: { width: size, height: size }, 'aria-hidden': 'true' })
    }

    // ---------------------------------------------------------------- 样式
    // 全部选择器带 dsh-mailbox- 前缀；颜色/圆角/阴影只用 DSH 主题令牌，
    // 亮/暗由宿主 body[data-ds-dark-theme] 切换，这里不存主题状态。
    var CSS = `
.dsh-mailbox-root{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,var(--dsh-font-family-text,system-ui,sans-serif));font-size:13px;line-height:20px}
.dsh-mailbox-root *,.dsh-mailbox-root *::before,.dsh-mailbox-root *::after{box-sizing:border-box}
.dsh-mailbox-header{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:calc(28px + var(--dsh-frame-top-clearance,0px)) clamp(20px,4vw,48px) 14px}
.dsh-mailbox-header-main{min-width:0;display:flex;flex-direction:column;gap:4px}
.dsh-mailbox-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dsh-mailbox-subtitle{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-mailbox-header-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;flex:none}
.dsh-mailbox-status{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-size:12px;background:var(--dsw-alias-bg-layer-1);white-space:nowrap}
.dsh-mailbox-status[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.dsh-mailbox-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.dsh-mailbox-status[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.dsh-mailbox-status-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.dsh-mailbox-status[data-tone="ok"] .dsh-mailbox-status-dot{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent)}
.dsh-mailbox-body{flex:1;min-height:0;display:flex;padding:0 clamp(20px,4vw,48px) 0;gap:16px}
.dsh-mailbox-nav{flex:none;width:196px;display:flex;flex-direction:column;gap:2px;padding:6px 0 24px;overflow:auto}
.dsh-mailbox-nav-item{display:flex;align-items:center;gap:10px;width:100%;height:36px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer;position:relative}
.dsh-mailbox-nav-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mailbox-nav-item[aria-current="page"]{background:var(--dsw-alias-interactive-bg-hover-accent,var(--dsw-alias-interactive-bg-hover));font-weight:500}
.dsh-mailbox-nav-item[aria-current="page"]::before{content:"";position:absolute;left:2px;top:9px;bottom:9px;width:2px;border-radius:2px;background:var(--dsw-alias-state-business-primary)}
.dsh-mailbox-nav-item[disabled]{opacity:.45;cursor:default}
.dsh-mailbox-nav-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mailbox-nav-count{flex:none;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--dsw-alias-state-error-primary);color:#fff;font-size:10px;line-height:18px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums}
.dsh-mailbox-nav-count[data-quiet="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}
.dsh-mailbox-nav-foot{margin-top:auto;padding:10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-mailbox-nav-foot-row{display:flex;align-items:center;gap:6px;min-width:0}
.dsh-mailbox-nav-foot-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mailbox-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;padding-bottom:24px}
.dsh-mailbox-columns{flex:1;min-height:0;display:grid;grid-template-columns:minmax(280px,380px) minmax(0,1fr);gap:12px;border-top:.5px solid var(--dsw-alias-border-l3);margin-top:2px}
.dsh-mailbox-list-pane{min-height:0;display:flex;flex-direction:column;border-right:.5px solid var(--dsw-alias-border-l3);margin-right:0;padding-right:0}
.dsh-mailbox-toolbar{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px 10px 0;flex-wrap:wrap}
.dsh-mailbox-search{flex:1;min-width:160px}
.dsh-mailbox-list-scroll{flex:1;min-height:0;overflow:auto;padding-right:4px;scrollbar-width:thin}
.dsh-mailbox-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.dsh-mailbox-row{position:relative;display:flex;gap:10px;width:100%;padding:10px;border:0;border-radius:10px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;align-items:flex-start}
.dsh-mailbox-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mailbox-row[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-hover-accent,var(--dsw-alias-interactive-bg-hover))}
.dsh-mailbox-row[aria-selected="true"]::after{content:"";position:absolute;left:2px;top:10px;bottom:10px;width:2px;border-radius:2px;background:var(--dsw-alias-state-business-primary)}
.dsh-mailbox-row:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dsh-mailbox-avatar{flex:none;width:30px;height:30px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;text-transform:uppercase;overflow:hidden}
.dsh-mailbox-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-mailbox-row-top{display:flex;align-items:baseline;gap:8px;min-width:0}
.dsh-mailbox-row-from{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.dsh-mailbox-row[data-unread="true"] .dsh-mailbox-row-from{font-weight:600}
.dsh-mailbox-row-date{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.dsh-mailbox-row-subject{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-primary)}
.dsh-mailbox-row[data-unread="true"] .dsh-mailbox-row-subject{font-weight:600}
.dsh-mailbox-row-snippet{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsh-mailbox-row-tags{display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:2px}
.dsh-mailbox-unread-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-error-primary);margin-top:7px}
.dsh-mailbox-list-foot{flex:none;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 0;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsh-mailbox-reader{min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-layer-1);border-left:0;border-radius:12px;margin:10px 0;border:.5px solid var(--dsw-alias-border-l3)}
.dsh-mailbox-reader-head{flex:none;display:flex;align-items:center;gap:4px;padding:8px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex-wrap:wrap}
.dsh-mailbox-reader-head-title{flex:1;min-width:120px;padding:0 8px;font-size:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mailbox-reader-scroll{flex:1;min-height:0;overflow:auto;padding:16px 20px 24px}
.dsh-mailbox-reader-subject{margin:0 0 6px;font-size:16px;line-height:24px;font-weight:600;overflow-wrap:anywhere}
.dsh-mailbox-reader-meta{display:flex;flex-wrap:wrap;gap:4px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-bottom:10px;overflow-wrap:anywhere}
.dsh-mailbox-reader-meta b{color:var(--dsw-alias-label-primary);font-weight:500}
.dsh-mailbox-banner{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:8px;margin-bottom:12px;font-size:12px;line-height:18px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dsh-mailbox-banner[data-tone="warn"]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-state-warn-primary)}
.dsh-mailbox-banner[data-tone="danger"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsh-mailbox-banner svg{flex:none;margin-top:1px}
.dsh-mailbox-reader-frame{width:100%;min-height:220px;height:52vh;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dsh-mailbox-reader-html-note{margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsh-mailbox-plain{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--dsw-font-family,var(--dsh-font-family-text));font-size:13px;line-height:21px}
.dsh-mailbox-plain-version{margin-top:14px;border-top:.5px solid var(--dsw-alias-border-l3);padding-top:10px}
.dsh-mailbox-plain-version summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-mailbox-attachments,.dsh-mailbox-links{margin-top:16px;border-top:.5px solid var(--dsw-alias-border-l3);padding-top:12px}
.dsh-mailbox-section-title{margin:0 0 6px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:6px}
.dsh-mailbox-attachment{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);margin-bottom:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-mailbox-link{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:2px 0;color:var(--dsw-alias-link);font-size:12px;overflow-wrap:anywhere;text-decoration:none}
.dsh-mailbox-link:hover{text-decoration:underline}
.dsh-mailbox-link-list{display:flex;flex-direction:column;gap:2px}
.dsh-mailbox-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;padding:40px 24px;color:var(--dsw-alias-label-secondary);min-height:180px}
.dsh-mailbox-empty-art{width:64px;height:64px;border-radius:18px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);margin-bottom:2px}
.dsh-mailbox-empty h3{margin:0;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-mailbox-empty p{margin:0;max-width:36em;font-size:12px;line-height:18px}
.dsh-mailbox-empty-actions{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;justify-content:center}
.dsh-mailbox-error{display:flex;flex-direction:column;gap:8px;align-items:flex-start;padding:16px;border-radius:10px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent);margin:12px 0}
.dsh-mailbox-error h3{margin:0;font-size:13px;font-weight:500;color:var(--dsw-alias-state-error-primary)}
.dsh-mailbox-error p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-mailbox-skeleton{display:flex;flex-direction:column;gap:10px;padding:8px 10px}
.dsh-mailbox-skeleton-row{display:flex;gap:10px;align-items:flex-start}
.dsh-mailbox-skeleton-block{border-radius:6px;background:var(--dsw-alias-bg-skeleton);animation:dsh-mailbox-pulse 1.4s ease-in-out infinite}
.dsh-mailbox-skeleton-line{height:10px;border-radius:5px;background:var(--dsw-alias-bg-skeleton);animation:dsh-mailbox-pulse 1.4s ease-in-out infinite}
@keyframes dsh-mailbox-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.dsh-mailbox-spinner{display:inline-block;flex:none;border-radius:50%;border:1.5px solid color-mix(in srgb,currentColor 25%,transparent);border-top-color:currentColor;animation:dsh-mailbox-spin .8s linear infinite}
@keyframes dsh-mailbox-spin{to{transform:rotate(360deg)}}
.dsh-mailbox-tag{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:5px;font-size:10px;line-height:18px;font-weight:500;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-mailbox-tag[data-tone="friend"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsh-mailbox-tag[data-tone="warn"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary)}
.dsh-mailbox-tag[data-tone="error"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsh-mailbox-tag[data-tone="business"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary)}
.dsh-mailbox-view{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.dsh-mailbox-view-scroll{flex:1;min-height:0;overflow:auto;padding:8px 4px 40px;scrollbar-width:thin}
.dsh-mailbox-view-inner{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.dsh-mailbox-card{border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px}
.dsh-mailbox-card[data-danger="true"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent)}
.dsh-mailbox-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
.dsh-mailbox-card-title{margin:0;font-size:14px;font-weight:500;line-height:22px}
.dsh-mailbox-card-desc{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-mailbox-master{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l3);background:linear-gradient(180deg,var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-layer-1))}
.dsh-mailbox-master-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-mailbox-master-title{margin:0;font-size:14px;font-weight:600;line-height:22px;display:flex;align-items:center;gap:8px}
.dsh-mailbox-master-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;max-width:56em}
.dsh-mailbox-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.dsh-mailbox-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-mailbox-field>span:first-child{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-mailbox-field input,.dsh-mailbox-field select,.dsh-mailbox-field textarea{width:100%}
.dsh-mailbox-field-hint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-mailbox-field-error{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary)}
.dsh-mailbox-field-row{display:flex;align-items:center;gap:8px}
.dsh-mailbox-switch-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0}
.dsh-mailbox-switch-row-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-mailbox-switch-row-text b{font-weight:500;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.dsh-mailbox-switch-row-text span{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-mailbox-auth-guide{margin-top:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:10px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-mailbox-auth-guide summary{cursor:pointer;color:var(--dsw-alias-label-primary);font-weight:500;list-style:none;display:flex;align-items:center;gap:6px}
.dsh-mailbox-auth-guide summary::-webkit-details-marker{display:none}
.dsh-mailbox-auth-guide[open] summary{margin-bottom:8px}
.dsh-mailbox-auth-guide ol{margin:6px 0;padding-left:20px;display:flex;flex-direction:column;gap:4px}
.dsh-mailbox-auth-links{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.dsh-mailbox-note{display:flex;gap:8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;margin-top:10px}
.dsh-mailbox-test-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px}
.dsh-mailbox-test-result{font-size:12px;line-height:18px;display:inline-flex;align-items:center;gap:6px;overflow-wrap:anywhere}
.dsh-mailbox-test-result[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.dsh-mailbox-test-result[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.dsh-mailbox-test-result[data-tone="busy"]{color:var(--dsw-alias-label-secondary)}
.dsh-mailbox-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;padding-top:2px}
.dsh-mailbox-actions-split{justify-content:space-between}
.dsh-mailbox-friend-list{display:flex;flex-direction:column;gap:8px}
.dsh-mailbox-friend{display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dsh-mailbox-friend-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-mailbox-friend-name{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:500;overflow-wrap:anywhere}
.dsh-mailbox-friend-address{color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}
.dsh-mailbox-friend-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.dsh-mailbox-friend-side{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.dsh-mailbox-pending{border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,var(--dsw-alias-border-l3));border-radius:10px;padding:10px 12px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 6%,var(--dsw-alias-bg-layer-2));display:flex;gap:12px;align-items:flex-start}
.dsh-mailbox-diag-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.dsh-mailbox-diag-item{display:flex;flex-direction:column;gap:1px;min-width:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.dsh-mailbox-diag-item b{font-size:12px;line-height:18px;font-weight:500;overflow-wrap:anywhere}
.dsh-mailbox-diag-item span{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-mailbox-code{margin:0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3);font-family:var(--ds-font-family-code,var(--dsh-font-family-code,ui-monospace,monospace));font-size:11px;line-height:17px;overflow:auto;max-height:240px;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-mailbox-toolbar-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-mailbox-disabled-overlay{position:relative}
.dsh-mailbox-disabled-overlay>[data-disabled-dim]{opacity:.5;pointer-events:none;filter:saturate(.6)}
.dsh-mailbox-banner-page{flex:none;display:flex;align-items:center;gap:12px;margin:0 clamp(20px,4vw,48px) 10px;padding:10px 14px;border-radius:10px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}
.dsh-mailbox-banner-page b{font-weight:600}
.dsh-mailbox-banner-page-actions{margin-left:auto;display:flex;gap:8px;flex:none}
.dsh-mailbox-banner-page-text{display:flex;flex-direction:column;gap:0;min-width:0}
.dsh-mailbox-banner-page-text span{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dsh-mailbox-toasts{position:fixed;right:20px;bottom:20px;z-index:60;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none}
.dsh-mailbox-toasts>*{pointer-events:auto}
.dsh-mailbox-composer-backdrop{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,color-mix(in srgb,#000 30%,transparent));z-index:20;animation:dsh-mailbox-fade .14s ease-out}
.dsh-mailbox-composer{position:absolute;top:0;right:0;bottom:0;width:min(560px,92%);z-index:21;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border-left:.5px solid var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-panel,var(--dsw-shadow-lv2));animation:dsh-mailbox-slide .16s cubic-bezier(.2,.8,.2,1)}
.dsh-mailbox-composer-head{flex:none;display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsh-mailbox-composer-title{margin:0;font-size:14px;font-weight:500;line-height:22px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mailbox-composer-body{flex:1;min-height:0;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.dsh-mailbox-composer-body textarea{min-height:220px;resize:vertical;font:inherit;line-height:21px}
.dsh-mailbox-composer-foot{flex:none;display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:.5px solid var(--dsw-alias-border-l3)}
.dsh-mailbox-composer-hint{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsh-mailbox-inline-tabs{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.dsh-mailbox-mobile-back{display:none}
.dsh-mailbox-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@keyframes dsh-mailbox-slide{from{transform:translateX(24px);opacity:.5}to{transform:translateX(0);opacity:1}}
@keyframes dsh-mailbox-fade{from{opacity:0}to{opacity:1}}
@media (max-width:1199px){
.dsh-mailbox-nav{width:100%;flex-direction:row;overflow-x:auto;padding:0 0 8px;gap:6px;order:-1}
.dsh-mailbox-nav-item{width:auto;flex:none;padding:0 12px;height:32px}
.dsh-mailbox-nav-item[aria-current="page"]::before{left:10px;right:10px;top:auto;bottom:1px;width:auto;height:2px}
.dsh-mailbox-nav-foot{display:none}
.dsh-mailbox-body{flex-direction:column}
}
@media (max-width:1023px){
.dsh-mailbox-columns{grid-template-columns:minmax(240px,320px) minmax(0,1fr);gap:8px}
}
@media (max-width:767px){
.dsh-mailbox-header{padding:calc(20px + var(--dsh-frame-top-clearance,0px)) 16px 10px;align-items:center}
.dsh-mailbox-body{padding:0 12px}
.dsh-mailbox-columns{grid-template-columns:minmax(0,1fr)}
.dsh-mailbox-reader{position:absolute;inset:0;margin:0;border-radius:12px;z-index:10;background:var(--dsw-alias-bg-base);border:0}
.dsh-mailbox-main{position:relative}
.dsh-mailbox-mobile-back{display:inline-flex}
.dsh-mailbox-composer{width:100%;border-left:0}
.dsh-mailbox-grid2{grid-template-columns:minmax(0,1fr)}
.dsh-mailbox-header-actions{gap:6px}
.dsh-mailbox-subtitle{display:none}
}
@media (prefers-reduced-motion:reduce){
.dsh-mailbox-composer,.dsh-mailbox-composer-backdrop{animation:none}
.dsh-mailbox-skeleton-block,.dsh-mailbox-skeleton-line{animation:none}
}
`

    // -------------------------------------------------- 原生控件适配（带兜底）
    function fallbackButton(props) {
      var rest = {}
      Object.keys(props).forEach(function (key) {
        if (key !== 'variant' && key !== 'size' && key !== 'children') rest[key] = props[key]
      })
      rest.type = props.type || 'button'
      rest.className = 'dsh-mailbox-btn ' + (props.className || '')
      return h('button', rest, props.children)
    }
    function fallbackInput(props) {
      var rest = {}
      Object.keys(props).forEach(function (key) {
        if (key !== 'icon') rest[key] = props[key]
      })
      return h('input', rest)
    }
    var UI = {
      Button: (P && P.Button) || fallbackButton,
      Input: (P && P.Input) || fallbackInput,
      Switch: (P && P.Switch) || function (props) {
        return h('label', { className: 'dsh-mailbox-fallback-switch' }, h('input', { type: 'checkbox', checked: props.checked === true, disabled: props.disabled === true, onChange: function (event) { if (typeof props.onChange === 'function') props.onChange(event.target.checked) }, 'aria-label': props.label }), props.label ? h('span', null, props.label) : null)
      },
      Tooltip: (P && P.Tooltip) || function (props) { return h('span', { title: props.label }, props.children) },
      Tag: (P && P.Tag) || function (props) { return h('span', { className: 'dsh-mailbox-tag', 'data-tone': props.tone }, props.children) },
      StateDot: (P && P.StateDot) || function (props) { return h('span', { className: 'dsh-mailbox-status-dot', 'data-state': props.state }) },
      Modal: (P && P.Modal) || function (props) {
        if (props.open !== true) return null
        return h('div', { style: { position: 'fixed', inset: 0, zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,.35))' } },
          h('div', { role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title, style: { width: 'min(480px,92vw)', background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1))', borderRadius: 14, padding: 20, border: '0.5px solid var(--dsw-alias-border-l3)' } },
            h('h2', { style: { margin: '0 0 6px', fontSize: 15 } }, props.title),
            props.description ? h('p', { style: { margin: '0 0 14px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' } }, props.description) : null,
            props.children,
            props.footer ? h('div', { style: { marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 } }, props.footer) : null))
      },
      Toast: (P && P.Toast) || function (props) {
        return h('div', { role: 'status', style: { padding: '8px 14px', borderRadius: 10, background: 'var(--dsw-alias-toast-bg, #222)', color: 'var(--dsw-alias-toast-label, #fff)', fontSize: 12 } }, props.text)
      },
      DisclosureRow: (P && P.DisclosureRow) || null,
    }

    // ------------------------------------------------------------- 工具函数
    function clone(value) {
      if (value === undefined) return undefined
      try {
        return JSON.parse(JSON.stringify(value))
      } catch (_error) {
        return value
      }
    }
    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }
    function setPath(target, path, value) {
      var next = clone(target)
      var cursor = next
      var parts = path.split('.')
      for (var index = 0; index < parts.length - 1; index += 1) {
        var key = parts[index]
        if (!isRecord(cursor[key])) cursor[key] = {}
        cursor = cursor[key]
      }
      cursor[parts[parts.length - 1]] = value
      return next
    }
    function getPath(target, path, fallbackValue) {
      var cursor = target
      var parts = path.split('.')
      for (var index = 0; index < parts.length; index += 1) {
        if (cursor === undefined || cursor === null) return fallbackValue
        cursor = cursor[parts[index]]
      }
      return cursor === undefined ? fallbackValue : cursor
    }
    function uniqueItems(items) {
      var seen = {}
      var out = []
      items.forEach(function (item) {
        if (item === undefined || item === null || item === '') return
        if (seen[item]) return
        seen[item] = true
        out.push(item)
      })
      return out
    }
    function padTwo(value) {
      return value < 10 ? '0' + String(value) : String(value)
    }
    function formatAbsoluteTime(iso, locale) {
      if (typeof iso !== 'string' || iso === '') return ''
      var date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      try {
        return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
      } catch (_error) {
        return date.toISOString().slice(0, 16).replace('T', ' ')
      }
    }
    function relativeTime(iso, t, locale) {
      if (typeof iso !== 'string' || iso === '') return ''
      var time = Date.parse(iso)
      if (Number.isNaN(time)) return ''
      var delta = Date.now() - time
      if (delta < 60 * 1000) return t('justNow')
      if (delta < 60 * 60 * 1000) return t('minutesAgo', { count: Math.floor(delta / 60000) })
      var date = new Date(time)
      var now = new Date()
      var sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
      if (sameDay) return padTwo(date.getHours()) + ':' + padTwo(date.getMinutes())
      var yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      if (date.getFullYear() === yesterday.getFullYear() && date.getMonth() === yesterday.getMonth() && date.getDate() === yesterday.getDate()) return t('yesterday')
      if (delta < 7 * 24 * 60 * 60 * 1000) return padTwo(date.getMonth() + 1) + '-' + padTwo(date.getDate())
      if (date.getFullYear() === now.getFullYear()) return padTwo(date.getMonth() + 1) + '-' + padTwo(date.getDate())
      return date.getFullYear() + '-' + padTwo(date.getMonth() + 1) + '-' + padTwo(date.getDate())
    }
    function formatBytes(bytes) {
      var value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / 1024 / 1024).toFixed(1) + ' MB'
    }
    function initialOf(name, address) {
      var source = String(name || address || '?').trim()
      return source === '' ? '?' : source.slice(0, 1)
    }
    function shortId(value) {
      var text = String(value === undefined || value === null ? '' : value)
      return text.replace(/^session-/, '').slice(0, 8)
    }
    function validAddress(value) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim())
    }
    function safeHttpUrl(value) {
      try {
        var url = new URL(String(value))
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
      } catch (_error) {
        return ''
      }
    }
    // 附件：与宿主同口径的客户端预检（服务端结果才是权威）。只把 base64 放进
    // mail.send 请求体，不写 localStorage / 日志 / URL；发送后即丢弃。
    var ATTACHMENT_MAX_FILES = 5
    var ATTACHMENT_MAX_FILE_BYTES = 8 * 1024 * 1024
    var ATTACHMENT_MAX_TOTAL_BYTES = 10 * 1024 * 1024
    var ATTACHMENT_BLOCKED_EXT = ['exe', 'bat', 'cmd', 'com', 'ps1', 'psm1', 'js', 'mjs', 'cjs', 'sh', 'bash', 'zsh', 'jar', 'msi', 'lnk', 'scr', 'vbs', 'vbe', 'reg', 'apk', 'dll', 'so', 'dylib', 'app', 'run', 'bin', 'iso', 'hta', 'wsf']
    var ATTACHMENT_BLOCKED_NAMES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'secrets', 'secret', 'auth-code', 'authcode', 'password', 'passwd', 'token', 'credentials', 'credential', '.env']
    var MIME_BY_EXT = {
      pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', xml: 'application/xml',
      doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
      mp3: 'audio/mpeg', mp4: 'video/mp4', wav: 'audio/wav', mov: 'video/quicktime',
    }
    function extensionOf(filename) {
      var name = String(filename || '')
      var index = name.lastIndexOf('.')
      return index < 0 ? '' : name.slice(index + 1).toLowerCase()
    }
    function baseNameOf(filename) {
      var name = String(filename || '')
      return name.replace(/^.*[\\/]/, '')
    }
    function attachmentRejection(filename, size) {
      var base = baseNameOf(filename)
      var lower = base.toLowerCase()
      if (base === '' || base.startsWith('.')) return 'attachmentBlocked'
      if (ATTACHMENT_BLOCKED_NAMES.indexOf(lower) >= 0) return 'attachmentBlocked'
      if (ATTACHMENT_BLOCKED_EXT.indexOf(extensionOf(base)) >= 0) return 'attachmentBlocked'
      if (size === 0) return 'attachmentEmpty'
      if (size > ATTACHMENT_MAX_FILE_BYTES) return 'attachmentTooLarge'
      return ''
    }
    function guessContentType(filename) {
      return MIME_BY_EXT[extensionOf(filename)] || 'application/octet-stream'
    }
    function readFileAsBase64(file) {
      return new Promise(function (resolve, reject) {
        try {
          var reader = new FileReader()
          reader.onload = function () {
            var result = String(reader.result || '')
            var comma = result.indexOf(',')
            resolve(comma < 0 ? '' : result.slice(comma + 1))
          }
          reader.onerror = function () { reject(reader.error || new Error('read failed')) }
          reader.readAsDataURL(file)
        } catch (error) {
          reject(error)
        }
      })
    }

    function extractLinks(html) {
      if (typeof html !== 'string' || html === '' || typeof DOMParser === 'undefined') return []
      var links = []
      try {
        var doc = new DOMParser().parseFromString(html, 'text/html')
        var anchors = doc.querySelectorAll('a[href]')
        for (var index = 0; index < anchors.length && links.length < 10; index += 1) {
          var href = safeHttpUrl(anchors[index].getAttribute('href'))
          if (href === '') continue
          var label = String(anchors[index].textContent || '').trim().slice(0, 120)
          links.push({ href: href, label: label === '' || label === href ? href : label })
        }
      } catch (_error) {
        return []
      }
      return uniqueItems(links.map(function (item) { return item.href })).map(function (href) {
        return links.find(function (item) { return item.href === href })
      }).filter(function (item) { return item !== undefined })
    }

    // ------------------------------------------------------------- 数据层
    function ApiError(code, message, status) {
      this.name = 'ApiError'
      this.code = typeof code === 'string' && code !== '' ? code : 'internal'
      this.message = typeof message === 'string' && message !== '' ? message : '请求失败'
      this.status = status === undefined ? 0 : status
    }
    ApiError.prototype = Object.create(Error.prototype)

    var MOCK_ENABLED = (function detectMock() {
      try {
        if (typeof window !== 'undefined' && window.__DSH_MAILBOX_UI_MOCK__ === true) return true
        if (typeof window !== 'undefined' && window.__DSH_MAILBOX_UI_MOCK__ === false) return false
        if (typeof location !== 'undefined' && /[?&]mock=1(?:&|$)/.test(String(location.search || ''))) return true
      } catch (_error) {
        return false
      }
      return false
    })()

    var apiCursor = { index: 0, locked: false }
    function currentBase() {
      return API_BASES[apiCursor.index] || API_BASES[0]
    }
    function switchBase() {
      if (apiCursor.locked) return false
      if (apiCursor.index + 1 >= API_BASES.length) return false
      apiCursor.index += 1
      apiCursor.locked = true
      return true
    }
    function buildUrl(action, params) {
      var query = '?action=' + encodeURIComponent(action)
      Object.keys(params || {}).forEach(function (key) {
        var value = params[key]
        if (value === undefined || value === null || value === '') return
        if (typeof value === 'boolean') value = value ? 'true' : 'false'
        query += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(String(value))
      })
      return currentBase() + query
    }
    async function realRequest(method, action, params) {
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined
      var timer = controller === undefined ? undefined : setTimeout(function () { controller.abort() }, 30000)
      var init = { method: method, credentials: 'same-origin', headers: { accept: 'application/json' }, signal: controller === undefined ? undefined : controller.signal }
      var url = buildUrl(action, params)
      if (method === 'POST') {
        init.headers['content-type'] = 'application/json'
        init.headers[API_HEADER] = '1'
        init.body = JSON.stringify(Object.assign({ action: action }, params || {}))
      }
      var response
      try {
        response = await fetch(url, init)
      } catch (error) {
        if (timer !== undefined) clearTimeout(timer)
        throw new ApiError('network', '无法连接宿主接口：' + String((error && error.message) || error), 0)
      }
      if (timer !== undefined) clearTimeout(timer)
      if (response.status === 404 || response.status === 405) {
        if (switchBase()) return realRequest(method, action, params)
        throw new ApiError('not-found', '宿主接口不存在（404）：插件后端可能未启用', response.status)
      }
      if (response.status === 401 || response.status === 403) {
        throw new ApiError('forbidden', '未授权访问宿主接口（HTTP ' + response.status + '），请刷新页面重新登录 DSH', response.status)
      }
      var payload = null
      try {
        payload = await response.json()
      } catch (_error) {
        throw new ApiError('internal', '宿主接口返回了非 JSON 响应（HTTP ' + response.status + '）', response.status)
      }
      if (payload && payload.ok === false) {
        var info = payload.error || {}
        throw new ApiError(typeof info.code === 'string' ? info.code : 'internal', typeof info.message === 'string' ? info.message : '操作失败', response.status)
      }
      if (!response.ok) throw new ApiError('internal', '宿主接口错误（HTTP ' + response.status + '）', response.status)
      return payload === null ? {} : payload
    }
    function request(method, action, params) {
      if (MOCK_ENABLED) return mockRequest(method, action, params)
      return realRequest(method, action, params)
    }

    // -------------------------------------------------- 预览数据（mock）层
    // 只在 window.__DSH_MAILBOX_UI_MOCK__ === true 或 URL 带 ?mock=1 时启用，
    // 用于 UI 评审/截图；生产环境走真实宿主接口。数据结构与 lib/service.js 对齐。
    function presetFallback(locale) {
      var zh = locale !== 'en'
      var make = function (id, label, smtp, imap, summary, steps, links, note) {
        return {
          id: id,
          label: label,
          smtp: smtp,
          imap: imap,
          guide: { summary: summary, steps: steps, links: links, note: note },
        }
      }
      return [
        make('qq', 'QQ 邮箱', { host: 'smtp.qq.com', port: 465, security: 'tls' }, { host: 'imap.qq.com', port: 993, security: 'tls' },
          zh ? 'QQ 邮箱需要用「授权码」而不是 QQ 密码登录第三方客户端。' : 'QQ Mail requires an app authorization code instead of your password.',
          zh ? ['登录 QQ 邮箱网页版（mail.qq.com），进入「设置」→「账号与安全」→「安全设置」。', '找到「IMAP/SMTP 服务」，按提示开启。', '点击「生成授权码」，验证后得到 16 位授权码。', '把授权码填入下方「授权码」输入框（只显示一次）。'] : ['Open QQ Mail on the web → Settings → Account → Security.', 'Enable the IMAP/SMTP service.', 'Generate an authorization code (16 characters, shown once).', 'Paste it into the authorization code field below.'],
          [{ label: zh ? 'QQ 邮箱帮助：如何开启 IMAP/SMTP 服务' : 'QQ Mail help: enable IMAP/SMTP', url: 'https://service.mail.qq.com/detail/0/75' }],
          zh ? '收信（IMAP）需要单独开启；只开 SMTP 只能发不能收。' : 'Receiving (IMAP) must be enabled separately from sending.'),
        make('163', '网易 163 邮箱', { host: 'smtp.163.com', port: 465, security: 'tls' }, { host: 'imap.163.com', port: 993, security: 'tls' },
          zh ? '163 邮箱需要开启 IMAP/SMTP 服务并使用「授权密码」。' : '163 Mail requires enabling IMAP/SMTP and an app password.',
          zh ? ['登录 163 邮箱网页版，进入「设置」→「POP3/SMTP/IMAP」。', '开启「IMAP/SMTP 服务」并完成手机验证。', '新增「授权密码」，复制得到的授权码。', '把授权码填入下方输入框。'] : ['Sign in to 163 Mail → Settings → POP3/SMTP/IMAP.', 'Enable IMAP/SMTP and complete phone verification.', 'Create an authorization password.', 'Paste it below.'],
          [{ label: zh ? '163 邮箱帮助中心' : '163 Mail help center', url: 'https://help.mail.163.com/' }],
          zh ? '163 对第三方客户端有安全限制，首次 IMAP 登录需要发送 ID 命令，插件已内置。' : '163 restricts third-party clients; the plugin sends the IMAP ID command automatically.'),
        make('126', '网易 126 邮箱', { host: 'smtp.126.com', port: 465, security: 'tls' }, { host: 'imap.126.com', port: 993, security: 'tls' },
          zh ? '126 邮箱的授权方式与 163 相同。' : '126 Mail uses the same flow as 163.',
          zh ? ['登录 126 邮箱网页版，进入「设置」→「POP3/SMTP/IMAP」。', '开启服务并完成手机验证。', '新增授权密码并复制。', '填入下方输入框。'] : ['Sign in to 126 Mail → Settings → POP3/SMTP/IMAP.', 'Enable the service and verify your phone.', 'Create an authorization password.', 'Paste it below.'],
          [{ label: zh ? '126 邮箱帮助中心' : '126 Mail help center', url: 'https://help.mail.163.com/' }],
          zh ? 'IMAP 登录需要 ID 命令，插件会自动处理。' : 'The plugin handles the IMAP ID command automatically.'),
        make('gmail', 'Gmail', { host: 'smtp.gmail.com', port: 465, security: 'tls' }, { host: 'imap.gmail.com', port: 993, security: 'tls' },
          zh ? 'Gmail 需要「应用专用密码」，普通密码不能用于第三方客户端。' : 'Gmail requires an App Password for third-party clients.',
          zh ? ['在 Google 账号中开启两步验证。', '打开「应用专用密码」页面，创建一个 16 位密码。', '把应用专用密码填入下方授权码。'] : ['Enable 2-step verification in your Google account.', 'Open the App Passwords page and create a 16-character password.', 'Paste it as the authorization code.'],
          [{ label: zh ? 'Google 帮助：应用专用密码' : 'Google help: App Passwords', url: 'https://support.google.com/accounts/answer/185833' }],
          zh ? '若账号启用了「安全性较低的应用访问」，请改用应用专用密码。' : 'Use an App Password rather than your account password.'),
        make('outlook', 'Outlook / Microsoft 365', { host: 'smtp.office365.com', port: 587, security: 'starttls' }, { host: 'outlook.office365.com', port: 993, security: 'tls' },
          zh ? 'Outlook 需要开启两步验证并使用「应用密码」。' : 'Outlook needs 2-step verification and an app password.',
          zh ? ['登录 Microsoft 账号安全页面。', '开启两步验证。', '在「应用密码」中新建密码并复制到下方。'] : ['Sign in to your Microsoft account security page.', 'Enable two-step verification.', 'Create an app password and paste it below.'],
          [{ label: zh ? 'Microsoft 账号安全' : 'Microsoft account security', url: 'https://account.microsoft.com/security' }],
          zh ? '部分组织禁用 SMTP AUTH，需要管理员开启。' : 'Some organizations disable SMTP AUTH; an admin must enable it.'),
        make('icloud', 'iCloud 邮箱', { host: 'smtp.mail.me.com', port: 587, security: 'starttls' }, { host: 'imap.mail.me.com', port: 993, security: 'tls' },
          zh ? 'iCloud 邮箱需要「App 专用密码」。' : 'iCloud Mail requires an app-specific password.',
          zh ? ['登录 Apple ID 账号页面。', '在「登录与安全」中生成 App 专用密码。', '把生成的密码填入下方授权码。'] : ['Sign in to your Apple ID account page.', 'Generate an app-specific password under Sign-In and Security.', 'Paste the password below.'],
          [{ label: zh ? 'Apple 支持：App 专用密码' : 'Apple support: app-specific passwords', url: 'https://support.apple.com/en-us/102654' }],
          zh ? 'iCloud 的 SMTP 使用 587 端口 + STARTTLS。' : 'iCloud SMTP uses port 587 with STARTTLS.'),
        make('custom', '自定义', { host: '', port: 465, security: 'tls' }, { host: '', port: 993, security: 'tls' },
          zh ? '自定义服务器：请向服务商确认 SMTP/IMAP 地址、端口与加密方式。' : 'Custom server: confirm the SMTP/IMAP host, port and security with your provider.',
          zh ? ['在服务商帮助中心查找 SMTP/IMAP 服务器地址。', '确认端口（465/993 通常为 TLS，587/143 通常为 STARTTLS）。', '确认登录方式（授权码或应用密码）。'] : ['Find the SMTP/IMAP host in your provider help center.', 'Confirm the port (465/993 usually TLS; 587/143 usually STARTTLS).', 'Confirm the login method (app password or authorization code).'],
          [],
          zh ? 'TLS=直接加密连接；STARTTLS=先明文再升级加密。' : 'TLS = encrypted from the start; STARTTLS = upgrade after connecting.'),
      ]
    }

    function createMockBackend() {
      var now = Date.now()
      var ago = function (ms) { return new Date(now - ms).toISOString() }
      var config = {
        version: 1,
        enabled: true,
        mailbox: { address: 'figaro1@qq.com', displayName: '费加罗', signature: '费加罗', salutation: '穆再排尔·穆合塔尔：', greeting: '见信好！', subjectPrefix: '[DeepSeek Harness] ', letterhead: true, avatarFile: '' },
        owner: { address: 'mzpr00@163.com', name: '' },
        smtp: { preset: 'qq', host: 'smtp.qq.com', port: 465, security: 'tls', user: 'figaro1@qq.com', authCode: '', authCodeFile: '/home/mzpr00/.dsh/secrets/figaro1-qq-smtp.txt', allowStrangerRecipients: false },
        imap: { enabled: true, preset: 'qq', host: 'imap.qq.com', port: 993, security: 'tls', user: 'figaro1@qq.com', authCode: '', authCodeFile: '', mailbox: 'INBOX', pollIntervalSeconds: 120, markSeen: true, fetchLimit: 20 },
        friends: { policy: 'auto', defaultAutoReply: false },
        notify: { enabled: true, target: 'dedicated', strangerMail: 'notify', batchSeconds: 30, maxPreviewChars: 200, dedicatedSessionId: '' },
        prompt: { language: 'zh', extraNote: '', includeFriendListInSystemPrompt: true, maxFriendListInPrompt: 30 },
        security: { allowRemoteImages: false, maxSendsPerHour: 20, maxFriendAddsPerDay: 3, maxMessageBytes: 5242880, quarantineSuspicious: true, maxMessagesRetained: 500 },
        ui: { locale: 'zh' },
      }
      var secrets = { smtp: { configured: true, source: 'file' }, imap: { configured: true, source: 'file' } }
      var body = function (from, subject, date, text, html, extra) {
        var message = {
          id: 'in-' + Math.random().toString(36).slice(2, 10),
          direction: 'in',
          messageId: '<' + Date.now() + '.' + Math.random().toString(36).slice(2) + '@example.com>',
          from: from,
          to: [{ name: '费加罗', address: 'figaro1@qq.com' }],
          cc: [],
          replyTo: [],
          subject: subject,
          date: date,
          receivedAt: date,
          text: text,
          html: html || '',
          snippet: text.replace(/\s+/g, ' ').slice(0, 120),
          attachments: (extra && extra.attachments) || [],
          headers: { messageId: '<' + Date.now() + '.' + Math.random().toString(36).slice(2) + '@example.com>', inReplyTo: '', references: [] },
          friend: (extra && extra.friend) === true,
          suspicious: (extra && extra.suspicious) === true,
          suspiciousReasons: (extra && extra.reasons) || [],
          automatic: (extra && extra.automatic) === true,
          unread: (extra && extra.unread) !== false,
          threadId: '',
          size: text.length,
          folder: 'inbox',
        }
        message.threadId = message.messageId
        return message
      }
      var sampleHtml = function (paragraphs, withLink) {
        return '<div style="font-family:system-ui,-apple-system,sans-serif;color:#1f2328;line-height:1.7;font-size:14px">' +
          paragraphs.map(function (text) { return '<p style="margin:0 0 12px">' + text + '</p>' }).join('') +
          (withLink ? '<p style="margin:16px 0 0"><a href="https://github.com/deepseek-ai/deepseek-harness">https://github.com/deepseek-ai/deepseek-harness</a></p>' : '') +
          '</div>'
      }
      var messages = [
        body({ name: '林晓', address: 'linxiao@example.com' }, '项目周报：v0.2 进行中', ago(24 * 60 * 1000), '这周的进展：IMAP 收信已经跑通，MIME 解析的 GB18030 分支补了单测。下周计划做通知合并的边界测试。周五前需要你确认一下测试 profile 的端口。', sampleHtml(['这周的进展：IMAP 收信已经跑通，MIME 解析的 GB18030 分支补了单测。', '下周计划做通知合并的边界测试。周五前需要你确认一下测试 profile 的端口。']), { friend: true, unread: true, attachments: [{ filename: '周报-2026-11-12.pdf', contentType: 'application/pdf', size: 245760 }] }),
        body({ name: '仓库通知', address: 'noreply@github.com' }, '[deepseek-harness] PR #482 merged', ago(3 * 60 * 60 * 1000), 'Pull request #482 "fix: slot registry priority" was merged. Review the changes at the pull request page.', sampleHtml(['Pull request #482 "fix: slot registry priority" was merged.', 'Review the changes at the pull request page.']), { automatic: true, unread: true, friend: true }),
        body({ name: '陈默', address: 'chenmo@example.org' }, '周末聚餐', ago(26 * 60 * 60 * 1000), '周六晚上老地方，六点半。能来的回个话，我订位置。', sampleHtml(['周六晚上老地方，六点半。能来的回个话，我订位置。']), { friend: true, unread: false }),
        body({ name: '周雨', address: 'zhouyu@example.com' }, '关于协议里那条引用', ago(2 * 24 * 60 * 60 * 1000), 'In-Reply-To / References 的链路我们只保留最近 10 层，超过 5 层就不自动回复，这个规则写进提示词了吗？', sampleHtml(['In-Reply-To / References 的链路我们只保留最近 10 层，超过 5 层就不自动回复，这个规则写进提示词了吗？']), { friend: true, unread: false }),
        body({ name: '系统通知', address: 'no-reply@accounts.example.net' }, '您的账号已完成安全验证', ago(3 * 24 * 60 * 60 * 1000), '这是一封自动通知邮件，请勿直接回复。如果这不是你的操作，请登录账号中心查看。', sampleHtml(['这是一封自动通知邮件，请勿直接回复。', '如果这不是你的操作，请登录账号中心查看。']), { automatic: true, unread: false }),
        body({ name: '未知发件人', address: 'promo@unknown-mailer.biz' }, '限时优惠：点击领取', ago(4 * 24 * 60 * 60 * 1000), '尊敬的用户，您的账户存在异常，请点击下方链接输入密码验证身份。', sampleHtml(['尊敬的用户，您的账户存在异常，请点击下方链接输入密码验证身份。', '<span style="color:#b42318">（这是一封模拟的可疑邮件：链接不会被自动打开。）</span>'], true), { suspicious: true, unread: false }),
        body({ name: '王简', address: 'wangjian@example.com' }, '文档 review 结果', ago(5 * 24 * 60 * 60 * 1000), 'UI-SPEC 看过了，整体没有问题。建议把「停用态」的文案再明确一点：写清哪些能力停了、怎么恢复。', sampleHtml(['UI-SPEC 看过了，整体没有问题。', '建议把「停用态」的文案再明确一点：写清哪些能力停了、怎么恢复。']), { friend: true, unread: false }),
        body({ name: 'GitHub Security', address: 'security-noreply@github.com' }, '[Security advisory] dependency update', ago(6 * 24 * 60 * 60 * 1000), 'A dependency has a new security advisory. Update your lockfile.', sampleHtml(['A dependency has a new security advisory. Update your lockfile.']), { automatic: true, unread: true, friend: true }),
        body({ name: '李四', address: 'lisi@example.net' }, '转发：会议室改到 B203', ago(7 * 24 * 60 * 60 * 1000), '明天上午的评审改到 B203，时间不变。', sampleHtml(['明天上午的评审改到 B203，时间不变。']), { friend: false, unread: false }),
      ]
      messages[0].date = ago(40 * 60 * 1000)
      messages[1].date = ago(3 * 60 * 60 * 1000)
      var sent = [
        { id: 'out-1', direction: 'out', messageId: '<out-1@dsh.local>', from: { name: '费加罗', address: 'figaro1@qq.com' }, to: [{ name: '林晓', address: 'linxiao@example.com' }], cc: [], replyTo: [], subject: '[DeepSeek Harness] Re: 项目周报：v0.2 进行中', date: ago(20 * 60 * 60 * 1000), receivedAt: ago(20 * 60 * 60 * 1000), text: '收到，端口用 3102。', html: '', snippet: '收到，端口用 3102。', attachments: [], headers: { messageId: '<out-1@dsh.local>', inReplyTo: '', references: [] }, friend: true, suspicious: false, suspiciousReasons: [], automatic: false, unread: false, threadId: '<out-1@dsh.local>', size: 20, folder: 'sent' },
        { id: 'out-2', direction: 'out', messageId: '<out-2@dsh.local>', from: { name: '费加罗', address: 'figaro1@qq.com' }, to: [{ name: '穆再排尔·穆合塔尔', address: 'mzpr00@163.com' }], cc: [], replyTo: [], subject: '[DeepSeek Harness] 插件安装完成报告', date: ago(2 * 24 * 60 * 60 * 1000), receivedAt: ago(2 * 24 * 60 * 60 * 1000), text: '安装完成，测试 profile 已验证。', html: '', snippet: '安装完成，测试 profile 已验证。', attachments: [], headers: { messageId: '<out-2@dsh.local>', inReplyTo: '', references: [] }, friend: false, suspicious: false, suspiciousReasons: [], automatic: false, unread: false, threadId: '<out-2@dsh.local>', size: 30, folder: 'sent' },
      ]
      var quarantine = [
        body({ name: '某营销平台', address: 'news@bulk-sender.example' }, '本周精选：你可能错过的 10 个工具', ago(2 * 24 * 60 * 60 * 1000), '这是一封群发营销邮件，已按陌生人策略放入隔离区。', sampleHtml(['这是一封群发营销邮件，已按陌生人策略放入隔离区。']), { friend: false, unread: true, automatic: true }),
      ]
      quarantine[0].folder = 'quarantine'
      var rowOf = function (message) {
        return {
          id: message.id,
          folder: message.folder,
          direction: message.direction,
          fromName: message.from.name,
          fromAddress: message.from.address,
          toAddresses: (message.to || []).map(function (item) { return item.address }),
          subject: message.subject,
          date: message.date,
          snippet: message.snippet,
          unread: message.unread === true,
          friend: message.friend === true,
          suspicious: message.suspicious === true,
          automatic: message.automatic === true,
          hasAttachments: (message.attachments || []).length > 0,
          threadId: message.threadId,
          attachments: message.attachments,
          messageId: message.messageId,
        }
      }
      var all = messages.concat(sent).concat(quarantine)
      var friendsDoc = {
        version: 1,
        friends: [
          { address: 'linxiao@example.com', name: '林晓', note: '同组前端', reason: '', addedBy: 'user', addedAt: ago(40 * 24 * 60 * 60 * 1000), autoReply: false },
          { address: 'chenmo@example.org', name: '陈默', note: '老同学', reason: '', addedBy: 'user', addedAt: ago(35 * 24 * 60 * 60 * 1000), autoReply: false },
          { address: 'zhouyu@example.com', name: '周雨', note: '协议评审', reason: '来意明确的协议讨论', addedBy: 'ai', addedAt: ago(10 * 24 * 60 * 60 * 1000), autoReply: false },
          { address: 'wangjian@example.com', name: '王简', note: '', reason: '文档 review', addedBy: 'user-approved-ai', addedAt: ago(6 * 24 * 60 * 60 * 1000), autoReply: false },
        ],
        pending: [
          { address: 'zhouyu@example.com', name: '周雨', note: '协议评审', reason: '来信讨论 MIME 解析，来意明确', requestedBy: 'ai', requestedAt: ago(2 * 24 * 60 * 60 * 1000) },
          { address: 'newsletter@example.org', name: '', note: '', reason: '订阅的技术周报', requestedBy: 'ai', requestedAt: ago(6 * 60 * 60 * 1000) },
        ],
        aiAddLog: [{ address: 'zhouyu@example.com', at: ago(10 * 24 * 60 * 60 * 1000), reason: '来意明确的协议讨论', action: 'added' }],
      }
      var lastSyncAt = ago(4 * 60 * 1000)
      var lastError = ''
      var sync = { state: 'idle', lastSyncAt: lastSyncAt, lastError: lastError, uidValidity: 12345, lastUid: 4821 }
      var notifications = { queued: 0, lastDeliveredAt: ago(2 * 60 * 60 * 1000), targets: [] }
      var sessions = [
        { sessionId: 'sess-demo-1', title: 'dsh-mailbox 客户端 UI 实现', updatedAt: ago(5 * 60 * 1000) },
        { sessionId: 'sess-demo-2', title: '邮件引擎单测排查', updatedAt: ago(2 * 60 * 60 * 1000) },
      ]
      var tools = ['send_email', 'mail_list', 'mail_read', 'mail_reply', 'mail_check', 'mail_friend_list', 'mail_friend_add', 'mail_friend_remove', 'mail_status']
      var counts = function () {
        var inbox = all.filter(function (item) { return item.folder === 'inbox' })
        return {
          inbox: inbox.length,
          unread: inbox.filter(function (item) { return item.unread === true }).length,
          quarantine: all.filter(function (item) { return item.folder === 'quarantine' }).length,
          sent: all.filter(function (item) { return item.folder === 'sent' }).length,
          friends: friendsDoc.friends.length,
          pending: friendsDoc.pending.length,
        }
      }
      var maskedConfig = function () {
        var safe = clone(config)
        safe.secrets = clone(secrets)
        return safe
      }
      var connections = function () {
        return {
          smtp: { host: config.smtp.host, port: config.smtp.port, security: config.smtp.security, user: config.smtp.user, configured: secrets.smtp.configured === true, connected: true },
          imap: { host: config.imap.host, port: config.imap.port, security: config.imap.security, user: config.imap.user, configured: secrets.imap.configured === true, connected: true, mailbox: config.imap.mailbox },
        }
      }
      var state = function () {
        return {
          version: '0.1.0',
          enabled: config.enabled === true,
          config: maskedConfig(),
          presets: presetFallback(config.ui.locale),
          connections: connections(),
          sync: clone(sync),
          notifications: clone(notifications),
          counts: counts(),
          friendPolicy: config.friends.policy,
          dataDir: '/home/mzpr00/.dsh/mailbox',
          tools: tools.slice(),
        }
      }
      var diagnostics = function () {
        return {
          version: '0.1.0', node: 'v24.22.2', platform: 'linux', pluginEnabled: config.enabled === true,
          dataDir: '/home/mzpr00/.dsh/mailbox',
          store: { messages: all.length, index: all.length, bytes: 184320, configBytes: 1536, friendsBytes: 1024 },
          sync: clone(sync), notifications: clone(notifications), tools: tools.slice(),
          connections: connections(), secrets: clone(secrets),
        }
      }
      var findMessage = function (id) {
        return all.find(function (item) { return item.id === id })
      }
      return async function mockRequest(method, action, params) {
        await new Promise(function (resolve) { setTimeout(resolve, 160) })
        var data = params || {}
        switch (action) {
          case 'health': return { ok: true, version: '0.1.0', enabled: config.enabled === true, configured: { smtp: true, imap: true, mailbox: true, owner: true }, dataDir: '/home/mzpr00/.dsh/mailbox', capabilities: { send: true, receive: true } }
          case 'state': return state()
          case 'presets': return { locale: config.ui.locale, presets: presetFallback(config.ui.locale) }
          case 'sessions': return { sessions: clone(sessions) }
          case 'diagnostics': return diagnostics()
          case 'messages': {
            var folder = ['inbox', 'sent', 'quarantine', 'all'].indexOf(data.folder) >= 0 ? data.folder : 'inbox'
            var unreadOnly = data.unreadOnly === true || data.unreadOnly === 'true'
            var search = String(data.search || '').trim().toLowerCase()
            var rows = all.filter(function (item) {
              if (folder !== 'all' && item.folder !== folder) return false
              if (unreadOnly && item.unread !== true) return false
              if (search !== '') {
                var haystack = (item.from.name + ' ' + item.from.address + ' ' + item.subject + ' ' + item.snippet).toLowerCase()
                if (haystack.indexOf(search) < 0) return false
              }
              return true
            })
            var limit = Number(data.limit) > 0 ? Math.min(Number(data.limit), 100) : 30
            var offset = Number(data.offset) > 0 ? Number(data.offset) : 0
            return { folder: folder, total: rows.length, unread: counts().unread, messages: rows.slice(offset, offset + limit).map(rowOf) }
          }
          case 'message': {
            var found = findMessage(String(data.id || ''))
            if (found === undefined) throw new ApiError('not-found', '邮件不存在或已被清理')
            return { message: clone(found), row: clone(rowOf(found)) }
          }
          case 'friends': return { policy: config.friends.policy, defaultAutoReply: config.friends.defaultAutoReply, friends: clone(friendsDoc.friends), pending: clone(friendsDoc.pending), aiAddLog: clone(friendsDoc.aiAddLog) }
          case 'message.read': {
            var target = findMessage(String(data.id || ''))
            if (target === undefined) throw new ApiError('not-found', '邮件不存在或已被清理')
            target.unread = data.read !== true
            return { id: target.id, read: !target.unread, row: rowOf(target) }
          }
          case 'message.delete': {
            var index = all.findIndex(function (item) { return item.id === data.id })
            if (index < 0) throw new ApiError('not-found', '邮件不存在或已被清理')
            all.splice(index, 1)
            return { deleted: true, id: data.id }
          }
          case 'mail.send': {
            if (config.enabled !== true) throw new ApiError('forbidden', '插件已停用：请先在邮箱设置里开启插件')
            if (typeof data.content !== 'string' || data.content.trim() === '') throw new ApiError('input-invalid', '正文不能为空')
            var to = String(data.to || config.owner.address)
            if (!validAddress(to)) throw new ApiError('input-invalid', '收件人地址格式不正确')
            var replyTo = data.replyToId === undefined ? null : findMessage(String(data.replyToId))
            var subject = replyTo === null || replyTo === undefined ? String(data.subject || '（无主题）') : ('Re: ' + replyTo.subject.replace(/^Re:\s*/i, ''))
            var outgoing = {
              id: 'out-' + Math.random().toString(36).slice(2, 10), direction: 'out', messageId: '<' + Date.now() + '@dsh.local>',
              from: { name: config.mailbox.displayName, address: config.mailbox.address }, to: [{ name: '', address: to }], cc: [], replyTo: [],
              subject: subject, date: new Date().toISOString(), receivedAt: new Date().toISOString(), text: data.content,
              html: '', snippet: data.content.slice(0, 120), attachments: [],
              headers: { messageId: '<' + Date.now() + '@dsh.local>', inReplyTo: '', references: [] },
              friend: true, suspicious: false, suspiciousReasons: [], automatic: false, unread: false,
              threadId: '<' + Date.now() + '@dsh.local>', size: data.content.length, folder: 'sent',
            }
            var attachmentMeta = Array.isArray(data.attachments) ? data.attachments.slice(0, 5).map(function (item) {
              return { filename: String(item.filename || 'attachment'), contentType: item.contentType || guessContentType(item.filename), size: typeof item.size === 'number' ? item.size : Math.floor(String(item.base64 || '').length * 0.75) }
            }) : []
            outgoing.attachments = attachmentMeta
            outgoing.hasAttachments = attachmentMeta.length > 0
            all.push(outgoing)
            return { id: outgoing.id, from: config.mailbox.address, to: to, subject: subject, messageId: outgoing.messageId, kind: 'friend', replyToId: data.replyToId || null, attachments: attachmentMeta.length }
          }
          case 'sync.now': {
            sync.lastSyncAt = new Date().toISOString()
            sync.lastError = ''
            return { summary: { ok: true, imported: 0, arrivals: [] } }
          }
          case 'notify.test': return { delivered: 1, sessionId: typeof data.sessionId === 'string' ? data.sessionId : 'sess-demo-1' }
          case 'config.save': {
            var patch = isRecord(data.patch) ? data.patch : {}
            var merged = clone(config)
            ;['mailbox', 'owner', 'smtp', 'imap', 'friends', 'notify', 'prompt', 'security', 'ui'].forEach(function (section) {
              if (isRecord(patch[section])) merged[section] = Object.assign({}, merged[section], patch[section])
              else if (patch[section] !== undefined) merged[section] = clone(patch[section])
            })
            if (patch.enabled !== undefined) merged.enabled = patch.enabled === true
            if (patch.version !== undefined) merged.version = patch.version
            config = merged
            var provided = isRecord(data.secrets) ? data.secrets : {}
            if (typeof provided.smtpAuthCode === 'string' && provided.smtpAuthCode.trim() !== '') secrets.smtp = { configured: true, source: 'config' }
            if (typeof provided.imapAuthCode === 'string' && provided.imapAuthCode.trim() !== '') secrets.imap = { configured: true, source: 'config' }
            if (data.clearSecrets === true) {
              secrets.smtp = { configured: false, source: '' }
              secrets.imap = { configured: false, source: '' }
            }
            return { config: maskedConfig(), saved: true }
          }
          case 'config.reset': {
            var defaults = createMockBackendDefaults()
            config = defaults
            return { config: maskedConfig(), reset: true }
          }
          case 'test.smtp': {
            await new Promise(function (resolve) { setTimeout(resolve, 400) })
            if (String(data.host || config.smtp.host) === '') throw new ApiError('not-configured', 'SMTP 未配置：请先填写发信邮箱与服务器')
            return { ok: true, host: data.host || config.smtp.host, port: data.port || config.smtp.port, security: data.security || config.smtp.security, user: data.user || config.smtp.user, message: 'SMTP 连接与认证成功' }
          }
          case 'test.imap': {
            await new Promise(function (resolve) { setTimeout(resolve, 400) })
            if (String(data.host || config.imap.host) === '') throw new ApiError('not-configured', 'IMAP 未配置：请先填写收信邮箱与服务器')
            return { ok: true, host: data.host || config.imap.host, port: data.port || config.imap.port, security: data.security || config.imap.security, user: data.user || config.imap.user, mailbox: config.imap.mailbox, uidValidity: 12345, exists: 8, message: 'IMAP 连接与认证成功' }
          }
          case 'friends.add': {
            var address = String(data.address || '').trim()
            if (!validAddress(address)) throw new ApiError('input-invalid', '请输入有效的邮箱地址')
            if (friendsDoc.friends.some(function (item) { return item.address.toLowerCase() === address.toLowerCase() })) return { status: 'already', address: address }
            friendsDoc.friends.push({ address: address, name: String(data.name || ''), note: String(data.note || ''), addedBy: 'user', addedAt: new Date().toISOString(), autoReply: false })
            return { status: 'added', address: address, message: '已加为好友' }
          }
          case 'friends.remove': {
            var before = friendsDoc.friends.length
            friendsDoc.friends = friendsDoc.friends.filter(function (item) { return item.address.toLowerCase() !== String(data.address || '').toLowerCase() })
            if (friendsDoc.friends.length === before) throw new ApiError('not-found', '该地址不在好友白名单里')
            return { removed: true, address: data.address }
          }
          case 'friends.update': {
            var friend = friendsDoc.friends.find(function (item) { return item.address.toLowerCase() === String(data.address || '').toLowerCase() })
            if (friend === undefined) throw new ApiError('not-found', '该地址不在好友白名单里')
            var patch = isRecord(data.patch) ? data.patch : {}
            if (typeof patch.name === 'string') friend.name = patch.name
            if (typeof patch.note === 'string') friend.note = patch.note
            if (typeof patch.autoReply === 'boolean') friend.autoReply = patch.autoReply
            return { updated: true, friend: clone(friend) }
          }
          case 'friends.approve': {
            var pending = friendsDoc.pending.find(function (item) { return item.address.toLowerCase() === String(data.address || '').toLowerCase() })
            if (pending === undefined) throw new ApiError('not-found', '没有这个待确认申请')
            friendsDoc.pending = friendsDoc.pending.filter(function (item) { return item !== pending })
            friendsDoc.friends.push({ address: pending.address, name: pending.name || '', note: pending.note || '', reason: pending.reason || '', addedBy: 'user-approved-ai', addedAt: new Date().toISOString(), autoReply: false })
            return { approved: true, friend: clone(pending) }
          }
          case 'friends.reject': {
            friendsDoc.pending = friendsDoc.pending.filter(function (item) { return item.address.toLowerCase() !== String(data.address || '').toLowerCase() })
            return { rejected: true, address: data.address }
          }
          case 'data.clear': {
            all.length = 0
            return { cleared: true }
          }
          default:
            throw new ApiError('bad-request', '未知操作：' + action)
        }
      }
    }
    function createMockBackendDefaults() {
      return {
        version: 1,
        enabled: true,
        mailbox: { address: 'figaro1@qq.com', displayName: '费加罗', signature: '费加罗', salutation: '穆再排尔·穆合塔尔：', greeting: '见信好！', subjectPrefix: '[DeepSeek Harness] ', letterhead: true, avatarFile: '' },
        owner: { address: 'mzpr00@163.com', name: '' },
        smtp: { preset: 'qq', host: 'smtp.qq.com', port: 465, security: 'tls', user: 'figaro1@qq.com', authCode: '', authCodeFile: '', allowStrangerRecipients: false },
        imap: { enabled: true, preset: 'qq', host: 'imap.qq.com', port: 993, security: 'tls', user: 'figaro1@qq.com', authCode: '', authCodeFile: '', mailbox: 'INBOX', pollIntervalSeconds: 120, markSeen: true, fetchLimit: 20 },
        friends: { policy: 'auto', defaultAutoReply: false },
        notify: { enabled: true, target: 'dedicated', strangerMail: 'notify', batchSeconds: 30, maxPreviewChars: 200, dedicatedSessionId: '' },
        prompt: { language: 'zh', extraNote: '', includeFriendListInSystemPrompt: true, maxFriendListInPrompt: 30 },
        security: { allowRemoteImages: false, maxSendsPerHour: 20, maxFriendAddsPerDay: 3, maxMessageBytes: 5242880, quarantineSuspicious: true, maxMessagesRetained: 500 },
        ui: { locale: 'zh' },
      }
    }
    var mockBackend = null
    function mockRequest(method, action, params) {
      if (mockBackend === null) mockBackend = createMockBackend()
      return mockBackend(method, action, params)
    }

    // ------------------------------------------------ 未读徽标共享 store
    function createUnreadStore() {
      var listeners = new Set()
      var snapshot = { unread: 0, enabled: true, loading: true, error: '' }
      var timer = null
      var inflight = false
      function emit() {
        listeners.forEach(function (listener) {
          try { listener(snapshot) } catch (_error) { /* 入口组件不应影响页面 */ }
        })
      }
      async function refresh() {
        if (inflight) return
        inflight = true
        try {
          var data = await request('GET', 'state', {})
          var counts = data && data.counts ? data.counts : {}
          snapshot = { unread: Number(counts.unread) > 0 ? Number(counts.unread) : 0, enabled: data.enabled !== false, loading: false, error: '' }
        } catch (error) {
          snapshot = { unread: snapshot.unread, enabled: snapshot.enabled, loading: false, error: String((error && error.message) || error) }
        } finally {
          inflight = false
          emit()
        }
      }
      return {
        getSnapshot: function () { return snapshot },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () { listeners.delete(listener) }
        },
        set: function (unread, enabled) {
          snapshot = { unread: Number(unread) > 0 ? Number(unread) : 0, enabled: enabled !== false, loading: false, error: '' }
          emit()
        },
        refresh: refresh,
        start: function () {
          refresh()
          timer = setInterval(function () {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
            refresh()
          }, UNREAD_POLL_MS)
          if (timer !== null && typeof timer.unref === 'function') timer.unref()
          return function () {
            if (timer !== null) clearInterval(timer)
            timer = null
          }
        },
      }
    }
    var unreadStore = createUnreadStore()
    function useUnread() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(unreadStore.subscribe, unreadStore.getSnapshot, unreadStore.getSnapshot)
      }
      var state = React.useState(unreadStore.getSnapshot())
      React.useEffect(function () {
        return unreadStore.subscribe(function (next) { state[1](next) })
      }, [])
      return state[0]
    }

    // ------------------------------------------------------------- 小部件
    var MAIL_VIEWS = ['inbox', 'sent', 'quarantine']

    function Card(props) {
      return h(
        'div',
        { className: 'dsh-mailbox-card', 'data-danger': props.danger === true ? 'true' : undefined },
        props.title ? h('div', { className: 'dsh-mailbox-card-head' }, h('div', null, h('h3', { className: 'dsh-mailbox-card-title' }, props.title), props.desc ? h('p', { className: 'dsh-mailbox-card-desc' }, props.desc) : null), props.side || null) : null,
        props.children,
      )
    }

    function Field(props) {
      return h(
        'label',
        { className: 'dsh-mailbox-field' },
        h('span', null, props.label),
        props.children,
        props.hint ? h('p', { className: 'dsh-mailbox-field-hint' }, props.hint) : null,
        props.error ? h('p', { className: 'dsh-mailbox-field-error', role: 'alert' }, props.error) : null,
      )
    }

    function EmptyState(props) {
      return h(
        'div',
        { className: 'dsh-mailbox-empty' },
        h('div', { className: 'dsh-mailbox-empty-art', 'aria-hidden': 'true' }, h(Icon, { name: props.icon || 'mail', size: 28 })),
        h('h3', null, props.title),
        props.hint ? h('p', null, props.hint) : null,
        props.actions ? h('div', { className: 'dsh-mailbox-empty-actions' }, props.actions) : null,
      )
    }

    function ErrorView(props) {
      return h(
        'div',
        { className: 'dsh-mailbox-error', role: 'alert' },
        h('h3', null, props.title || props.t('errorTitle')),
        h('p', null, props.message),
        props.hint ? h('p', null, props.hint) : null,
        props.actions || null,
      )
    }

    function SkeletonList(props) {
      var rows = props.rows || 6
      var items = []
      for (var index = 0; index < rows; index += 1) {
        items.push(
          h(
            'div',
            { className: 'dsh-mailbox-skeleton-row', key: index },
            h('div', { className: 'dsh-mailbox-skeleton-block', style: { width: 30, height: 30, borderRadius: 9 } }),
            h(
              'div',
              { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { className: 'dsh-mailbox-skeleton-line', style: { width: '52%' } }),
              h('div', { className: 'dsh-mailbox-skeleton-line', style: { width: '78%' } }),
              h('div', { className: 'dsh-mailbox-skeleton-line', style: { width: '64%', opacity: 0.7 } }),
            ),
          ),
        )
      }
      return h('div', { className: 'dsh-mailbox-skeleton', 'aria-busy': 'true', 'aria-label': props.label || 'loading' }, items)
    }

    function SkeletonReader(props) {
      return h(
        'div',
        { className: 'dsh-mailbox-skeleton', 'aria-busy': 'true' },
        h('div', { className: 'dsh-mailbox-skeleton-line', style: { width: '48%', height: 16 } }),
        h('div', { className: 'dsh-mailbox-skeleton-line', style: { width: '30%' } }),
        h('div', { style: { height: 10 } }),
        h('div', { className: 'dsh-mailbox-skeleton-line', style: { width: '96%' } }),
        h('div', { className: 'dsh-mailbox-skeleton-line', style: { width: '92%' } }),
        h('div', { className: 'dsh-mailbox-skeleton-line', style: { width: '88%' } }),
        h('div', { className: 'dsh-mailbox-skeleton-line', style: { width: '60%' } }),
        h('div', { style: { height: 10 } }),
        h('div', { className: 'dsh-mailbox-skeleton-line', style: { width: '94%' } }),
        h('div', { className: 'dsh-mailbox-skeleton-line', style: { width: '76%' } }),
      )
    }

    function ToastStack(props) {
      if (props.toasts.length === 0) return null
      return h(
        'div',
        { className: 'dsh-mailbox-toasts', 'aria-live': 'polite' },
        props.toasts.map(function (toast) {
          return h(UI.Toast, {
            key: toast.id,
            text: toast.text,
            tone: toast.tone === 'error' ? undefined : toast.tone,
            icon: toast.tone === 'error' ? h(Icon, { name: 'warning', size: 14 }) : undefined,
            onDone: function () { props.onDone(toast.id) },
          })
        }),
      )
    }

    function ConfirmDialog(props) {
      var confirmRef = React.useRef(null)
      React.useEffect(function () {
        if (props.open !== true) return undefined
        var timer = setTimeout(function () {
          if (confirmRef.current !== null) confirmRef.current.focus()
        }, 30)
        return function () { clearTimeout(timer) }
      }, [props.open])
      if (props.open !== true) return null
      return h(UI.Modal, {
        open: true,
        title: props.title,
        description: props.body,
        closeLabel: props.t('cancel'),
        onClose: props.busy === true ? function () {} : props.onCancel,
        footer: h(
          'div',
          { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' } },
          h(UI.Button, { variant: 'outline', onClick: props.onCancel, disabled: props.busy === true }, props.cancelLabel || props.t('cancel')),
          h('span', { ref: confirmRef, tabIndex: -1 }, h(UI.Button, { variant: props.danger === false ? 'primary' : 'primary', onClick: props.onConfirm, disabled: props.busy === true }, props.busy === true ? h(Spinner, { size: 12 }) : null, ' ', props.confirmLabel || props.t('confirm'))),
        ),
        children: props.children || null,
      })
    }

    // ------------------------------------------------------------- 控制器
    function formFromConfig(config) {
      var source = config || {}
      var form = clone(source)
      form.secretsInput = { smtpAuthCode: '', imapAuthCode: '' }
      form.clearSecrets = false
      if (!isRecord(form.mailbox)) form.mailbox = {}
      if (!isRecord(form.owner)) form.owner = {}
      if (!isRecord(form.smtp)) form.smtp = {}
      if (!isRecord(form.imap)) form.imap = {}
      if (!isRecord(form.friends)) form.friends = {}
      if (!isRecord(form.notify)) form.notify = {}
      if (!isRecord(form.prompt)) form.prompt = {}
      if (!isRecord(form.security)) form.security = {}
      if (!isRecord(form.ui)) form.ui = { locale: 'zh' }
      return form
    }

    function useMailboxController() {
      var [snapshot, setSnapshot] = React.useState({ status: 'loading', data: null, error: '' })
      var [view, setView] = React.useState('inbox')
      var [listState, setListState] = React.useState({ status: 'idle', folder: 'inbox', total: 0, unread: 0, rows: [], error: '', unreadOnly: false, search: '' })
      var [searchInput, setSearchInput] = React.useState('')
      var [search, setSearch] = React.useState('')
      var [unreadOnly, setUnreadOnly] = React.useState(false)
      var [selectedId, setSelectedId] = React.useState('')
      var [reader, setReader] = React.useState({ status: 'idle', message: null, row: null, error: '' })
      var [composer, setComposer] = React.useState(null)
      var [busy, setBusy] = React.useState({})
      var [toasts, setToasts] = React.useState([])
      var [confirmState, setConfirmState] = React.useState(null)
      var [form, setForm] = React.useState(null)
      var [formDirty, setFormDirty] = React.useState(false)
      var [formErrors, setFormErrors] = React.useState({})
      var [testResults, setTestResults] = React.useState({ smtp: { status: 'idle', message: '' }, imap: { status: 'idle', message: '' } })
      var [friendsState, setFriendsState] = React.useState({ status: 'idle', data: null, error: '' })
      var [diagState, setDiagState] = React.useState({ status: 'idle', data: null, error: '' })
      var [sessions, setSessions] = React.useState([])
      var [presets, setPresets] = React.useState([])
      var [friendForm, setFriendForm] = React.useState({ address: '', name: '', note: '', error: '', busy: false })
      var [clearConfirmInput, setClearConfirmInput] = React.useState('')
      var [notifyTestResult, setNotifyTestResult] = React.useState(null)
      var toastSeq = React.useRef(0)
      var mounted = React.useRef(true)
      React.useEffect(function () {
        mounted.current = true
        return function () { mounted.current = false }
      }, [])

      function pushToast(tone, text) {
        toastSeq.current += 1
        var id = toastSeq.current
        setToasts(function (prev) { return prev.concat([{ id: id, tone: tone, text: text }]) })
        var toastTimer = setTimeout(function () {
          setToasts(function (prev) { return prev.filter(function (item) { return item.id !== id }) })
        }, 4200)
        if (toastTimer !== null && typeof toastTimer.unref === 'function') toastTimer.unref()
      }
      function dismissToast(id) {
        setToasts(function (prev) { return prev.filter(function (item) { return item.id !== id }) })
      }
      function setBusyFlag(key, value) {
        setBusy(function (prev) {
          var next = Object.assign({}, prev)
          if (value === true) next[key] = true
          else delete next[key]
          return next
        })
      }
      function updateUnread(delta) {
        setSnapshot(function (prev) {
          if (prev.data === null || !isRecord(prev.data.counts)) return prev
          var counts = Object.assign({}, prev.data.counts)
          var next = Math.max(0, Number(counts.unread) + delta)
          counts.unread = next
          unreadStore.set(next, prev.data.enabled !== false)
          return { status: prev.status, data: Object.assign({}, prev.data, { counts: counts }), error: prev.error }
        })
      }
      function askConfirm(options) {
        setConfirmState(options)
      }
      function closeConfirm() {
        setConfirmState(null)
      }

      function applySnapshot(data) {
        setSnapshot({ status: 'ready', data: data, error: '' })
        var counts = data && data.counts ? data.counts : {}
        unreadStore.set(counts.unread, data.enabled !== false)
        if (Array.isArray(data.presets) && data.presets.length > 0) setPresets(data.presets)
        setForm(function (prev) {
          if (prev !== null && !optionsResetForm.current) return prev
          optionsResetForm.current = false
          return formFromConfig(data.config)
        })
      }
      var optionsResetForm = React.useRef(true)

      async function refreshSnapshot(options) {
        var quiet = options && options.quiet === true
        if (!quiet) {
          setSnapshot(function (prev) { return prev.data === null ? prev : { status: prev.status, data: prev.data, error: '' } })
        }
        try {
          var stateData = await request('GET', 'state', {})
          var friendsData = null
          var sessionsData = null
          try { friendsData = await request('GET', 'friends', {}) } catch (_error) { friendsData = null }
          try { sessionsData = await request('GET', 'sessions', {}) } catch (_error) { sessionsData = null }
          if (!mounted.current) return
          setSnapshot({ status: 'ready', data: stateData, error: '' })
          var counts = stateData && stateData.counts ? stateData.counts : {}
          unreadStore.set(counts.unread, stateData.enabled !== false)
          if (Array.isArray(stateData.presets) && stateData.presets.length > 0) setPresets(stateData.presets)
          if (friendsData !== null) setFriendsState({ status: 'ready', data: friendsData, error: '' })
          else setFriendsState(function (prev) { return prev.status === 'ready' ? prev : { status: 'error', data: null, error: '好友列表加载失败' } })
          if (sessionsData !== null && Array.isArray(sessionsData.sessions)) setSessions(sessionsData.sessions)
          if (!quiet) {
            setForm(function (prev) {
              if (prev !== null && optionsResetForm.current !== true) return prev
              optionsResetForm.current = false
              return formFromConfig(stateData.config)
            })
          }
        } catch (error) {
          if (!mounted.current) return
          setSnapshot({ status: 'error', data: null, error: String((error && error.message) || error) })
        }
      }

      async function loadList(overrides) {
        var options = overrides || {}
        var folder = MAIL_VIEWS.indexOf(options.folder) >= 0 ? options.folder : (MAIL_VIEWS.indexOf(view) >= 0 ? view : 'inbox')
        var query = options.search !== undefined ? options.search : search
        var onlyUnread = options.unreadOnly !== undefined ? options.unreadOnly : unreadOnly
        if (options.background !== true) {
          setListState(function (prev) { return Object.assign({}, prev, { status: 'loading', error: '', folder: folder }) })
        }
        try {
          var data = await request('GET', 'messages', { folder: folder, limit: 50, offset: 0, search: query, unreadOnly: onlyUnread === true })
          if (!mounted.current) return
          setListState({ status: 'ready', folder: data.folder || folder, total: Number(data.total) || 0, unread: Number(data.unread) || 0, rows: Array.isArray(data.messages) ? data.messages : [], error: '', unreadOnly: onlyUnread === true, search: query })
        } catch (error) {
          if (!mounted.current) return
          setListState(function (prev) { return Object.assign({}, prev, { status: 'error', error: String((error && error.message) || error), folder: folder }) })
        }
      }

      React.useEffect(function () {
        refreshSnapshot()
      }, [])

      React.useEffect(function () {
        var timer = setTimeout(function () { setSearch(searchInput.trim()) }, SEARCH_DEBOUNCE_MS)
        return function () { clearTimeout(timer) }
      }, [searchInput])

      React.useEffect(function () {
        if (MAIL_VIEWS.indexOf(view) < 0) return
        loadList({ folder: view })
      }, [view, search, unreadOnly])

      async function openMessage(id) {
        if (typeof id !== 'string' || id === '') return
        setSelectedId(id)
        setReader({ status: 'loading', message: null, row: null, error: '' })
        try {
          var data = await request('GET', 'message', { id: id })
          if (!mounted.current) return
          var message = data.message || null
          var row = data.row || null
          setReader({ status: 'ready', message: message, row: row, error: '' })
          if (row !== null && row.unread === true) await markRead(id, true, { silent: true, quietToast: true })
        } catch (error) {
          if (!mounted.current) return
          setReader({ status: 'error', message: null, row: null, error: String((error && error.message) || error) })
        }
      }
      function closeReader() {
        setSelectedId('')
        setReader({ status: 'idle', message: null, row: null, error: '' })
      }
      async function markRead(id, read, options) {
        var opts = options || {}
        try {
          var data = await request('POST', 'message.read', { id: id, read: read })
          if (!mounted.current) return
          var row = data.row || null
          setListState(function (prev) {
            return Object.assign({}, prev, {
              rows: prev.rows.map(function (item) {
                if (item.id !== id) return item
                return Object.assign({}, item, { unread: row !== null && row.unread !== undefined ? row.unread === true : read !== true })
              }),
            })
          })
          setReader(function (prev) {
            if (prev.row === null) return prev
            return Object.assign({}, prev, { row: Object.assign({}, prev.row, { unread: read !== true }) })
          })
          if (opts.quietToast !== true) pushToast('success', read === true ? tGlobal('markedRead') : tGlobal('markedUnread'))
        } catch (error) {
          pushToast('error', String((error && error.message) || error))
        }
      }
      function toggleRead() {
        if (reader.row === null) return
        markRead(reader.row.id, reader.row.unread === true)
      }
      async function deleteMessage(id) {
        setBusyFlag('delete', true)
        try {
          await request('POST', 'message.delete', { id: id })
          if (!mounted.current) return
          pushToast('success', tGlobal('deleteDone'))
          closeReader()
          loadList({ background: true })
          refreshSnapshot({ quiet: true })
        } catch (error) {
          pushToast('error', String((error && error.message) || error))
        } finally {
          setBusyFlag('delete', false)
        }
      }
      function openComposer(init) {
        setComposer(Object.assign({ title: '', to: '', subject: '', content: '', replyToId: '', mode: 'new', attachments: [] }, init || {}))
      }
      function closeComposer() {
        setComposer(null)
      }
      function updateComposer(patch) {
        setComposer(function (prev) { return prev === null ? prev : Object.assign({}, prev, patch) })
      }
      async function sendComposer() {
        if (composer === null) return
        if (String(composer.to || '').trim() === '') { pushToast('error', tGlobal('toRequired')); return }
        if (!validAddress(composer.to)) { pushToast('error', tGlobal('toInvalid')); return }
        if (String(composer.content || '').trim() === '') { pushToast('error', tGlobal('contentRequired')); return }
        setBusyFlag('send', true)
        try {
          var payload = { to: String(composer.to).trim(), subject: String(composer.subject || '').trim(), content: String(composer.content).trim() }
          if (composer.replyToId !== '') payload.replyToId = composer.replyToId
          var attachments = Array.isArray(composer.attachments) ? composer.attachments : []
          if (attachments.length > 0) {
            payload.attachments = attachments.map(function (item) {
              return { filename: item.filename, contentType: item.contentType, base64: item.base64 }
            })
          }
          await request('POST', 'mail.send', payload)
          if (!mounted.current) return
          pushToast('success', attachments.length > 0 ? tGlobal('sendDoneWithAttachments', { count: attachments.length }) : tGlobal('sendDone'))
          setComposer(null)
          if (view === 'sent') loadList({ background: true })
          refreshSnapshot({ quiet: true })
        } catch (error) {
          pushToast('error', tGlobal('sendFailed') + '：' + String((error && error.message) || error))
        } finally {
          setBusyFlag('send', false)
        }
      }

      function addComposerAttachments(fileList) {
        if (composer === null) return
        var files = Array.prototype.slice.call(fileList || []).filter(function (file) { return file && typeof file.size === 'number' })
        if (files.length === 0) return
        var next = composer.attachments ? composer.attachments.slice() : []
        if (next.length + files.length > ATTACHMENT_MAX_FILES) { pushToast('error', tGlobal('attachmentTooMany')); return }
        var totalBytes = next.reduce(function (sum, item) { return sum + Number(item.size || 0) }, 0)
        var pending = files.length
        var failed = false
        files.forEach(function (file) {
          var rejection = attachmentRejection(file.name, file.size)
          if (rejection !== '') {
            pushToast('error', tGlobal(rejection, { name: file.name }))
            pending -= 1
            return
          }
          totalBytes += file.size
          if (totalBytes > ATTACHMENT_MAX_TOTAL_BYTES) {
            pushToast('error', tGlobal('attachmentTotalTooLarge'))
            pending -= 1
            return
          }
          readFileAsBase64(file).then(function (base64) {
            if (base64 === '') { pushToast('error', tGlobal('attachmentReadFailed', { name: file.name })); return }
            setComposer(function (prev) {
              if (prev === null) return prev
              var list = (prev.attachments || []).slice()
              list.push({
                filename: baseNameOf(file.name),
                contentType: file.type || guessContentType(file.name),
                size: file.size,
                base64: base64,
              })
              return Object.assign({}, prev, { attachments: list })
            })
          }).catch(function () {
            pushToast('error', tGlobal('attachmentReadFailed', { name: file.name }))
          })
        })
      }
      function removeComposerAttachment(index) {
        setComposer(function (prev) {
          if (prev === null) return prev
          var list = (prev.attachments || []).slice()
          list.splice(index, 1)
          return Object.assign({}, prev, { attachments: list })
        })
      }

      function initForm(config) {
        optionsResetForm.current = false
        setForm(formFromConfig(config))
        setFormDirty(false)
        setFormErrors({})
      }
      function updateField(path, value) {
        setForm(function (prev) { return prev === null ? prev : setPath(prev, path, value) })
        setFormDirty(true)
      }
      function updateSecret(kind, value) {
        setForm(function (prev) {
          if (prev === null) return prev
          var next = clone(prev)
          next.secretsInput[kind] = value
          return next
        })
        setFormDirty(true)
      }
      function applyPreset(id) {
        var preset = null
        for (var index = 0; index < presets.length; index += 1) if (presets[index].id === id) preset = presets[index]
        if (preset === null && id !== 'custom') return
        setForm(function (prev) {
          if (prev === null) return prev
          var next = clone(prev)
          next.smtp = Object.assign({}, next.smtp, { preset: id })
          next.imap = Object.assign({}, next.imap, { preset: id })
          if (preset !== null && preset.smtp) {
            next.smtp.host = preset.smtp.host
            next.smtp.port = preset.smtp.port
            next.smtp.security = preset.smtp.security
          }
          if (preset !== null && preset.imap) {
            next.imap.host = preset.imap.host
            next.imap.port = preset.imap.port
            next.imap.security = preset.imap.security
          }
          return next
        })
        setFormDirty(true)
      }
      function validateForm(current) {
        var errors = {}
        if (current === null) return errors
        var mailboxAddress = String(getPath(current, 'mailbox.address', '')).trim()
        if (mailboxAddress !== '' && !validAddress(mailboxAddress)) errors['mailbox.address'] = tGlobal('toInvalid')
        var ownerAddress = String(getPath(current, 'owner.address', '')).trim()
        if (ownerAddress !== '' && !validAddress(ownerAddress)) errors['owner.address'] = tGlobal('toInvalid')
        var smtpPort = Number(getPath(current, 'smtp.port', 0))
        if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) errors['smtp.port'] = tGlobal('fieldIssues', { fields: 'smtp.port' })
        var imapPort = Number(getPath(current, 'imap.port', 0))
        if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535) errors['imap.port'] = tGlobal('fieldIssues', { fields: 'imap.port' })
        return errors
      }
      function buildPatch(current) {
        return {
          mailbox: { address: getPath(current, 'mailbox.address', ''), displayName: getPath(current, 'mailbox.displayName', ''), signature: getPath(current, 'mailbox.signature', ''), salutation: getPath(current, 'mailbox.salutation', ''), greeting: getPath(current, 'mailbox.greeting', ''), subjectPrefix: getPath(current, 'mailbox.subjectPrefix', ''), letterhead: getPath(current, 'mailbox.letterhead', true) === true },
          owner: { address: getPath(current, 'owner.address', ''), name: getPath(current, 'owner.name', '') },
          smtp: { preset: getPath(current, 'smtp.preset', 'qq'), host: getPath(current, 'smtp.host', ''), port: Number(getPath(current, 'smtp.port', 465)), security: getPath(current, 'smtp.security', 'tls'), user: getPath(current, 'smtp.user', ''), allowStrangerRecipients: getPath(current, 'smtp.allowStrangerRecipients', false) === true },
          imap: { enabled: getPath(current, 'imap.enabled', true) === true, preset: getPath(current, 'imap.preset', 'qq'), host: getPath(current, 'imap.host', ''), port: Number(getPath(current, 'imap.port', 993)), security: getPath(current, 'imap.security', 'tls'), user: getPath(current, 'imap.user', ''), mailbox: getPath(current, 'imap.mailbox', 'INBOX'), pollIntervalSeconds: Number(getPath(current, 'imap.pollIntervalSeconds', 120)), markSeen: getPath(current, 'imap.markSeen', true) === true, fetchLimit: Number(getPath(current, 'imap.fetchLimit', 20)) },
          friends: { policy: getPath(current, 'friends.policy', 'auto'), defaultAutoReply: getPath(current, 'friends.defaultAutoReply', false) === true },
          notify: { enabled: getPath(current, 'notify.enabled', true) === true, target: getPath(current, 'notify.target', 'dedicated'), strangerMail: getPath(current, 'notify.strangerMail', 'notify'), batchSeconds: Number(getPath(current, 'notify.batchSeconds', 30)), maxPreviewChars: Number(getPath(current, 'notify.maxPreviewChars', 200)) },
          prompt: { language: getPath(current, 'prompt.language', 'zh'), extraNote: getPath(current, 'prompt.extraNote', ''), includeFriendListInSystemPrompt: getPath(current, 'prompt.includeFriendListInSystemPrompt', true) === true, maxFriendListInPrompt: Number(getPath(current, 'prompt.maxFriendListInPrompt', 30)) },
          security: { allowRemoteImages: getPath(current, 'security.allowRemoteImages', false) === true, maxSendsPerHour: Number(getPath(current, 'security.maxSendsPerHour', 20)), maxFriendAddsPerDay: Number(getPath(current, 'security.maxFriendAddsPerDay', 3)), quarantineSuspicious: getPath(current, 'security.quarantineSuspicious', true) === true, maxMessagesRetained: Number(getPath(current, 'security.maxMessagesRetained', 500)) },
          ui: { locale: getPath(current, 'ui.locale', 'zh') },
        }
      }
      async function saveSettings() {
        if (form === null) return
        var errors = validateForm(form)
        setFormErrors(errors)
        if (Object.keys(errors).length > 0) return
        setBusyFlag('save', true)
        try {
          var payload = { action: 'config.save', patch: buildPatch(form) }
          var secretsPayload = {}
          if (typeof form.secretsInput.smtpAuthCode === 'string' && form.secretsInput.smtpAuthCode.trim() !== '') secretsPayload.smtpAuthCode = form.secretsInput.smtpAuthCode.trim()
          if (typeof form.secretsInput.imapAuthCode === 'string' && form.secretsInput.imapAuthCode.trim() !== '') secretsPayload.imapAuthCode = form.secretsInput.imapAuthCode.trim()
          if (Object.keys(secretsPayload).length > 0) payload.secrets = secretsPayload
          if (form.clearSecrets === true) payload.clearSecrets = true
          var data = await request('POST', 'config.save', payload)
          if (!mounted.current) return
          if (data.config !== undefined) {
            setSnapshot(function (prev) { return prev.data === null ? prev : { status: 'ready', data: Object.assign({}, prev.data, { config: data.config, enabled: data.config.enabled !== false }), error: '' } })
            optionsResetForm.current = true
            initForm(data.config)
            unreadStore.set(getPath(snapshot, 'data.counts.unread', 0), data.config.enabled !== false)
          }
          pushToast('success', tGlobal('saveDone'))
          refreshSnapshot({ quiet: true })
        } catch (error) {
          pushToast('error', tGlobal('saveFailed') + '：' + String((error && error.message) || error))
        } finally {
          setBusyFlag('save', false)
        }
      }
      async function resetSettings() {
        setBusyFlag('reset', true)
        try {
          var data = await request('POST', 'config.reset', {})
          if (!mounted.current) return
          if (data.config !== undefined) {
            optionsResetForm.current = true
            initForm(data.config)
          }
          pushToast('success', tGlobal('resetDone'))
          refreshSnapshot({ quiet: true })
        } catch (error) {
          pushToast('error', String((error && error.message) || error))
        } finally {
          setBusyFlag('reset', false)
        }
      }
      async function masterSwitch(next) {
        setBusyFlag('master', true)
        try {
          await request('POST', 'config.save', { patch: { enabled: next === true } })
          if (!mounted.current) return
          pushToast('success', tGlobal('masterChanged'))
          optionsResetForm.current = true
          await refreshSnapshot()
        } catch (error) {
          pushToast('error', String((error && error.message) || error))
        } finally {
          setBusyFlag('master', false)
        }
      }
      async function testConnection(kind) {
        if (form === null) return
        var section = kind === 'smtp' ? 'smtp' : 'imap'
        var connection = {
          host: getPath(form, section + '.host', ''),
          port: Number(getPath(form, section + '.port', kind === 'smtp' ? 465 : 993)),
          security: getPath(form, section + '.security', 'tls'),
          user: getPath(form, section + '.user', ''),
        }
        var code = form.secretsInput[section === 'smtp' ? 'smtpAuthCode' : 'imapAuthCode']
        if (typeof code === 'string' && code.trim() !== '') connection.authCode = code.trim()
        setTestResults(function (prev) { return Object.assign({}, prev, { [kind]: { status: 'testing', message: '' } }) })
        var startedAt = Date.now()
        try {
          var data = await request('POST', 'test.' + kind, connection)
          if (!mounted.current) return
          setTestResults(function (prev) { return Object.assign({}, prev, { [kind]: { status: 'ok', message: (data.message || tGlobal('testOk')) + '（' + Math.max(1, Math.round((Date.now() - startedAt) / 100)) / 10 + 's）' } }) })
        } catch (error) {
          if (!mounted.current) return
          setTestResults(function (prev) { return Object.assign({}, prev, { [kind]: { status: 'error', message: String((error && error.message) || error) } }) })
        }
      }
      async function syncNow() {
        setBusyFlag('sync', true)
        try {
          var data = await request('POST', 'sync.now', {})
          if (!mounted.current) return
          var imported = data && data.summary && Number(data.summary.imported) > 0 ? Number(data.summary.imported) : 0
          pushToast('success', imported > 0 ? tGlobal('syncDone') + '：' + imported : tGlobal('syncNothing'))
          loadList({ background: true })
          refreshSnapshot({ quiet: true })
        } catch (error) {
          pushToast('error', String((error && error.message) || error))
        } finally {
          setBusyFlag('sync', false)
        }
      }
      async function notifyTest(sessionId) {
        setBusyFlag('notifyTest', true)
        setNotifyTestResult(null)
        try {
          var payload = {}
          if (typeof sessionId === 'string' && sessionId !== '') payload.sessionId = sessionId
          var data = await request('POST', 'notify.test', payload)
          if (!mounted.current) return
          var deliveredId = data && typeof data.sessionId === 'string' ? data.sessionId : ''
          var dedicated = getPath(snapshot, 'data.config.notify.target', '') === 'dedicated'
          var delivered = data ? data.delivered === true : false
          var message = delivered !== true
            ? tGlobal('notifyTestFailed')
            : deliveredId === ''
              ? tGlobal('diagNotifySent')
              : dedicated
                ? tGlobal('notifyTestDedicated', { id: shortId(deliveredId) })
                : tGlobal('notifyTestDelivered', { id: shortId(deliveredId) })
          setNotifyTestResult({ delivered: delivered, sessionId: deliveredId, message: message })
          pushToast('success', message)
          refreshSnapshot({ quiet: true })
        } catch (error) {
          if (!mounted.current) return
          setNotifyTestResult({ delivered: false, sessionId: '', message: String((error && error.message) || error) })
          pushToast('error', String((error && error.message) || error))
        } finally {
          setBusyFlag('notifyTest', false)
        }
      }
      async function clearData() {
        setBusyFlag('clearData', true)
        try {
          await request('POST', 'data.clear', {})
          if (!mounted.current) return
          pushToast('success', tGlobal('diagCleared'))
          closeReader()
          loadList({ background: true })
          refreshSnapshot({ quiet: true })
        } catch (error) {
          pushToast('error', String((error && error.message) || error))
        } finally {
          setBusyFlag('clearData', false)
        }
      }
      async function loadFriends() {
        setFriendsState(function (prev) { return Object.assign({}, prev, { status: prev.data === null ? 'loading' : prev.status, error: '' }) })
        try {
          var data = await request('GET', 'friends', {})
          if (!mounted.current) return
          setFriendsState({ status: 'ready', data: data, error: '' })
        } catch (error) {
          if (!mounted.current) return
          setFriendsState({ status: 'error', data: null, error: String((error && error.message) || error) })
        }
      }
      async function loadDiagnostics() {
        setDiagState(function (prev) { return Object.assign({}, prev, { status: 'loading', error: '' }) })
        try {
          var data = await request('GET', 'diagnostics', {})
          if (!mounted.current) return
          setDiagState({ status: 'ready', data: data, error: '' })
        } catch (error) {
          if (!mounted.current) return
          setDiagState({ status: 'error', data: null, error: String((error && error.message) || error) })
        }
      }
      async function addFriend(address, name, note) {
        setFriendForm(function (prev) { return Object.assign({}, prev, { busy: true, error: '' }) })
        try {
          var data = await request('POST', 'friends.add', { address: address, name: name, note: note })
          if (!mounted.current) return
          var message = data && data.status === 'already' ? tGlobal('alreadyFriend') : tGlobal('added')
          pushToast('success', message)
          setFriendForm({ address: '', name: '', note: '', error: '', busy: false })
          loadFriends()
          refreshSnapshot({ quiet: true })
        } catch (error) {
          if (!mounted.current) return
          setFriendForm(function (prev) { return Object.assign({}, prev, { busy: false, error: String((error && error.message) || error) }) })
        }
      }
      async function removeFriend(address) {
        try {
          await request('POST', 'friends.remove', { address: address })
          if (!mounted.current) return
          pushToast('success', tGlobal('removeDone'))
          loadFriends()
          refreshSnapshot({ quiet: true })
        } catch (error) {
          pushToast('error', String((error && error.message) || error))
        }
      }
      async function updateFriend(address, patch) {
        try {
          await request('POST', 'friends.update', { address: address, patch: patch })
          if (!mounted.current) return
          loadFriends()
        } catch (error) {
          pushToast('error', String((error && error.message) || error))
        }
      }
      async function decideFriend(address, approve) {
        try {
          await request('POST', approve === true ? 'friends.approve' : 'friends.reject', { address: address })
          if (!mounted.current) return
          pushToast('success', approve === true ? tGlobal('approveDone') : tGlobal('rejectDone'))
          loadFriends()
          refreshSnapshot({ quiet: true })
        } catch (error) {
          pushToast('error', String((error && error.message) || error))
        }
      }
      function copyText(text) {
        var value = String(text || '')
        if (value === '') return
        var finish = function () { pushToast('success', tGlobal('copied')) }
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(value).then(finish).catch(function () { pushToast('error', tGlobal('copied')) })
          return
        }
        pushToast('error', tGlobal('copied'))
      }
      function addFriendFromMessage(row) {
        if (row === null) return
        var address = row.fromAddress || ''
        if (address === '') return
        var name = row.fromName || ''
        askConfirm({
          title: tGlobal('addFriend'),
          body: address,
          confirmLabel: tGlobal('addFriend'),
          danger: false,
          run: function () { return addFriend(address, name, '') },
        })
      }

      function selectView(next) {
        setView(next)
        if (MAIL_VIEWS.indexOf(next) < 0) {
          closeReader()
        } else {
          closeReader()
        }
        if (next === 'friends' && friendsState.data === null) loadFriends()
        if (next === 'diagnostics') loadDiagnostics()
      }

      return {
        snapshot: snapshot,
        view: view,
        selectView: selectView,
        listState: listState,
        searchInput: searchInput,
        setSearchInput: setSearchInput,
        search: search,
        unreadOnly: unreadOnly,
        setUnreadOnly: setUnreadOnly,
        selectedId: selectedId,
        reader: reader,
        openMessage: openMessage,
        closeReader: closeReader,
        toggleRead: toggleRead,
        deleteMessage: deleteMessage,
        composer: composer,
        openComposer: openComposer,
        closeComposer: closeComposer,
        updateComposer: updateComposer,
        sendComposer: sendComposer,
        addComposerAttachments: addComposerAttachments,
        removeComposerAttachment: removeComposerAttachment,
        busy: busy,
        toasts: toasts,
        dismissToast: dismissToast,
        confirmState: confirmState,
        askConfirm: askConfirm,
        closeConfirm: closeConfirm,
        form: form,
        formDirty: formDirty,
        formErrors: formErrors,
        setFormErrors: setFormErrors,
        updateField: updateField,
        updateSecret: updateSecret,
        applyPreset: applyPreset,
        saveSettings: saveSettings,
        resetSettings: resetSettings,
        masterSwitch: masterSwitch,
        testResults: testResults,
        testConnection: testConnection,
        presets: presets,
        friendsState: friendsState,
        loadFriends: loadFriends,
        friendForm: friendForm,
        setFriendForm: setFriendForm,
        addFriend: addFriend,
        removeFriend: removeFriend,
        updateFriend: updateFriend,
        decideFriend: decideFriend,
        addFriendFromMessage: addFriendFromMessage,
        syncNow: syncNow,
        notifyTest: notifyTest,
        clearData: clearData,
        diagState: diagState,
        loadDiagnostics: loadDiagnostics,
        sessions: sessions,
        notifyTestResult: notifyTestResult,
        clearConfirmInput: clearConfirmInput,
        setClearConfirmInput: setClearConfirmInput,
        pushToast: pushToast,
        refreshSnapshot: refreshSnapshot,
        loadList: loadList,
        copyText: copyText,
      }
    }
    // 控制器在 hook 外部的回调里也需要 t（保存/校验/toast 文案）：apply 时绑定。
    var tGlobal = function (key) { return key }
    function setGlobalTranslator(translate) {
      tGlobal = function (key, params) { return translate(key, params) }
    }

    // ------------------------------------------ 表单控件与入口徽标的补充样式
    CSS += `
.dsh-mailbox-field input,.dsh-mailbox-field select,.dsh-mailbox-field textarea{box-sizing:border-box;min-height:32px;padding:5px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:none}
.dsh-mailbox-field input:hover,.dsh-mailbox-field select:hover,.dsh-mailbox-field textarea:hover{border-color:var(--dsw-alias-border-l2)}
.dsh-mailbox-field input:focus-visible,.dsh-mailbox-field select:focus-visible,.dsh-mailbox-field textarea:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent)}
.dsh-mailbox-field input:disabled,.dsh-mailbox-field select:disabled,.dsh-mailbox-field textarea:disabled{opacity:.55;cursor:not-allowed}
.dsh-mailbox-field select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-tertiary) 50%),linear-gradient(135deg,var(--dsw-alias-label-tertiary) 50%,transparent 50%);background-position:calc(100% - 15px) 14px,calc(100% - 10px) 14px;background-size:5px 5px;background-repeat:no-repeat;padding-right:28px}
.dsh-mailbox-field textarea{resize:vertical;min-height:90px}
.dsh-mailbox-settings-fields{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:14px;min-width:0}
.dsh-mailbox-settings-fields:disabled{opacity:.55}
.dsh-mailbox-inline-pair{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsh-mailbox-inline-pair .dsh-mailbox-field{flex:1}
.dsh-mailbox-inline-pair .dsh-mailbox-field[data-size="sm"]{flex:0 0 108px}
.dsh-mailbox-entry{position:relative;display:inline-flex;align-items:center;justify-content:center}
.dsh-mailbox-entry-badge{position:absolute;top:-6px;right:-9px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--dsw-alias-state-error-primary);color:#fff;font-size:9px;line-height:14px;text-align:center;font-weight:600;font-variant-numeric:tabular-nums;pointer-events:none}
.dsh-mailbox-entry-button{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-mailbox-entry-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mailbox-entry-button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-mailbox-entry-dot{position:absolute;top:3px;right:4px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-error-primary);border:1.5px solid var(--dsw-alias-bg-base)}
.dsh-mailbox-settings-page{padding:0 clamp(20px,4vw,48px) 32px;height:100%;overflow:auto}
.dsh-mailbox-settings-page-inner{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:14px;padding-top:8px}
.dsh-mailbox-inline-tab{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dsh-mailbox-inline-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mailbox-inline-tab[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover-accent,var(--dsw-alias-interactive-bg-hover));border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,transparent);color:var(--dsw-alias-label-primary);font-weight:500}
.dsh-mailbox-fallback-switch{display:inline-flex;align-items:center;gap:8px;font-size:12px}
.dsh-mailbox-btn{font:inherit;font-size:13px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:5px 12px;cursor:pointer}
.dsh-mailbox-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mailbox-root{position:relative;overflow:hidden}
.dsh-mailbox-reader-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.dsh-mailbox-reader-body>.dsh-mailbox-empty{flex:1}
.dsh-mailbox-reader-body>.dsh-mailbox-skeleton{padding:20px}
.dsh-mailbox-reader-body>.dsh-mailbox-error{margin:16px}
.dsh-mailbox-master-actions{display:flex;align-items:center;gap:8px}
.dsh-mailbox-attach-box{display:flex;flex-direction:column;gap:6px}
.dsh-mailbox-settings-inner{max-width:880px;gap:12px}
.dsh-mailbox-settings-scroll{padding-bottom:8px}
.dsh-mailbox-settings-tabs{position:sticky;top:0;z-index:5;display:flex;gap:4px;padding:6px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv1,none);flex-wrap:wrap}
.dsh-mailbox-settings-tab{flex:1;min-width:92px;height:30px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dsh-mailbox-settings-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mailbox-settings-tab[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-hover-accent,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3)}
.dsh-mailbox-grid3{display:grid;grid-template-columns:minmax(0,1fr) 108px 132px;gap:8px;margin-top:10px}
.dsh-mailbox-quickstart{border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:linear-gradient(180deg,var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-layer-1));padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.dsh-mailbox-quickstart-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsh-mailbox-quickstart-progress{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3)}
.dsh-mailbox-quickstart-bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-bottom:2px}
.dsh-mailbox-quickstart-bar>span{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary);transition:width .2s ease}
.dsh-mailbox-step{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-top:.5px solid var(--dsw-alias-border-l3)}
.dsh-mailbox-step:first-of-type{border-top:0}
.dsh-mailbox-step-index{flex:none;width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);margin-top:1px}
.dsh-mailbox-step[data-done="true"] .dsh-mailbox-step-index{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsh-mailbox-step-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dsh-mailbox-step-main b{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsh-mailbox-step[data-done="true"] .dsh-mailbox-step-main b{color:var(--dsw-alias-label-secondary)}
.dsh-mailbox-step-main span{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-mailbox-provider-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px;margin-bottom:4px}
.dsh-mailbox-provider{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-height:52px;padding:8px 10px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.dsh-mailbox-provider:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mailbox-provider[aria-pressed="true"]{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover-accent,var(--dsw-alias-bg-layer-2))}
.dsh-mailbox-provider:disabled{opacity:.5;cursor:not-allowed}
.dsh-mailbox-provider-name{font-size:12px;font-weight:500;line-height:18px}
.dsh-mailbox-provider-host{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-mailbox-policy-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:8px 0 4px}
.dsh-mailbox-policy{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;min-height:84px}
.dsh-mailbox-policy:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mailbox-policy[aria-checked="true"]{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}
.dsh-mailbox-policy:disabled{opacity:.5;cursor:not-allowed}
.dsh-mailbox-policy-name{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;line-height:18px}
.dsh-mailbox-policy-desc{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-mailbox-adv{border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsh-mailbox-adv>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;cursor:pointer;list-style:none}
.dsh-mailbox-adv>summary::-webkit-details-marker{display:none}
.dsh-mailbox-adv>summary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mailbox-adv-title{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-mailbox-adv-title b{font-size:13px;font-weight:500;line-height:20px}
.dsh-mailbox-adv-title span{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-mailbox-adv-body{display:flex;flex-direction:column;gap:10px;padding:0 16px 16px}
.dsh-mailbox-guide-caret{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.dsh-mailbox-auth-guide[open] .dsh-mailbox-guide-caret,.dsh-mailbox-adv[open] .dsh-mailbox-guide-caret{transform:rotate(180deg)}
.dsh-mailbox-guide-note{margin:8px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);border-top:.5px solid var(--dsw-alias-border-l3);padding-top:6px}
.dsh-mailbox-savebar{position:sticky;bottom:-1px;z-index:6;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:2px -4px 0;padding:10px 12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv2,0 -2px 12px rgba(0,0,0,.08))}
@media (max-width:767px){
.dsh-mailbox-grid3{grid-template-columns:minmax(0,1fr) 96px 120px}
.dsh-mailbox-policy-grid{grid-template-columns:minmax(0,1fr)}
.dsh-mailbox-settings-tab{min-width:0;flex:1 1 40%}
}
.dsh-mailbox-attach-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-mailbox-attach-chips{display:flex;flex-wrap:wrap;gap:6px}
.dsh-mailbox-attach-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;height:26px;padding:0 6px 0 8px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-mailbox-attach-name{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dsh-mailbox-attach-size{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.dsh-mailbox-attach-remove{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-mailbox-attach-remove:hover{background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-error-primary)}
.dsh-mailbox-settings-embed{height:100%;overflow:auto}
`

    // ------------------------------------------------------------- 导航
    function FolderNav(props) {
      var t = props.t
      var counts = props.counts || {}
      var items = [
        { key: 'inbox', label: t('navInbox'), icon: 'inbox', count: counts.unread, quiet: false },
        { key: 'sent', label: t('navSent'), icon: 'sent', count: 0, quiet: true },
        { key: 'quarantine', label: t('navQuarantine'), icon: 'shield', count: counts.quarantine, quiet: true },
        { key: 'friends', label: t('navFriends'), icon: 'users', count: counts.friends, quiet: true },
        { key: 'settings', label: t('navSettings'), icon: 'settings', count: 0, quiet: true },
        { key: 'diagnostics', label: t('navDiagnostics'), icon: 'diagnostics', count: 0, quiet: true },
      ]
      return h(
        'nav',
        { className: 'dsh-mailbox-nav', 'aria-label': t('navAria') },
        items.map(function (item) {
          var disabled = props.disabled === true && item.key !== 'settings' && item.key !== 'diagnostics' && item.key !== 'friends'
          return h(
            'button',
            {
              key: item.key,
              type: 'button',
              className: 'dsh-mailbox-nav-item',
              'aria-current': props.view === item.key ? 'page' : undefined,
              disabled: disabled,
              onClick: function () { if (!disabled) props.onSelect(item.key) },
            },
            h(Icon, { name: item.icon, size: 16 }),
            h('span', { className: 'dsh-mailbox-nav-label' }, item.label),
            item.count > 0 ? h('span', { className: 'dsh-mailbox-nav-count', 'data-quiet': item.quiet === true ? 'true' : undefined, 'aria-label': String(item.count) }, String(item.count > 99 ? '99+' : item.count)) : null,
          )
        }),
        props.footer || null,
      )
    }

    // ------------------------------------------------------------- 列表
    function MailRow(props) {
      var t = props.t
      var row = props.row
      var tags = []
      if (row.friend === true) tags.push(h('span', { key: 'friend', className: 'dsh-mailbox-tag', 'data-tone': 'friend' }, t('friendTag')))
      if (row.suspicious === true) tags.push(h('span', { key: 'suspicious', className: 'dsh-mailbox-tag', 'data-tone': 'warn' }, t('suspiciousTag')))
      if (row.automatic === true) tags.push(h('span', { key: 'automatic', className: 'dsh-mailbox-tag' }, t('automaticTag')))
      if (row.hasAttachments === true) tags.push(h('span', { key: 'attachment', className: 'dsh-mailbox-tag' }, t('attachmentTag')))
      return h(
        'li',
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-mailbox-row',
            'data-unread': row.unread === true ? 'true' : 'false',
            'aria-selected': props.selected === true ? 'true' : 'false',
            'aria-label': (row.unread === true ? t('unreadTag') + ' ' : '') + (row.fromName || row.fromAddress) + '：' + row.subject,
            onClick: function () { props.onOpen(row.id) },
          },
          row.unread === true ? h('span', { className: 'dsh-mailbox-unread-dot', 'aria-hidden': 'true' }) : h('span', { style: { width: 7, flex: 'none' } }),
          h('span', { className: 'dsh-mailbox-avatar', 'aria-hidden': 'true' }, initialOf(row.fromName, row.fromAddress)),
          h(
            'span',
            { className: 'dsh-mailbox-row-main' },
            h(
              'span',
              { className: 'dsh-mailbox-row-top' },
              h('span', { className: 'dsh-mailbox-row-from' }, row.fromName || row.fromAddress || ''),
              h('span', { className: 'dsh-mailbox-row-date' }, relativeTime(row.date, t)),
            ),
            h('span', { className: 'dsh-mailbox-row-subject' }, row.subject || '（无主题）'),
            row.snippet ? h('span', { className: 'dsh-mailbox-row-snippet' }, row.snippet) : null,
            tags.length > 0 ? h('span', { className: 'dsh-mailbox-row-tags' }, tags) : null,
          ),
        ),
      )
    }

    function MailList(props) {
      var t = props.t
      var controller = props.controller
      var listState = controller.listState
      var rows = listState.rows
      var emptyTitle = listState.end && listState.end
      var viewTitles = { inbox: 'emptyInbox', sent: 'emptySent', quarantine: 'emptyQuarantine' }
      var viewHints = { inbox: 'emptyInboxHint', sent: 'emptySentHint', quarantine: 'emptyQuarantineHint' }
      var filtered = controller.search !== '' || controller.unreadOnly === true
      return h(
        'section',
        { className: 'dsh-mailbox-list-pane', 'aria-label': t('listAria') },
        h(
          'div',
          { className: 'dsh-mailbox-toolbar' },
          h(
            'div',
            { className: 'dsh-mailbox-search' },
            h(UI.Input, {
              type: 'search',
              value: controller.searchInput,
              placeholder: t('searchPlaceholder'),
              'aria-label': t('search'),
              icon: h(Icon, { name: 'search', size: 14 }),
              onChange: function (event) { controller.setSearchInput(event.target.value) },
            }),
          ),
          h(
            'div',
            { className: 'dsh-mailbox-inline-tabs' },
            h('button', { type: 'button', className: 'dsh-mailbox-inline-tab', 'aria-pressed': controller.unreadOnly !== true ? 'true' : 'false', onClick: function () { controller.setUnreadOnly(false) } }, t('all')),
            h('button', { type: 'button', className: 'dsh-mailbox-inline-tab', 'aria-pressed': controller.unreadOnly === true ? 'true' : 'false', onClick: function () { controller.setUnreadOnly(true) } }, t('unreadOnly')),
          ),
          controller.searchInput !== '' ? h('button', { type: 'button', className: 'dsh-mailbox-inline-tab', onClick: function () { controller.setSearchInput('') }, 'aria-label': t('clearSearch') }, h(Icon, { name: 'close', size: 12 })) : null,
        ),
        listState.status === 'loading'
          ? h(SkeletonList, { rows: 6, label: t('loading') })
          : listState.status === 'error'
            ? h(ErrorView, {
                t: t,
                message: listState.error,
                hint: t('errorHost'),
                actions: h(UI.Button, { variant: 'outline', size: 'sm', onClick: function () { controller.loadList() } }, t('errorRetry')),
              })
            : rows.length === 0
              ? h(EmptyState, {
                  icon: filtered ? 'search' : viewTitles[controller.view] === 'emptyQuarantine' ? 'shield' : controller.view === 'sent' ? 'sent' : 'inbox',
                  title: filtered ? t('noResults') : t(viewTitles[controller.view] || 'emptyInbox'),
                  hint: filtered ? t('noResultsHint') : t(viewHints[controller.view] || 'emptyInboxHint'),
                  actions: filtered
                    ? h(UI.Button, { variant: 'outline', onClick: function () { controller.setSearchInput(''); controller.setUnreadOnly(false) } }, t('clearSearch'))
                    : controller.view === 'inbox' && props.notConfigured === true
                      ? h(UI.Button, { variant: 'primary', onClick: props.onGoSettings }, t('notConfiguredCta'))
                      : h(UI.Button, { variant: 'outline', onClick: function () { controller.syncNow() }, disabled: controller.busy.sync === true }, t('syncNow')),
                })
              : h(
                  'div',
                  { className: 'dsh-mailbox-list-scroll', role: 'listbox', 'aria-label': t('listAria'), tabIndex: -1 },
                  h(
                    'ul',
                    { className: 'dsh-mailbox-list' },
                    rows.map(function (row) {
                      return h(MailRow, { key: row.id, t: t, row: row, selected: controller.selectedId === row.id, onOpen: controller.openMessage })
                    }),
                  ),
                  listState.total > rows.length ? h('div', { className: 'dsh-mailbox-list-foot' }, t('loadMore')) : null,
                ),
        h('div', { className: 'dsh-mailbox-list-foot' }, listState.status === 'ready' ? String(listState.total) + ' / ' + String(listState.rows.length) : null),
      )
    }

    // ------------------------------------------------------------- 阅读
    function buildSrcdoc(message) {
      var body = ''
      if (message !== null && typeof message.html === 'string' && message.html.trim() !== '') {
        // 宿主已消毒（lib/mail/html.js）；这里只做 iframe 包装，绝不注入原始邮件 HTML。
        body = message.html
      } else if (message !== null && typeof message.text === 'string') {
        body = '<pre style="margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.65 -apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#1f2328">' + escapeHtml(message.text) + '</pre>'
      }
      return '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank"><style>' + READER_CSS + '</style></head><body>' + body + '</body></html>'
    }
    var READER_CSS = 'html,body{margin:0;padding:0;background:#ffffff;color:#1f2328}body{padding:2px 2px 8px;font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#0b57d0;text-decoration:none}blockquote{margin:0 0 12px;padding-left:12px;border-left:2px solid #e4e6e8;color:#59636e}hr{border:0;border-top:1px solid #e4e6e8}'
    function escapeHtml(value) {
      return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    function ReaderBanner(props) {
      return h('div', { className: 'dsh-mailbox-banner', 'data-tone': props.tone || 'info' }, h(Icon, { name: props.icon || 'warning', size: 14 }), h('span', null, props.text))
    }

    function ReaderLinks(props) {
      var links = props.links
      if (links.length === 0) return null
      return h(
        'section',
        { className: 'dsh-mailbox-links' },
        h('h4', { className: 'dsh-mailbox-section-title' }, h(Icon, { name: 'external', size: 13 }), tGlobal('links')),
        h('p', { className: 'dsh-mailbox-field-hint' }, tGlobal('linksHint')),
        h(
          'div',
          { className: 'dsh-mailbox-link-list' },
          links.map(function (link, index) {
            return h('a', { key: index, className: 'dsh-mailbox-link', href: link.href, target: '_blank', rel: 'noopener noreferrer' }, h(Icon, { name: 'externalLink', size: 12 }), h('span', null, link.label))
          }),
        ),
      )
    }

    function Reader(props) {
      var t = props.t
      var controller = props.controller
      var reader = controller.reader
      var row = reader.row
      var message = reader.message
      var narrow = props.narrow === true
      var links = React.useMemo(function () {
        return message !== null && message !== undefined ? extractLinks(message.html) : []
      }, [message && message.id])
      var srcdoc = React.useMemo(function () {
        return buildSrcdoc(message)
      }, [message && message.id])
      var head = h(
        'div',
        { className: 'dsh-mailbox-reader-head' },
        narrow ? h(UI.Button, { size: 'sm', variant: 'ghost', 'aria-label': t('back'), onClick: controller.closeReader }, h(Icon, { name: 'chevronLeft', size: 14 }), ' ', t('back')) : null,
        row !== null
          ? h(UI.Button, { size: 'sm', variant: 'ghost', 'aria-label': t('reply'), onClick: function () { controller.openComposer({ mode: 'reply', replyToId: row.id, to: row.fromAddress, subject: 'Re: ' + String(row.subject || '').replace(/^Re:\s*/i, '') }) } }, h(Icon, { name: 'reply', size: 14 }), ' ', t('reply'))
          : null,
        row !== null
          ? h(UI.Button, { size: 'sm', variant: 'ghost', 'aria-label': row.unread === true ? t('markRead') : t('markUnread'), onClick: controller.toggleRead }, h(Icon, { name: row.unread === true ? 'check' : 'mail', size: 14 }), ' ', row.unread === true ? t('markRead') : t('markUnread'))
          : null,
        row !== null && row.friend !== true
          ? h(UI.Button, { size: 'sm', variant: 'ghost', 'aria-label': t('addFriend'), onClick: function () { controller.addFriendFromMessage(row) } }, h(Icon, { name: 'users', size: 14 }), ' ', t('addFriend'))
          : null,
        row !== null
          ? h(UI.Button, {
              size: 'sm',
              variant: 'ghost',
              'aria-label': t('delete'),
              disabled: controller.busy.delete === true,
              onClick: function () {
                controller.askConfirm({
                  title: t('deleteTitle'),
                  body: t('deleteBody'),
                  confirmLabel: t('delete'),
                  danger: true,
                  run: function () { return controller.deleteMessage(row.id) },
                })
              },
            }, h(Icon, { name: 'trash', size: 14 }), ' ', t('delete'))
          : null,
        row !== null ? h('span', { className: 'dsh-mailbox-reader-head-title' }, relativeTime(row.date, t)) : null,
        narrow ? h(UI.Button, { size: 'sm', variant: 'ghost', 'aria-label': t('close'), onClick: controller.closeReader }, h(Icon, { name: 'close', size: 14 })) : null,
      )
      var body
      if (reader.status === 'loading') body = h(SkeletonReader, null)
      else if (reader.status === 'error') body = h(ErrorView, { t: t, message: reader.error, actions: h(UI.Button, { variant: 'outline', size: 'sm', onClick: function () { controller.openMessage(controller.selectedId) } }, t('errorRetry')) })
      else if (message === null) body = h(EmptyState, { icon: 'mail', title: t('emptyReader'), hint: t('emptyReaderHint') })
      else {
        var banners = []
        if (row !== null && row.suspicious === true) banners.push(h(ReaderBanner, { key: 'suspicious', tone: 'warn', icon: 'shield', text: t('suspiciousBanner') }))
        if (controller.view === 'quarantine') banners.push(h(ReaderBanner, { key: 'quarantine', tone: 'warn', icon: 'shield', text: t('quarantineBanner') }))
        if (row !== null && row.automatic === true) banners.push(h(ReaderBanner, { key: 'automatic', icon: 'clock', text: t('automaticTag') }))
        var attachments = Array.isArray(message.attachments) ? message.attachments : []
        body = h(
          'div',
          { className: 'dsh-mailbox-reader-scroll', tabIndex: -1 },
          banners,
          h('h2', { className: 'dsh-mailbox-reader-subject' }, message.subject || '（无主题）'),
          h(
            'div',
            { className: 'dsh-mailbox-reader-meta' },
            h('span', null, h('b', null, t('from') + '：'), ' ', message.from ? (message.from.name ? message.from.name + ' ' : '') + '<' + (message.from.address || '') + '>' : ''),
            h('span', null, h('b', null, t('to') + '：'), ' ', Array.isArray(message.to) ? message.to.map(function (item) { return item.name ? item.name + ' <' + item.address + '>' : item.address }).join(', ') : ''),
            h('span', null, h('b', null, t('date') + '：'), ' ', formatAbsoluteTime(message.date, 'zh')),
          ),
          h('iframe', {
            className: 'dsh-mailbox-reader-frame',
            sandbox: '',
            referrerPolicy: 'no-referrer',
            title: String(message.subject || t('readerAria')),
            srcDoc: srcdoc,
            loading: 'lazy',
          }),
          attachments.length > 0
            ? h(
                'section',
                { className: 'dsh-mailbox-attachments' },
                h('h4', { className: 'dsh-mailbox-section-title' }, h(Icon, { name: 'paperclip', size: 13 }), t('attachments')),
                h('p', { className: 'dsh-mailbox-field-hint' }, t('attachmentsHint')),
                attachments.map(function (item, index) {
                  return h('div', { className: 'dsh-mailbox-attachment', key: index }, h(Icon, { name: 'paperclip', size: 13 }), h('span', null, String(item.filename || 'attachment') + ' · ' + formatBytes(item.size)))
                }),
              )
            : null,
          h(ReaderLinks, { links: links }),
          typeof message.text === 'string' && message.text !== ''
            ? h(
                'details',
                { className: 'dsh-mailbox-plain-version' },
                h('summary', null, t('showPlain')),
                h('pre', { className: 'dsh-mailbox-plain', style: { marginTop: 8 } }, message.text),
              )
            : null,
        )
      }
      return h(
        'section',
        { className: 'dsh-mailbox-reader', 'aria-label': t('readerAria') },
        head,
        h('div', { className: 'dsh-mailbox-reader-body' }, body),
      )
    }

    // ------------------------------------------------------------- 写信
    function Composer(props) {
      var t = props.t
      var controller = props.controller
      var composer = controller.composer
      var busy = controller.busy.send === true
      var fileInputRef = React.useRef(null)
      if (composer === null) return null
      var attachments = Array.isArray(composer.attachments) ? composer.attachments : []
      function requestClose() {
        var dirty = String(composer.content || '').trim() !== '' || String(composer.subject || '').trim() !== '' || String(composer.to || '').trim() !== ''
        if (!dirty) { controller.closeComposer(); return }
        controller.askConfirm({
          title: t('discardTitle'),
          body: t('discardBody'),
          confirmLabel: t('discard'),
          danger: true,
          run: function () { controller.closeComposer() },
        })
      }
      return h(
        React.Fragment,
        null,
        h('div', { className: 'dsh-mailbox-composer-backdrop', onClick: requestClose, 'aria-hidden': 'true' }),
        h(
          'div',
          { className: 'dsh-mailbox-composer', role: 'dialog', 'aria-modal': 'true', 'aria-label': composer.mode === 'reply' ? t('replyTitle', { subject: composer.subject }) : t('composeTitle') },
          h(
            'div',
            { className: 'dsh-mailbox-composer-head' },
            h('h2', { className: 'dsh-mailbox-composer-title' }, composer.mode === 'reply' ? t('replyTitle', { subject: composer.subject }) : t('composeTitle')),
            h(UI.Button, { size: 'sm', variant: 'ghost', 'aria-label': t('close'), onClick: requestClose }, h(Icon, { name: 'close', size: 14 })),
          ),
          h(
            'div',
            { className: 'dsh-mailbox-composer-body' },
            h(Field, { label: t('toLabel') }, h(UI.Input, { value: composer.to, placeholder: t('toPlaceholder'), 'aria-label': t('toLabel'), disabled: composer.mode === 'reply', onChange: function (event) { controller.updateComposer({ to: event.target.value }) } })),
            composer.mode !== 'reply' ? h('p', { className: 'dsh-mailbox-field-hint' }, t('strangerRecipientHint')) : null,
            h(Field, { label: t('subjectLabel') }, h(UI.Input, { value: composer.subject, placeholder: t('subjectPlaceholder'), 'aria-label': t('subjectLabel'), onChange: function (event) { controller.updateComposer({ subject: event.target.value }) } })),
            h(
              'div',
              { className: 'dsh-mailbox-attach-box' },
              h(
                'div',
                { className: 'dsh-mailbox-attach-head' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-mailbox-inline-tab',
                    disabled: busy || attachments.length >= 5,
                    onClick: function () { if (fileInputRef.current !== null) fileInputRef.current.click() },
                  },
                  h(Icon, { name: 'paperclip', size: 13 }),
                  ' ',
                  t('attachmentsAdd'),
                  attachments.length > 0 ? '（' + String(attachments.length) + '/5）' : '',
                ),
                h('input', {
                  ref: fileInputRef,
                  type: 'file',
                  multiple: true,
                  className: 'dsh-mailbox-sr-only',
                  tabIndex: -1,
                  'aria-label': t('attachmentsAdd'),
                  onChange: function (event) {
                    var files = event.target.files
                    controller.addComposerAttachments(files)
                    try { event.target.value = '' } catch (_error) { /* noop */ }
                  },
                }),
                h('span', { className: 'dsh-mailbox-composer-hint' }, t('attachmentsAddHint')),
              ),
              attachments.length > 0
                ? h(
                    'div',
                    { className: 'dsh-mailbox-attach-chips' },
                    attachments.map(function (item, index) {
                      return h(
                        'span',
                        { className: 'dsh-mailbox-attach-chip', key: index },
                        h(Icon, { name: 'paperclip', size: 12 }),
                        h('span', { className: 'dsh-mailbox-attach-name', title: item.filename }, item.filename),
                        h('span', { className: 'dsh-mailbox-attach-size' }, formatBytes(item.size)),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-mailbox-attach-remove',
                            'aria-label': t('attachmentRemove') + '：' + item.filename,
                            disabled: busy,
                            onClick: function () { controller.removeComposerAttachment(index) },
                          },
                          h(Icon, { name: 'close', size: 11 }),
                        ),
                      )
                    }),
                  )
                : null,
            ),
            h(
              Field,
              { label: t('contentLabel'), hint: t('letterHint') },
              h('textarea', {
                value: composer.content,
                placeholder: t('contentPlaceholder'),
                'aria-label': t('contentLabel'),
                autoFocus: true,
                onChange: function (event) { controller.updateComposer({ content: event.target.value }) },
                onKeyDown: function (event) {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault()
                    controller.sendComposer()
                  }
                },
              }),
            ),
          ),
          h(
            'div',
            { className: 'dsh-mailbox-composer-foot' },
            h('span', { className: 'dsh-mailbox-composer-hint' }, 'Ctrl/⌘ + Enter'),
            h(UI.Button, { variant: 'outline', onClick: requestClose, disabled: busy }, t('cancel')),
            h(UI.Button, { variant: 'primary', onClick: function () { controller.sendComposer() }, disabled: busy }, busy ? h(Spinner, { size: 12 }) : h(Icon, { name: 'send', size: 14 }), ' ', busy ? t('sending') : t('send')),
          ),
        ),
      )
    }

    // ------------------------------------------------------------- 好友
    function FriendRow(props) {
      var t = props.t
      var friend = props.friend
      var sourceKey = friend.addedBy === 'ai' ? 'sourceAi' : friend.addedBy === 'user-approved-ai' ? 'sourceApproved' : 'sourceUser'
      return h(
        'div',
        { className: 'dsh-mailbox-friend' },
        h('span', { className: 'dsh-mailbox-avatar', 'aria-hidden': 'true' }, initialOf(friend.name, friend.address)),
        h(
          'div',
          { className: 'dsh-mailbox-friend-main' },
          h('div', { className: 'dsh-mailbox-friend-name' }, h('span', null, friend.name || friend.address), h('span', { className: 'dsh-mailbox-tag' }, t(sourceKey)), friend.autoReply === true ? h('span', { className: 'dsh-mailbox-tag', 'data-tone': 'business' }, t('autoReply')) : null),
          h('div', { className: 'dsh-mailbox-friend-address' }, friend.address),
          friend.note ? h('div', { className: 'dsh-mailbox-friend-note' }, friend.note) : null,
          friend.addedAt ? h('div', { className: 'dsh-mailbox-friend-note' }, t('friendSince', { date: formatAbsoluteTime(friend.addedAt, 'zh') })) : null,
        ),
        h(
          'div',
          { className: 'dsh-mailbox-friend-side' },
          h(UI.Switch, { checked: friend.autoReply === true, label: t('autoReply'), onChange: function (checked) { props.onUpdate({ autoReply: checked }) } }),
          h(UI.Button, {
            size: 'sm',
            variant: 'ghost',
            'aria-label': t('remove'),
            onClick: function () {
              props.onRemove()
            },
          }, h(Icon, { name: 'trash', size: 14 })),
        ),
      )
    }

    function FriendsView(props) {
      var t = props.t
      var controller = props.controller
      var state = controller.friendsState
      var data = state.data
      var friends = data !== null && Array.isArray(data.friends) ? data.friends : []
      var pending = data !== null && Array.isArray(data.pending) ? data.pending : []
      var policy = data !== null && typeof data.policy === 'string' ? data.policy : 'auto'
      var policyDesc = policy === 'ask' ? t('policyAskDesc') : policy === 'manual' ? t('policyManualDesc') : t('policyAutoDesc')
      var disabled = controller.snapshot.data !== null && controller.snapshot.data.enabled === false
      var policyCard = h(
        Card,
        { title: t('friendPolicyTitle'), desc: policyDesc, side: h('span', { className: 'dsh-mailbox-tag', 'data-tone': 'business' }, policy) },
        h(
          'div',
          { className: 'dsh-mailbox-switch-row-text' },
          h('span', null, t('policyAuto') + ' / ' + t('policyAsk') + ' / ' + t('policyManual')),
        ),
        h('div', { className: 'dsh-mailbox-actions' }, h(UI.Button, { variant: 'outline', size: 'sm', onClick: function () { controller.selectView('settings') } }, t('navSettings'))),
      )
      var pendingCard = pending.length > 0
        ? h(
            Card,
            { title: t('pendingTitle'), desc: t('pendingHint') },
            h(
              'div',
              { className: 'dsh-mailbox-friend-list' },
              pending.map(function (request) {
                return h(
                  'div',
                  { className: 'dsh-mailbox-pending', key: request.address },
                  h(
                    'div',
                    { className: 'dsh-mailbox-friend-main' },
                    h('div', { className: 'dsh-mailbox-friend-name' }, h('span', null, request.address), h('span', { className: 'dsh-mailbox-tag', 'data-tone': 'warn' }, t('requestedByAi'))),
                    request.name ? h('div', { className: 'dsh-mailbox-friend-address' }, request.name) : null,
                    request.reason ? h('div', { className: 'dsh-mailbox-friend-note' }, request.reason) : null,
                    request.requestedAt ? h('div', { className: 'dsh-mailbox-friend-note' }, t('requestedAt') + '：' + formatAbsoluteTime(request.requestedAt, 'zh')) : null,
                  ),
                  h(
                    'div',
                    { className: 'dsh-mailbox-friend-side' },
                    h(UI.Button, { size: 'sm', variant: 'primary', disabled: disabled, onClick: function () { controller.decideFriend(request.address, true) } }, t('approve')),
                    h(UI.Button, { size: 'sm', variant: 'outline', disabled: disabled, onClick: function () { controller.decideFriend(request.address, false) } }, t('reject')),
                  ),
                )
              }),
            ),
          )
        : h(Card, { title: t('pendingTitle'), desc: t('pendingHint') }, h('p', { className: 'dsh-mailbox-card-desc' }, t('pendingEmpty')))
      var addCard = h(
        Card,
        { title: t('addFriendTitle') },
        h(
          'form',
          {
            onSubmit: function (event) {
              event.preventDefault()
              controller.addFriend(controller.friendForm.address, controller.friendForm.name, controller.friendForm.note)
            },
          },
          h(
            'div',
            { className: 'dsh-mailbox-grid2' },
            h(Field, { label: t('addressLabel'), error: controller.friendForm.error }, h(UI.Input, { value: controller.friendForm.address, placeholder: t('addressPlaceholder'), 'aria-label': t('addressLabel'), disabled: disabled || controller.friendForm.busy === true, onChange: function (event) { controller.setFriendForm(function (prev) { return Object.assign({}, prev, { address: event.target.value, error: '' }) }) } })),
            h(Field, { label: t('nameLabel') }, h(UI.Input, { value: controller.friendForm.name, placeholder: t('namePlaceholder'), 'aria-label': t('nameLabel'), disabled: disabled || controller.friendForm.busy === true, onChange: function (event) { controller.setFriendForm(function (prev) { return Object.assign({}, prev, { name: event.target.value }) }) } })),
          ),
          h(Field, { label: t('noteLabel') }, h(UI.Input, { value: controller.friendForm.note, placeholder: t('notePlaceholder'), 'aria-label': t('noteLabel'), disabled: disabled || controller.friendForm.busy === true, onChange: function (event) { controller.setFriendForm(function (prev) { return Object.assign({}, prev, { note: event.target.value }) }) } })),
          h(
            'div',
            { className: 'dsh-mailbox-actions' },
            h(UI.Button, { type: 'submit', variant: 'primary', disabled: disabled || controller.friendForm.busy === true }, controller.friendForm.busy === true ? h(Spinner, { size: 12 }) : null, ' ', controller.friendForm.busy === true ? t('adding') : t('add')),
          ),
        ),
      )
      var listCard = h(
        Card,
        { title: t('friendsTitle'), desc: t('friendCountAria', { count: friends.length }) },
        state.status === 'loading' && data === null
          ? h(SkeletonList, { rows: 3 })
          : state.status === 'error'
            ? h(ErrorView, { t: t, message: state.error, actions: h(UI.Button, { size: 'sm', variant: 'outline', onClick: controller.loadFriends }, t('errorRetry')) })
            : friends.length === 0
              ? h(EmptyState, { icon: 'users', title: t('emptyFriends'), hint: t('emptyFriendsHint') })
              : h(
                  'div',
                  { className: 'dsh-mailbox-friend-list' },
                  friends.map(function (friend) {
                    return h(FriendRow, {
                      key: friend.address,
                      t: t,
                      friend: friend,
                      onUpdate: function (patch) { controller.updateFriend(friend.address, patch) },
                      onRemove: function () {
                        controller.askConfirm({
                          title: t('removeTitle'),
                          body: t('removeBody') + '\n' + friend.address,
                          confirmLabel: t('remove'),
                          danger: true,
                          run: function () { return controller.removeFriend(friend.address) },
                        })
                      },
                    })
                  }),
                ),
      )
      var aiLog = data !== null && Array.isArray(data.aiAddLog) && data.aiAddLog.length > 0
        ? h(
            Card,
            { title: t('aiAddLog') },
            h(
              'ul',
              { className: 'dsh-mailbox-plain', style: { listStyle: 'none', padding: 0, margin: 0, fontSize: 12, lineHeight: '18px' } },
              data.aiAddLog.slice(-20).reverse().map(function (entry, index) {
                return h('li', { key: index, style: { padding: '4px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l3)' } }, h('b', null, entry.address), ' · ', entry.action, entry.reason ? ' · ' + entry.reason : '')
              }),
            ),
          )
        : null
      return h(
        'div',
        { className: 'dsh-mailbox-view' },
        h(
          'div',
          { className: 'dsh-mailbox-view-scroll' },
          h(
            'div',
            { className: 'dsh-mailbox-view-inner' },
            policyCard,
            pendingCard,
            addCard,
            listCard,
            aiLog,
          ),
        ),
      )
    }

    // ------------------------------------------------------------- 设置
    function SwitchRow(props) {
      return h(
        'div',
        { className: 'dsh-mailbox-switch-row' },
        h('div', { className: 'dsh-mailbox-switch-row-text' }, h('b', null, props.label), props.hint ? h('span', null, props.hint) : null),
        h(UI.Switch, { checked: props.checked === true, label: props.label, disabled: props.disabled === true, onChange: props.onChange }),
      )
    }

    function SelectField(props) {
      return h(
        Field,
        { label: props.label, hint: props.hint, error: props.error },
        h(
          'select',
          {
            value: props.value,
            'aria-label': props.label,
            disabled: props.disabled === true,
            onChange: function (event) { props.onChange(event.target.value) },
          },
          props.options.map(function (option) {
            return h('option', { key: option.value, value: option.value }, option.label)
          }),
        ),
      )
    }

    function AuthGuide(props) {
      var t = props.t
      var guide = props.guide
      if (!isRecord(guide)) return null
      return h(
        'details',
        { className: 'dsh-mailbox-auth-guide', open: props.open === true ? true : undefined },
        h('summary', null, h(Icon, { name: 'key', size: 14 }), t('authCodeGuide'), h(Icon, { name: 'chevronDown', size: 13, className: 'dsh-mailbox-guide-caret' })),
        guide.summary ? h('p', { style: { margin: '0 0 6px' } }, guide.summary) : null,
        Array.isArray(guide.steps) && guide.steps.length > 0
          ? h('div', null, h('b', null, t('authGuideSteps')), h('ol', null, guide.steps.map(function (step, index) { return h('li', { key: index }, step) })))
          : null,
        Array.isArray(guide.links) && guide.links.length > 0
          ? h(
              'div',
              { className: 'dsh-mailbox-auth-links' },
              h('b', null, t('authGuideLink')),
              guide.links.map(function (link, index) {
                var url = safeHttpUrl(link.url)
                if (url === '') return null
                return h('a', { key: index, className: 'dsh-mailbox-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, h(Icon, { name: 'externalLink', size: 12 }), h('span', null, String(link.label || url)))
              }),
            )
          : null,
        guide.note ? h('p', { className: 'dsh-mailbox-guide-note' }, h('b', null, t('authGuideNote') + '：'), guide.note) : null,
      )
    }

    function TestRow(props) {
      var t = props.t
      var result = props.result
      var tone = result.status === 'ok' ? 'ok' : result.status === 'error' ? 'error' : result.status === 'testing' ? 'busy' : undefined
      return h(
        'div',
        { className: 'dsh-mailbox-test-row' },
        h(UI.Button, { size: 'sm', variant: result.status === 'ok' ? 'outline' : 'primary', disabled: props.disabled === true || result.status === 'testing', onClick: props.onTest }, result.status === 'testing' ? h(Spinner, { size: 12 }) : h(Icon, { name: 'plug', size: 13 }), ' ', result.status === 'testing' ? t('testing') : props.label),
        tone !== undefined ? h('span', { className: 'dsh-mailbox-test-result', 'data-tone': tone, role: result.status === 'error' ? 'alert' : 'status' }, tone === 'ok' ? h(Icon, { name: 'check', size: 13 }) : null, result.status === 'testing' ? null : result.message) : null,
      )
    }

    function StepRow(props) {
      return h(
        'div',
        { className: 'dsh-mailbox-step', 'data-done': props.done === true ? 'true' : 'false' },
        h('span', { className: 'dsh-mailbox-step-index', 'aria-hidden': 'true' }, props.done === true ? h(Icon, { name: 'check', size: 12 }) : String(props.index)),
        h('div', { className: 'dsh-mailbox-step-main' }, h('b', null, props.title), h('span', null, props.desc)),
        props.action !== undefined && props.action !== null ? props.action : null,
      )
    }

    function ProviderCard(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-mailbox-provider',
          'aria-pressed': props.selected === true ? 'true' : 'false',
          disabled: props.disabled === true,
          onClick: props.onSelect,
        },
        h('span', { className: 'dsh-mailbox-provider-name' }, props.label),
        h('span', { className: 'dsh-mailbox-provider-host' }, props.host || props.t('providerCustom')),
      )
    }

    function AdvancedSection(props) {
      return h(
        'details',
        { className: 'dsh-mailbox-adv' },
        h(
          'summary',
          null,
          h('div', { className: 'dsh-mailbox-adv-title' }, h('b', null, props.title), h('span', null, props.desc)),
          h(Icon, { name: 'chevronDown', size: 15, className: 'dsh-mailbox-guide-caret' }),
        ),
        h('div', { className: 'dsh-mailbox-adv-body' }, props.children),
      )
    }

    function presetGuide(presets, id) {
      if (!Array.isArray(presets)) return null
      for (var index = 0; index < presets.length; index += 1) if (presets[index].id === id) return presets[index].guide || null
      return presets.length > 0 ? presets[presets.length - 1].guide || null : null
    }

    function SettingsView(props) {
      var t = props.t
      var controller = props.controller
      var form = controller.form
      var data = controller.snapshot.data
      var disabled = data !== null && data.enabled === false
      var saving = controller.busy.save === true
      var presets = Array.isArray(controller.presets) && controller.presets.length > 0 ? controller.presets : presetFallback('zh')
      var [tab, setTab] = React.useState('start')
      if (form === null) return h(SkeletonReader, null)
      function update(path, value) { controller.updateField(path, value) }
      var smtpSecrets = getPath(form, 'secrets.smtp', {}) || {}
      var imapSecrets = getPath(form, 'secrets.imap', {}) || {}
      var smtpConfigured = smtpSecrets.configured === true || getPath(data, 'connections.smtp.configured', false) === true
      var imapConfigured = imapSecrets.configured === true || getPath(data, 'connections.imap.configured', false) === true
      var smtpPresetId = getPath(form, 'smtp.preset', 'qq')
      var imapPresetId = getPath(form, 'imap.preset', 'qq')
      var smtpGuide = presetGuide(presets, smtpPresetId)
      var imapGuide = presetGuide(presets, imapPresetId)
      var securitySource = function (secrets) {
        if (secrets === undefined || secrets === null || secrets.configured !== true) return null
        var source = String(secrets.source || '')
        var label = source === 'env' ? t('authCodeSourceEnv') : source === 'file' ? t('authCodeSourceFile') : t('authCodeSourceConfig')
        return h('span', { className: 'dsh-mailbox-tag', 'data-tone': 'business' }, label)
      }
      var mailboxAddress = String(getPath(form, 'mailbox.address', '')).trim()
      var smtpUser = String(getPath(form, 'smtp.user', '')).trim()
      var hasAuthInput = String(getPath(form, 'secretsInput.smtpAuthCode', '')).trim() !== ''
      var stepDone = [
        mailboxAddress !== '' && smtpUser !== '',
        smtpUser !== '' && (smtpConfigured === true || hasAuthInput === true),
        controller.testResults.smtp.status === 'ok' || controller.testResults.imap.status === 'ok',
        controller.formDirty !== true && (smtpConfigured === true || imapConfigured === true),
      ]
      var doneCount = stepDone.filter(Boolean).length
      var tabBar = h(
        'div',
        { className: 'dsh-mailbox-settings-tabs', role: 'tablist', 'aria-label': t('settingsAria') },
        [
          { key: 'start', label: t('tabStart') },
          { key: 'connect', label: t('tabConnect') },
          { key: 'notify', label: t('tabNotify') },
          { key: 'advanced', label: t('tabAdvanced') },
        ].map(function (item) {
          return h(
            'button',
            {
              key: item.key,
              type: 'button',
              role: 'tab',
              'aria-selected': tab === item.key ? 'true' : 'false',
              className: 'dsh-mailbox-settings-tab',
              onClick: function () { setTab(item.key) },
            },
            item.label,
          )
        }),
      )
      var masterCard = h(
        'div',
        { className: 'dsh-mailbox-master' },
        h(
          'div',
          { className: 'dsh-mailbox-master-main' },
          h('h2', { className: 'dsh-mailbox-master-title' }, h(Icon, { name: 'plug', size: 16 }), t('masterTitle'), h('span', { className: 'dsh-mailbox-tag', 'data-tone': disabled ? 'warn' : 'friend' }, disabled ? t('masterOff') : t('masterOn'))),
          h('p', { className: 'dsh-mailbox-master-desc' }, disabled ? t('masterOffDesc') : t('masterOnDesc')),
        ),
        h(UI.Switch, {
          checked: disabled !== true,
          label: t('masterTitle'),
          disabled: controller.busy.master === true,
          onChange: function (next) {
            if (next === false) {
              controller.askConfirm({ title: t('masterConfirmTitle'), body: t('masterConfirmBody'), confirmLabel: t('masterOff'), danger: true, run: function () { return controller.masterSwitch(false) } })
            } else {
              controller.askConfirm({ title: t('masterEnableTitle'), body: t('masterEnableBody'), confirmLabel: t('disabledEnable'), danger: false, run: function () { return controller.masterSwitch(true) } })
            }
          },
        }),
      )
      var accountCard = h(
        Card,
        { title: t('accountTitle'), desc: t('accountHint') },
        h(
          'div',
          { className: 'dsh-mailbox-grid2' },
          h(Field, { label: t('mailboxAddress'), hint: t('mailboxAddressHint'), error: controller.formErrors['mailbox.address'] }, h(UI.Input, { value: getPath(form, 'mailbox.address', ''), placeholder: 'figaro1@qq.com', 'aria-label': t('mailboxAddress'), onChange: function (event) { update('mailbox.address', event.target.value) } })),
          h(Field, { label: t('displayName') }, h(UI.Input, { value: getPath(form, 'mailbox.displayName', ''), 'aria-label': t('displayName'), onChange: function (event) { update('mailbox.displayName', event.target.value) } })),
          h(Field, { label: t('ownerAddress'), hint: t('ownerAddressHint'), error: controller.formErrors['owner.address'] }, h(UI.Input, { value: getPath(form, 'owner.address', ''), placeholder: 'mzpr00@163.com', 'aria-label': t('ownerAddress'), onChange: function (event) { update('owner.address', event.target.value) } })),
          h(Field, { label: t('ownerName') }, h(UI.Input, { value: getPath(form, 'owner.name', ''), 'aria-label': t('ownerName'), onChange: function (event) { update('owner.name', event.target.value) } })),
        ),
      )
      var startTab = h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dsh-mailbox-quickstart' },
          h(
            'div',
            { className: 'dsh-mailbox-quickstart-head' },
            h('div', null, h('h3', { className: 'dsh-mailbox-card-title' }, t('quickTitle')), h('p', { className: 'dsh-mailbox-card-desc' }, t('quickDesc'))),
            h('span', { className: 'dsh-mailbox-quickstart-progress' }, String(doneCount) + ' / 4'),
          ),
          h('div', { className: 'dsh-mailbox-quickstart-bar', 'aria-hidden': 'true' }, h('span', { style: { width: String(Math.round((doneCount / 4) * 100)) + '%' } })),
          h(StepRow, { index: 1, done: stepDone[0], title: t('step1Title'), desc: t('step1Desc') }),
          h(StepRow, { index: 2, done: stepDone[1], title: t('step2Title'), desc: t('step2Desc'), action: h(UI.Button, { size: 'sm', variant: stepDone[1] ? 'ghost' : 'primary', onClick: function () { setTab('connect') } }, stepDone[1] ? t('stepReview') : t('stepGo')) }),
          h(StepRow, { index: 3, done: stepDone[2], title: t('step3Title'), desc: t('step3Desc'), action: h(UI.Button, { size: 'sm', variant: stepDone[2] ? 'ghost' : 'outline', onClick: function () { setTab('connect') } }, stepDone[2] ? t('stepReview') : t('stepTest')) }),
          h(StepRow, { index: 4, done: stepDone[3], title: t('step4Title'), desc: t('step4Desc'), action: h(UI.Button, { size: 'sm', variant: stepDone[3] ? 'ghost' : 'outline', onClick: function () { controller.saveSettings() } }, stepDone[3] ? t('saved') : t('save')) }),
        ),
        accountCard,
        h(
          Card,
          { title: t('securityNote') },
          h('p', { className: 'dsh-mailbox-card-desc' }, t('securityNoteBody')),
          h('div', { className: 'dsh-mailbox-actions' }, h(UI.Button, { size: 'sm', variant: 'outline', onClick: function () { controller.selectView('diagnostics') } }, t('navDiagnostics'))),
        ),
      )
      var connectTab = h(
        React.Fragment,
        null,
        h(
          Card,
          { title: t('provider'), desc: t('providerHint') },
          h(
            'div',
            { className: 'dsh-mailbox-provider-grid' },
            presets.map(function (preset) {
              return h(ProviderCard, {
                key: preset.id,
                t: t,
                label: preset.label,
                host: preset.smtp && preset.smtp.host ? preset.smtp.host : '',
                selected: smtpPresetId === preset.id || imapPresetId === preset.id,
                disabled: disabled,
                onSelect: function () { controller.applyPreset(preset.id) },
              })
            }),
          ),
          h(AuthGuide, { t: t, guide: smtpGuide, open: smtpConfigured !== true }),
        ),
        h(
          Card,
          { title: t('sectionSmtp'), desc: t('smtpHint') },
          h(
            'div',
            { className: 'dsh-mailbox-grid2' },
            h(Field, { label: t('smtpUser') }, h(UI.Input, { value: getPath(form, 'smtp.user', ''), placeholder: 'figaro1@qq.com', 'aria-label': t('smtpUser'), onChange: function (event) { update('smtp.user', event.target.value) } })),
            h(Field, { label: t('authCode'), hint: smtpConfigured ? t('authConfiguredHint') : undefined }, h('div', { className: 'dsh-mailbox-field-row' }, h(UI.Input, { type: 'password', autoComplete: 'new-password', value: getPath(form, 'secretsInput.smtpAuthCode', ''), placeholder: smtpConfigured ? t('authCodeConfigured') : t('authCodePlaceholder'), 'aria-label': t('authCode'), onChange: function (event) { controller.updateSecret('smtpAuthCode', event.target.value) } }), securitySource(smtpSecrets))),
          ),
          h(
            'div',
            { className: 'dsh-mailbox-grid3' },
            h(Field, { label: t('smtpHost') }, h(UI.Input, { value: getPath(form, 'smtp.host', ''), placeholder: 'smtp.qq.com', 'aria-label': t('smtpHost'), onChange: function (event) { update('smtp.host', event.target.value) } })),
            h(Field, { label: t('smtpPort'), error: controller.formErrors['smtp.port'] }, h(UI.Input, { type: 'number', min: 1, max: 65535, value: String(getPath(form, 'smtp.port', 465)), 'aria-label': t('smtpPort'), onChange: function (event) { update('smtp.port', Number(event.target.value)) } })),
            h(SelectField, { label: t('smtpSecurity'), value: getPath(form, 'smtp.security', 'tls'), options: [{ value: 'tls', label: 'TLS' }, { value: 'starttls', label: 'STARTTLS' }, { value: 'none', label: t('providerCustom') }], onChange: function (value) { update('smtp.security', value) } }),
          ),
          h(TestRow, { t: t, label: t('testSmtp'), result: controller.testResults.smtp, disabled: disabled, onTest: function () { controller.testConnection('smtp') } }),
        ),
        h(
          Card,
          { title: t('sectionImap'), desc: t('imapHint') },
          h(SwitchRow, { label: t('imapEnabled'), checked: getPath(form, 'imap.enabled', true) === true, onChange: function (value) { update('imap.enabled', value) } }),
          h(
            'div',
            { className: 'dsh-mailbox-grid2' },
            h(Field, { label: t('imapUser') }, h(UI.Input, { value: getPath(form, 'imap.user', ''), placeholder: 'figaro1@qq.com', 'aria-label': t('imapUser'), onChange: function (event) { update('imap.user', event.target.value) } })),
            h(Field, { label: t('authCode'), hint: imapConfigured ? t('authConfiguredHint') : undefined }, h('div', { className: 'dsh-mailbox-field-row' }, h(UI.Input, { type: 'password', autoComplete: 'new-password', value: getPath(form, 'secretsInput.imapAuthCode', ''), placeholder: imapConfigured ? t('authCodeConfigured') : t('authCodePlaceholder'), 'aria-label': t('authCode'), onChange: function (event) { controller.updateSecret('imapAuthCode', event.target.value) } }), securitySource(imapSecrets))),
          ),
          h(
            'div',
            { className: 'dsh-mailbox-grid3' },
            h(Field, { label: t('imapHost') }, h(UI.Input, { value: getPath(form, 'imap.host', ''), placeholder: 'imap.qq.com', 'aria-label': t('imapHost'), onChange: function (event) { update('imap.host', event.target.value) } })),
            h(Field, { label: t('imapPort'), error: controller.formErrors['imap.port'] }, h(UI.Input, { type: 'number', min: 1, max: 65535, value: String(getPath(form, 'imap.port', 993)), 'aria-label': t('imapPort'), onChange: function (event) { update('imap.port', Number(event.target.value)) } })),
            h(SelectField, { label: t('imapSecurity'), value: getPath(form, 'imap.security', 'tls'), options: [{ value: 'tls', label: 'TLS' }, { value: 'starttls', label: 'STARTTLS' }, { value: 'none', label: t('providerCustom') }], onChange: function (value) { update('imap.security', value) } }),
          ),
          h(
            'div',
            { className: 'dsh-mailbox-grid2' },
            h(Field, { label: t('imapMailbox') }, h(UI.Input, { value: getPath(form, 'imap.mailbox', 'INBOX'), 'aria-label': t('imapMailbox'), onChange: function (event) { update('imap.mailbox', event.target.value) } })),
            h(Field, { label: t('pollIntervalLabel'), hint: t('pollIntervalHint') }, h(UI.Input, { type: 'number', min: 15, value: String(getPath(form, 'imap.pollIntervalSeconds', 120)), 'aria-label': t('pollIntervalLabel'), onChange: function (event) { update('imap.pollIntervalSeconds', Number(event.target.value)) } })),
          ),
          h(SwitchRow, { label: t('clearSecrets'), hint: t('clearSecretsHint'), checked: getPath(form, 'clearSecrets', false) === true, onChange: function (value) { update('clearSecrets', value) } }),
          h(AuthGuide, { t: t, guide: imapGuide, open: imapConfigured !== true }),
          h(TestRow, { t: t, label: t('testImap'), result: controller.testResults.imap, disabled: disabled, onTest: function () { controller.testConnection('imap') } }),
        ),
      )
      var targetOptions = [
        { value: 'dedicated', label: t('notifyDedicated') },
        { value: 'latest', label: t('notifyLatest') },
        { value: 'all', label: t('notifyAll') },
      ]
      controller.sessions.forEach(function (session) {
        if (session && typeof session.sessionId === 'string') targetOptions.push({ value: session.sessionId, label: t('notifySpecific') + '：' + (session.title || session.sessionId) })
      })
      var currentTarget = getPath(form, 'notify.target', 'dedicated')
      if (!targetOptions.some(function (option) { return option.value === currentTarget })) targetOptions.push({ value: currentTarget, label: currentTarget })
      var targetHint = currentTarget === 'dedicated'
        ? t('notifyDedicatedHint')
        : currentTarget === 'all'
          ? t('notifyAllHint')
          : currentTarget === 'latest'
            ? t('notifyLatestHint')
            : t('notifySpecificHint')
      var dedicatedSessionId = String(getPath(data, 'config.notify.dedicatedSessionId', '') || getPath(data, 'notifications.dedicatedSessionId', '') || '')
      var dedicatedLine = currentTarget === 'dedicated'
        ? (dedicatedSessionId === '' ? t('notifyDedicatedPending') : t('notifyDedicatedTarget', { id: shortId(dedicatedSessionId) }))
        : null
      var notifyTestResult = controller.notifyTestResult
      var policy = getPath(form, 'friends.policy', 'auto')
      var policyChoices = [
        { value: 'auto', label: t('policyAuto'), desc: t('policyAutoDesc') },
        { value: 'ask', label: t('policyAsk'), desc: t('policyAskDesc') },
        { value: 'manual', label: t('policyManual'), desc: t('policyManualDesc') },
      ]
      var notifyTab = h(
        React.Fragment,
        null,
        h(
          Card,
          { title: t('sectionNotify'), desc: t('notifyDesc') },
          h(SwitchRow, { label: t('notifyEnabled'), checked: getPath(form, 'notify.enabled', true) === true, onChange: function (value) { update('notify.enabled', value) } }),
          h(
            'div',
            { className: 'dsh-mailbox-grid2' },
            h(SelectField, { label: t('notifyTarget'), hint: targetHint, value: currentTarget, options: targetOptions, onChange: function (value) { update('notify.target', value) } }),
            h(SelectField, { label: t('strangerPolicy'), hint: t('strangerPolicyHint'), value: getPath(form, 'notify.strangerMail', 'notify'), options: [{ value: 'notify', label: t('strangerNotify') }, { value: 'quarantine', label: t('strangerQuarantine') }, { value: 'ignore', label: t('strangerIgnore') }], onChange: function (value) { update('notify.strangerMail', value) } }),
            h(Field, { label: t('batchSeconds'), hint: t('batchSecondsHint') }, h(UI.Input, { type: 'number', min: 0, value: String(getPath(form, 'notify.batchSeconds', 30)), 'aria-label': t('batchSeconds'), onChange: function (event) { update('notify.batchSeconds', Number(event.target.value)) } })),
            h(Field, { label: t('maxPreviewChars') }, h(UI.Input, { type: 'number', min: 50, value: String(getPath(form, 'notify.maxPreviewChars', 200)), 'aria-label': t('maxPreviewChars'), onChange: function (event) { update('notify.maxPreviewChars', Number(event.target.value)) } })),
          ),
          dedicatedLine !== null ? h('p', { className: 'dsh-mailbox-field-hint', style: { marginTop: 6 } }, dedicatedLine) : null,
          h(
            'div',
            { className: 'dsh-mailbox-test-row' },
            h(UI.Button, {
              size: 'sm',
              variant: 'outline',
              disabled: disabled === true || controller.busy.notifyTest === true,
              onClick: function () { controller.notifyTest('') },
            }, controller.busy.notifyTest === true ? h(Spinner, { size: 12 }) : h(Icon, { name: 'send', size: 13 }), ' ', t('notifyTest')),
            notifyTestResult !== null
              ? h('span', { className: 'dsh-mailbox-test-result', 'data-tone': notifyTestResult.delivered === true ? 'ok' : 'error', role: 'status' },
                  notifyTestResult.delivered === true ? h(Icon, { name: 'check', size: 13 }) : null,
                  notifyTestResult.message,
                  notifyTestResult.sessionId !== '' ? ' · ' + shortId(notifyTestResult.sessionId) : '')
              : null,
          ),
        ),
        h(
          Card,
          { title: t('sectionFriends'), desc: t('friendPolicyDesc') },
          h(
            'div',
            { className: 'dsh-mailbox-policy-grid', role: 'radiogroup', 'aria-label': t('friendPolicy') },
            policyChoices.map(function (choice) {
              return h(
                'button',
                {
                  key: choice.value,
                  type: 'button',
                  role: 'radio',
                  'aria-checked': policy === choice.value ? 'true' : 'false',
                  className: 'dsh-mailbox-policy',
                  disabled: disabled,
                  onClick: function () { update('friends.policy', choice.value) },
                },
                h('span', { className: 'dsh-mailbox-policy-name' }, choice.label, policy === choice.value ? h(Icon, { name: 'check', size: 12 }) : null),
                h('span', { className: 'dsh-mailbox-policy-desc' }, choice.desc),
              )
            }),
          ),
          h(SwitchRow, { label: t('defaultAutoReply'), hint: t('autoReplyHint'), checked: getPath(form, 'friends.defaultAutoReply', false) === true, onChange: function (value) { update('friends.defaultAutoReply', value) } }),
        ),
      )
      var advancedTab = h(
        React.Fragment,
        null,
        h(
          AdvancedSection,
          { title: t('sectionLetter'), desc: t('advancedLetterDesc') },
          h(
            'div',
            { className: 'dsh-mailbox-grid2' },
            h(Field, { label: t('salutation') }, h(UI.Input, { value: getPath(form, 'mailbox.salutation', ''), 'aria-label': t('salutation'), onChange: function (event) { update('mailbox.salutation', event.target.value) } })),
            h(Field, { label: t('greeting') }, h(UI.Input, { value: getPath(form, 'mailbox.greeting', ''), 'aria-label': t('greeting'), onChange: function (event) { update('mailbox.greeting', event.target.value) } })),
            h(Field, { label: t('signature') }, h(UI.Input, { value: getPath(form, 'mailbox.signature', ''), 'aria-label': t('signature'), onChange: function (event) { update('mailbox.signature', event.target.value) } })),
            h(Field, { label: t('subjectPrefix') }, h(UI.Input, { value: getPath(form, 'mailbox.subjectPrefix', ''), 'aria-label': t('subjectPrefix'), onChange: function (event) { update('mailbox.subjectPrefix', event.target.value) } })),
          ),
          h(SwitchRow, { label: t('letterhead'), checked: getPath(form, 'mailbox.letterhead', true) === true, onChange: function (value) { update('mailbox.letterhead', value) } }),
        ),
        h(
          AdvancedSection,
          { title: t('sectionPrompt'), desc: t('advancedPromptDesc') },
          h(
            'div',
            { className: 'dsh-mailbox-grid2' },
            h(SelectField, { label: t('promptLanguage'), value: getPath(form, 'prompt.language', 'zh'), options: [{ value: 'zh', label: t('promptZh') }, { value: 'en', label: t('promptEn') }, { value: 'both', label: t('promptBoth') }], onChange: function (value) { update('prompt.language', value) } }),
            h(Field, { label: t('maxPromptFriends') }, h(UI.Input, { type: 'number', value: String(getPath(form, 'prompt.maxFriendListInPrompt', 30)), 'aria-label': t('maxPromptFriends'), onChange: function (event) { update('prompt.maxFriendListInPrompt', Number(event.target.value)) } })),
          ),
          h(SwitchRow, { label: t('includeFriendList'), checked: getPath(form, 'prompt.includeFriendListInSystemPrompt', true) === true, onChange: function (value) { update('prompt.includeFriendListInSystemPrompt', value) } }),
          h(Field, { label: t('extraNote') }, h('textarea', { value: getPath(form, 'prompt.extraNote', ''), placeholder: t('extraNotePlaceholder'), 'aria-label': t('extraNote'), rows: 3, onChange: function (event) { update('prompt.extraNote', event.target.value) } })),
        ),
        h(
          AdvancedSection,
          { title: t('sectionSecurity'), desc: t('advancedSecurityDesc') },
          h(
            'div',
            { className: 'dsh-mailbox-grid2' },
            h(Field, { label: t('maxSendsPerHour') }, h(UI.Input, { type: 'number', min: 1, value: String(getPath(form, 'security.maxSendsPerHour', 20)), 'aria-label': t('maxSendsPerHour'), onChange: function (event) { update('security.maxSendsPerHour', Number(event.target.value)) } })),
            h(Field, { label: t('maxFriendAddsPerDay') }, h(UI.Input, { type: 'number', min: 0, value: String(getPath(form, 'security.maxFriendAddsPerDay', 3)), 'aria-label': t('maxFriendAddsPerDay'), onChange: function (event) { update('security.maxFriendAddsPerDay', Number(event.target.value)) } })),
            h(Field, { label: t('maxMessagesRetained') }, h(UI.Input, { type: 'number', min: 50, value: String(getPath(form, 'security.maxMessagesRetained', 500)), 'aria-label': t('maxMessagesRetained'), onChange: function (event) { update('security.maxMessagesRetained', Number(event.target.value)) } })),
          ),
          h(SwitchRow, { label: t('quarantineSuspicious'), checked: getPath(form, 'security.quarantineSuspicious', true) === true, onChange: function (value) { update('security.quarantineSuspicious', value) } }),
          h(SwitchRow, { label: t('allowRemoteImages'), checked: getPath(form, 'security.allowRemoteImages', false) === true, onChange: function (value) { update('security.allowRemoteImages', value) } }),
        ),
        h(
          AdvancedSection,
          { title: t('advancedUiTitle'), desc: t('advancedUiDesc') },
          h(SelectField, { label: t('uiLanguage'), value: getPath(form, 'ui.locale', 'zh'), options: [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }], onChange: function (value) { update('ui.locale', value) } }),
          h(Field, { label: t('dataDirLabel'), hint: t('dataDirHint') }, h(UI.Input, { value: getPath(data, 'dataDir', ''), readOnly: true, 'aria-label': t('dataDirLabel') })),
        ),
      )
      var tabPanel
      if (tab === 'start') tabPanel = startTab
      else if (tab === 'connect') tabPanel = connectTab
      else if (tab === 'notify') tabPanel = notifyTab
      else tabPanel = advancedTab
      return h(
        'div',
        { className: 'dsh-mailbox-view' },
        h(
          'div',
          { className: 'dsh-mailbox-view-scroll dsh-mailbox-settings-scroll' },
          h(
            'div',
            { className: 'dsh-mailbox-view-inner dsh-mailbox-settings-inner' },
            masterCard,
            tabBar,
            h(fieldsetLike, { className: 'dsh-mailbox-settings-fields', disabled: disabled === true }, tabPanel),
            h('div', { className: 'dsh-mailbox-note' }, h(Icon, { name: 'lock', size: 14 }), h('span', null, t('securityNoteBody'))),
            h(
              'div',
              { className: 'dsh-mailbox-savebar' },
              h('span', { className: 'dsh-mailbox-toolbar-chip', role: 'status' }, controller.formDirty === true ? t('unsaved') : t('saveBarClean')),
              h(
                'span',
                { className: 'dsh-mailbox-actions', style: { paddingTop: 0 } },
                h(UI.Button, { variant: 'outline', disabled: disabled || saving, onClick: function () { controller.askConfirm({ title: t('resetTitle'), body: t('resetBody'), confirmLabel: t('reset'), danger: true, run: function () { return controller.resetSettings() } }) } }, t('reset')),
                h(UI.Button, { variant: 'primary', disabled: disabled || saving, onClick: function () { controller.saveSettings() } }, saving ? h(Spinner, { size: 12 }) : h(Icon, { name: 'check', size: 14 }), ' ', saving ? t('saving') : t('save')),
              ),
            ),
          ),
        ),
      )
    }

    // fieldset 语义：整块禁用时不再交互；React 用 fieldset 标签即可。
    var fieldsetLike = 'fieldset'

    // ------------------------------------------------------------- 诊断
    function DiagItem(props) {
      return h('div', { className: 'dsh-mailbox-diag-item' }, h('span', null, props.label), h('b', null, props.value === undefined || props.value === null || props.value === '' ? '—' : String(props.value)))
    }

    function DiagnosticsView(props) {
      var t = props.t
      var controller = props.controller
      var state = controller.diagState
      var data = state.data
      var sessions = controller.sessions
      var [notifySession, setNotifySession] = React.useState('')
      var [clearOpen, setClearOpen] = React.useState(false)
      var [clearText, setClearText] = React.useState('')
      React.useEffect(function () {
        if (state.status === 'idle') controller.loadDiagnostics()
      }, [])
      var body
      if (state.status === 'loading' && data === null) body = h(SkeletonReader, null)
      else if (state.status === 'error')
        body = h(ErrorView, { t: t, message: state.error, hint: t('diagUnavailable'), actions: h(UI.Button, { size: 'sm', variant: 'outline', onClick: controller.loadDiagnostics }, t('errorRetry')) })
      else if (data === null) body = h(EmptyState, { icon: 'diagnostics', title: t('diagTitle'), hint: t('diagUnavailable') })
      else {
        var store = data.store || {}
        var sync = data.sync || {}
        var notifications = data.notifications || {}
        body = h(
          React.Fragment,
          null,
          h(
            Card,
            { title: t('diagHealth') },
            h(
              'div',
              { className: 'dsh-mailbox-diag-grid' },
              h(DiagItem, { label: t('diagVersion'), value: data.version }),
              h(DiagItem, { label: t('diagNode'), value: data.node }),
              h(DiagItem, { label: t('diagPlatform'), value: data.platform }),
              h(DiagItem, { label: t('masterTitle'), value: data.pluginEnabled === true ? t('masterOn') : t('masterOff') }),
              h(DiagItem, { label: t('diagLastSync'), value: sync.lastSyncAt ? formatAbsoluteTime(sync.lastSyncAt, 'zh') : t('never') || '—' }),
              h(DiagItem, { label: t('diagLastError'), value: sync.lastError }),
              h(DiagItem, { label: t('diagMessages'), value: store.messages }),
              h(DiagItem, { label: t('diagBytes'), value: store.bytes !== undefined ? formatBytes(store.bytes) : '' }),
              h(DiagItem, { label: t('diagQueue'), value: notifications.queued }),
            ),
            h(
              'div',
              { className: 'dsh-mailbox-actions', style: { marginTop: 12 } },
              h(UI.Button, { size: 'sm', variant: 'outline', onClick: controller.loadDiagnostics }, t('refresh')),
              h(UI.Button, { size: 'sm', variant: 'outline', disabled: controller.busy.sync === true, onClick: function () { controller.syncNow() } }, controller.busy.sync === true ? h(Spinner, { size: 12 }) : null, ' ', t('diagSyncNow')),
              h(UI.Button, { size: 'sm', variant: 'outline', disabled: controller.busy.notifyTest === true, onClick: function () { controller.notifyTest(notifySession) } }, controller.busy.notifyTest === true ? h(Spinner, { size: 12 }) : null, ' ', t('diagTestNotify')),
            ),
            controller.notifyTestResult !== null
              ? h('p', { className: 'dsh-mailbox-test-result', 'data-tone': controller.notifyTestResult.delivered === true ? 'ok' : 'error', role: 'status', style: { marginTop: 8 } }, controller.notifyTestResult.message, controller.notifyTestResult.sessionId !== '' ? ' · ' + shortId(controller.notifyTestResult.sessionId) : '')
              : null,
            sessions.length > 0
              ? h('div', { style: { marginTop: 10, maxWidth: 420 } }, h(SelectField, { label: t('diagSessions'), hint: t('notifyDedicatedPending'), value: notifySession, options: [{ value: '', label: t('notifyUseTarget') }].concat(sessions.map(function (session) { return { value: session.sessionId, label: session.title || session.sessionId } })), onChange: setNotifySession }))
              : null,
          ),
          h(
            Card,
            { title: t('diagDataDir') },
            h('pre', { className: 'dsh-mailbox-code' }, String(data.dataDir || '')),
            h(
              'div',
              { className: 'dsh-mailbox-actions', style: { marginTop: 10 } },
              h(UI.Button, { size: 'sm', variant: 'outline', onClick: function () { controller.copyText(data.dataDir) } }, h(Icon, { name: 'copy', size: 13 }), ' ', t('copy')),
            ),
          ),
          h(
            Card,
            { title: t('diagTools') },
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, (Array.isArray(data.tools) ? data.tools : []).map(function (tool) { return h('span', { key: tool, className: 'dsh-mailbox-tag' }, tool) })),
          ),
          h(
            Card,
            { title: t('diagOpenInDsh') },
            h('p', { className: 'dsh-mailbox-card-desc' }, t('diagOpenInDshBody')),
          ),
          h(
            Card,
            { title: t('sectionPrivacy'), desc: t('diagClearBody'), danger: true },
            h(
              'div',
              { className: 'dsh-mailbox-actions' },
              h(UI.Button, { size: 'sm', variant: 'outline', style: { color: 'var(--dsw-alias-state-error-primary)' }, onClick: function () { setClearOpen(true); setClearText('') } }, h(Icon, { name: 'trash', size: 13 }), ' ', t('diagClear')),
            ),
          ),
          clearOpen
            ? h(UI.Modal, {
                open: true,
                title: t('diagClearTitle'),
                description: t('diagClearBody'),
                closeLabel: t('cancel'),
                onClose: function () { setClearOpen(false) },
                footer: h(
                  'div',
                  { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                  h(UI.Button, { variant: 'outline', onClick: function () { setClearOpen(false) } }, t('cancel')),
                  h(UI.Button, { variant: 'primary', disabled: controller.busy.clearData === true, onClick: function () { setClearOpen(false); controller.clearData() } }, controller.busy.clearData === true ? h(Spinner, { size: 12 }) : null, ' ', t('diagClear')),
                ),
                children: h(Field, { label: t('diagClearType') }, h(UI.Input, { value: clearText, placeholder: t('diagClearPlaceholder'), 'aria-label': t('diagClearType'), onChange: function (event) { setClearText(event.target.value) } })),
              })
            : null,
        )
      }
      return h('div', { className: 'dsh-mailbox-view' }, h('div', { className: 'dsh-mailbox-view-scroll' }, h('div', { className: 'dsh-mailbox-view-inner' }, body)))
    }

    // ------------------------------------------------------------- 停用态
    function DisabledView(props) {
      var t = props.t
      var controller = props.controller
      return h(
        'div',
        { className: 'dsh-mailbox-view' },
        h(
          'div',
          { className: 'dsh-mailbox-view-scroll' },
          h(
            'div',
            { className: 'dsh-mailbox-view-inner' },
            h(
              'div',
              { className: 'dsh-mailbox-card', style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10 } },
              h('div', { className: 'dsh-mailbox-empty-art' }, h(Icon, { name: 'lock', size: 26 })),
              h('h3', { className: 'dsh-mailbox-card-title' }, t('disabledTitle')),
              h('p', { className: 'dsh-mailbox-card-desc' }, t('disabledBody')),
              h(
                'div',
                { className: 'dsh-mailbox-actions' },
                h(UI.Button, { variant: 'primary', onClick: function () { controller.askConfirm({ title: t('masterEnableTitle'), body: t('masterEnableBody'), confirmLabel: t('disabledEnable'), danger: false, run: function () { return controller.masterSwitch(true) } }) } }, t('disabledEnable')),
                h(UI.Button, { variant: 'outline', onClick: function () { controller.selectView('settings') } }, t('disabledGoSettings')),
              ),
            ),
          ),
        ),
      )
    }

    // ------------------------------------------------------------- 页面壳
    function useMediaQuery(query) {
      var get = function () {
        try {
          if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') return window.matchMedia(query).matches === true
        } catch (_error) {
          return false
        }
        return false
      }
      var [matches, setMatches] = React.useState(get)
      React.useEffect(function () {
        try {
          if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
          var list = window.matchMedia(query)
          var handler = function (event) { setMatches(event.matches === true) }
          setMatches(list.matches === true)
          if (typeof list.addEventListener === 'function') {
            list.addEventListener('change', handler)
            return function () { list.removeEventListener('change', handler) }
          }
          list.addListener(handler)
          return function () { list.removeListener(handler) }
        } catch (_error) {
          return undefined
        }
      }, [query])
      return matches
    }

    function mailStatus(t, data) {
      if (data === null) return { tone: 'busy', label: t('statusConnecting') }
      if (data.enabled === false) return { tone: 'warn', label: t('statusDisabled') }
      var connections = data.connections || {}
      var smtp = connections.smtp || {}
      var imap = connections.imap || {}
      if (smtp.configured !== true && imap.configured !== true) return { tone: 'warn', label: t('statusNotConfigured') }
      var sync = data.sync || {}
      var imapEnabled = imap.enabled !== false
      if (imapEnabled && sync.enabled !== false && typeof sync.lastError === 'string' && sync.lastError !== '') return { tone: 'error', label: t('statusError') }
      return { tone: 'ok', label: t('statusConnected') }
    }

    function StatusPill(props) {
      var status = props.status
      return h(
        'span',
        { className: 'dsh-mailbox-status', 'data-tone': status.tone, role: 'status', 'aria-label': props.t('statusAria') + '：' + status.label, title: status.label },
        h('span', { className: 'dsh-mailbox-status-dot', 'aria-hidden': 'true' }),
        h('span', null, status.label),
      )
    }

    function IconButton(props) {
      return h(
        UI.Tooltip,
        { label: props.label, side: 'bottom', portal: true },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-mailbox-inline-tab',
            style: { height: 28, padding: '0 9px' },
            'aria-label': props.label,
            disabled: props.disabled === true,
            onClick: props.onClick,
          },
          props.spinning === true ? h(Spinner, { size: 14 }) : h(Icon, { name: props.icon, size: 14 }),
        ),
      )
    }

    function NotConfiguredBanner(props) {
      return h(
        'div',
        { className: 'dsh-mailbox-banner', 'data-tone': 'warn', role: 'status', style: { margin: '0 0 10px', alignItems: 'center' } },
        h(Icon, { name: 'key', size: 15 }),
        h('span', { style: { flex: 1 } }, props.t('notConfiguredBody')),
        h(UI.Button, { size: 'sm', variant: 'outline', onClick: props.onGoSettings }, props.t('notConfiguredCta')),
      )
    }

    function MailboxRoot(props) {
      var t = props.t
      var controller = useMailboxController()
      var narrow = useMediaQuery('(max-width: 767px)')
      var data = controller.snapshot.data
      var disabled = data !== null && data.enabled === false
      var status = mailStatus(t, data)
      var counts = data !== null && data.counts ? data.counts : {}
      var connections = data !== null && data.connections ? data.connections : {}
      var smtpConfigured = getPath(data, 'connections.smtp.configured', false) === true
      var imapConfigured = getPath(data, 'connections.imap.configured', false) === true
      var notConfigured = data !== null && data.enabled !== false && smtpConfigured !== true && imapConfigured !== true
      var isMailView = MAIL_VIEWS.indexOf(controller.view) >= 0

      var header = h(
        'header',
        { className: 'dsh-mailbox-header' },
        h(
          'div',
          { className: 'dsh-mailbox-header-main' },
          h('h1', { className: 'dsh-mailbox-title' }, t('title')),
          h('p', { className: 'dsh-mailbox-subtitle' }, t('subtitle')),
        ),
        h(
          'div',
          { className: 'dsh-mailbox-header-actions' },
          h(StatusPill, { t: t, status: status }),
          h(IconButton, { icon: 'refresh', label: t('refresh'), onClick: function () { controller.refreshSnapshot(); if (isMailView) controller.loadList() }, disabled: disabled }),
          isMailView
            ? h(IconButton, { icon: 'inbox', label: t('syncNow'), spinning: controller.busy.sync === true, disabled: disabled || controller.busy.sync === true, onClick: function () { controller.syncNow() } })
            : null,
          h(UI.Button, { variant: 'primary', disabled: disabled, onClick: function () { controller.openComposer({ mode: 'new', to: getPath(data, 'config.owner.address', '') }) } }, h(Icon, { name: 'compose', size: 14 }), ' ', t('compose')),
        ),
      )

      var banner = null
      if (disabled) {
        banner = h(
          'div',
          { className: 'dsh-mailbox-banner-page', role: 'status' },
          h(Icon, { name: 'lock', size: 16 }),
          h('div', { className: 'dsh-mailbox-banner-page-text' }, h('b', null, t('disabledBannerTitle')), h('span', null, t('disabledBannerBody'))),
          h(
            'div',
            { className: 'dsh-mailbox-banner-page-actions' },
            h(UI.Button, { size: 'sm', variant: 'outline', onClick: function () { controller.selectView('settings') } }, t('disabledGoSettings')),
            h(UI.Button, { size: 'sm', variant: 'primary', disabled: controller.busy.master === true, onClick: function () { controller.askConfirm({ title: t('masterEnableTitle'), body: t('masterEnableBody'), confirmLabel: t('disabledEnable'), danger: false, run: function () { return controller.masterSwitch(true) } }) } }, t('disabledEnable')),
          ),
        )
      }

      var nav = h(FolderNav, {
        t: t,
        view: controller.view,
        counts: counts,
        disabled: disabled,
        onSelect: controller.selectView,
        footer: h(
          'div',
          { className: 'dsh-mailbox-nav-foot' },
          h('div', { className: 'dsh-mailbox-nav-foot-row' }, h(Icon, { name: 'mail', size: 13 }), h('span', null, getPath(data, 'config.mailbox.address', '') || t('statusNotConfigured'))),
          h('div', { className: 'dsh-mailbox-nav-foot-row' }, h(Icon, { name: 'users', size: 13 }), h('span', null, String(counts.friends || 0) + ' ' + t('navFriends'))),
          h('div', { className: 'dsh-mailbox-nav-foot-row' }, h(Icon, { name: 'shield', size: 13 }), h('span', null, t('navQuarantine') + ' ' + String(counts.quarantine || 0))),
        ),
      })

      var content
      if (disabled && !isMailView && controller.view !== 'settings' && controller.view !== 'diagnostics') {
        content = h(DisabledView, { t: t, controller: controller })
      } else if (disabled && isMailView) {
        content = h(DisabledView, { t: t, controller: controller })
      } else if (isMailView) {
        content = h(
          'div',
          { className: 'dsh-mailbox-columns' },
          h(MailList, { t: t, controller: controller, notConfigured: notConfigured, onGoSettings: function () { controller.selectView('settings') } }),
          !narrow || controller.selectedId !== '' ? h(Reader, { t: t, controller: controller, narrow: narrow }) : null,
        )
      } else if (controller.view === 'friends') {
        content = h(FriendsView, { t: t, controller: controller })
      } else if (controller.view === 'settings') {
        content = h(SettingsView, { t: t, controller: controller })
      } else {
        content = h(DiagnosticsView, { t: t, controller: controller })
      }

      var main = h(
        'div',
        { className: 'dsh-mailbox-main' },
        notConfigured && isMailView && disabled !== true ? h(NotConfiguredBanner, { t: t, onGoSettings: function () { controller.selectView('settings') } }) : null,
        content,
      )

      return h(
        'div',
        { className: 'dsh-mailbox-root' },
        header,
        banner,
        h('div', { className: 'dsh-mailbox-body' }, nav, main),
        h(Composer, { t: t, controller: controller }),
        h(ConfirmDialog, {
          t: t,
          open: controller.confirmState !== null,
          title: controller.confirmState === null ? '' : controller.confirmState.title,
          body: controller.confirmState === null ? '' : controller.confirmState.body,
          confirmLabel: controller.confirmState === null ? '' : controller.confirmState.confirmLabel,
          danger: controller.confirmState !== null && controller.confirmState.danger === true,
          busy: false,
          children: controller.confirmState === null ? null : controller.confirmState.children,
          onCancel: controller.closeConfirm,
          onConfirm: function () {
            var state = controller.confirmState
            if (state === null) return
            controller.closeConfirm()
            if (typeof state.run === 'function') state.run()
          },
        }),
        h(ToastStack, { toasts: controller.toasts, onDone: controller.dismissToast }),
      )
    }

    function MailboxPage(props) {
      return h(MailboxRoot, { t: props.t })
    }

    function MailboxSettingsPage(props) {
      var t = props.t
      var controller = useMailboxController()
      return h(
        'div',
        { className: 'dsh-mailbox-root', style: { background: 'transparent' } },
        h(
          'div',
          { className: 'dsh-mailbox-settings-page' },
          h(
            'div',
            { className: 'dsh-mailbox-settings-page-inner' },
            h('h2', { className: 'dsh-mailbox-title', style: { fontSize: 16, lineHeight: '24px' } }, t('settingsTitle')),
            controller.snapshot.status === 'loading' ? h(SkeletonReader, null) : controller.snapshot.status === 'error' ? h(ErrorView, { t: t, message: controller.snapshot.error, hint: t('errorHost'), actions: h(UI.Button, { size: 'sm', variant: 'outline', onClick: function () { controller.refreshSnapshot() } }, t('errorRetry')) }) : h(SettingsView, { t: t, controller: controller }),
          ),
        ),
        h(ConfirmDialog, {
          t: t,
          open: controller.confirmState !== null,
          title: controller.confirmState === null ? '' : controller.confirmState.title,
          body: controller.confirmState === null ? '' : controller.confirmState.body,
          confirmLabel: controller.confirmState === null ? '' : controller.confirmState.confirmLabel,
          danger: controller.confirmState !== null && controller.confirmState.danger === true,
          busy: false,
          children: null,
          onCancel: controller.closeConfirm,
          onConfirm: function () {
            var state = controller.confirmState
            if (state === null) return
            controller.closeConfirm()
            if (typeof state.run === 'function') state.run()
          },
        }),
        h(ToastStack, { toasts: controller.toasts, onDone: controller.dismissToast }),
      )
    }

    // ------------------------------------------------------------- 入口
    function MailboxPanelIcon(props) {
      var unread = useUnread()
      var size = props !== null && props !== undefined && Number(props.size) > 0 ? Number(props.size) : 16
      var showBadge = unread.enabled !== false && Number(unread.unread) > 0
      return h(
        'span',
        { className: 'dsh-mailbox-entry' },
        h(Icon, { name: 'mail', size: size }),
        showBadge ? h('span', { className: 'dsh-mailbox-entry-badge', 'aria-hidden': 'true' }, Number(unread.unread) > 99 ? '99+' : String(unread.unread)) : null,
      )
    }

    function MailboxHeaderAction(props) {
      var unread = useUnread()
      var t = props.t
      var label = typeof t === 'function' ? t('entryAria') : 'Mailbox'
      var showDot = unread.enabled !== false && Number(unread.unread) > 0
      var onOpen = props.openMailbox
      if (typeof onOpen !== 'function' && typeof window !== 'undefined') {
        onOpen = function () { /* 由注册时注入；这里是防御性空实现 */ }
      }
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-mailbox-entry-button',
          'aria-label': showDot ? label + '（' + String(unread.unread) + '）' : label,
          title: label,
          onClick: function () {
            if (typeof props.openMailbox === 'function') props.openMailbox()
          },
        },
        h(Icon, { name: 'mail', size: 16 }),
        showDot ? h('span', { className: 'dsh-mailbox-entry-dot', 'aria-hidden': 'true' }) : null,
      )
    }

    // ------------------------------------------------------------- 注册
    function apply(ctx) {
      // CSS：data-plugin 标记 + effect 清理（与 dsh-drawai 相同模式）。
      var styleElement = document.createElement('style')
      styleElement.setAttribute('data-plugin', PLUGIN_ID)
      styleElement.setAttribute('data-plugin-css', PLUGIN_ID + '/client.css')
      styleElement.textContent = CSS
      document.head.appendChild(styleElement)
      ctx.effect(function () {
        return function () {
          if (styleElement.parentNode !== null) styleElement.parentNode.removeChild(styleElement)
        }
      }, 'mailbox: styles')

      ctx.effect(function () {
        return ctx.locale.register(NS, DICT)
      }, 'mailbox: dictionaries')
      var t = ctx.locale.bind(NS)
      setGlobalTranslator(t)

      // 未读徽标：入口组件共享一个 60s 轮询 + 页面内数据更新时同步。
      ctx.effect(function () {
        return unreadStore.start()
      }, 'mailbox: unread badge poll')

      // ① 左侧主导航页面。
      ctx.effect(function () {
        return ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, MailboxPage)
        })
      }, 'mailbox: main page')

      // ② 左侧导航行（未读数字徽标画在图标里）。
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 30, locale: NS, label: function () { return t('panel') } },
            MailboxPanelIcon,
          )
        })
      }, 'mailbox: sidebar row')

      // ③ 设置页入口（设置 → 插件 → 邮箱）。
      ctx.effect(function () {
        return ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            { name: 'settings.section', id: 'mailbox', order: 40, locale: NS, label: function () { return t('panel') } },
            MailboxSettingsPage,
          )
        })
      }, 'mailbox: settings section')

      // ④ 会话头部常驻入口（会话标题右侧的邮箱按钮）。
      ctx.effect(function () {
        return ctx.slots.inject('conversation.session.header.utilities', function () {
          return ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'mailbox',
              order: 10,
              locale: NS,
              inject: function () {
                return {
                  openMailbox: function () {
                    ctx.layout.selectPanel(PANEL_ID)
                  },
                }
              },
            },
            MailboxHeaderAction,
          )
        })
      }, 'mailbox: session header action')

      // ⑤ 命令面板：/mailbox 打开邮箱页面（不提交消息）。
      ctx.inject(['commandUi'], function (scope) {
        scope.effect(
          function () {
            return scope.commandUi.register({
              name: 'mailbox',
              label: function () { return t('panel') },
              description: function () { return t('subtitle') },
              available: function () { return true },
              icon: null,
              ui: {
                kind: 'action',
                run: function () {
                  ctx.layout.selectPanel(PANEL_ID)
                },
              },
            })
          },
          'mailbox: /mailbox command',
        )
      })
    }

    exports.name = 'mailbox'
    exports.inject = ['slots', 'locale', 'layout']
    exports.apply = apply
    // 供 test/client-bundle.test.js 校验字典与 locale/*.json 一致（不参与运行时注册）。
    exports.__locale = DICT
    return module.exports
  },
})
