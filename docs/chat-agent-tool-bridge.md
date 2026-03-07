**总览**
- Chat 模块的总体目录说明在 `src/vs/workbench/contrib/chat/chatCodeOrganization.md:1`
- Workbench 挂载入口在 `src/vs/workbench/workbench.common.main.ts:210` 和 `src/vs/workbench/workbench.desktop.main.ts:180`
- Chat 相关 workbench contribution 注册集中在 `src/vs/workbench/contrib/chat/browser/chat.contribution.ts:1717`
- Widget 服务注册点在 `src/vs/workbench/contrib/chat/browser/chat.contribution.ts:1791`

**一张图**
- 用户输入消息 → `ChatSubmitAction` → `ChatWidget.acceptInput()` → `ChatWidget._acceptInput()` → `IChatService.sendRequest()` → `ChatService.sendRequest()` / `_sendRequestAsync()` → `IChatAgentService.invokeAgent()` 或 slash command 分支 → 返回流式进度 / tool 进度 → `model.setResponse()` → UI 渲染响应

**UI 入口**
- Chat Widget 服务接口在 `src/vs/workbench/contrib/chat/browser/chat.ts:102`
- Widget 服务实现负责打开 Chat View / Chat Editor 会话，在 `src/vs/workbench/contrib/chat/browser/widget/chatWidgetService.ts:23`
- 打开某个会话的统一入口是 `openSession(...)`，在 `src/vs/workbench/contrib/chat/browser/widget/chatWidgetService.ts:106`
- 侧边栏 Chat 宿主是 `ChatViewPane`，定义在 `src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.ts:86`
- `ChatViewPane` 加载会话的关键入口是 `loadSession(...)`，在 `src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.ts:769`
- 真正的主聊天 UI 组件是 `ChatWidget`，定义在 `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:192`

**用户点击发送 / 回车后的链路**
- 输入提交主入口是 `ChatWidget.acceptInput(...)`，在 `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:2127`
- 真正的发送逻辑在私有方法 `_acceptInput()`，在 `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:2199`
- 如果存在自定义 `submitHandler`，会先尝试短路默认发送；检查点在 `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:2219`
- 主 Chat View 默认**没有**传自定义 `submitHandler`，所以一般都会走默认链路；宿主创建 widget 的位置在 `src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.ts:519`
- 真正把用户输入交给 service 的地方是 `chatService.sendRequest(...)`，在 `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:2326`
- 发出后，Widget 会等 `responseCreatedPromise` / `responseCompletePromise` 做 UI 后处理，在 `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:2356`

**请求在发送前做了什么**
- ChatWidget 先收集输入文本、附件、隐式上下文，在 `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:2231`
- 如果当前已有请求在跑、正在编辑、或模型正在等用户补充输入，这次提交会被转成 queued request；相关逻辑在 `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:2242`
- Prompt 文件 / 自动附加 instructions / 工作集 / 图片附件解析也都发生在 `_acceptInput()` 里，关键点在 `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:2276`
- Prompt 元数据注入入口在 `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:2647`
- 输入解析器 `ChatRequestParser` 的入口在 `src/vs/workbench/contrib/chat/common/requestParser/chatRequestParser.ts:39`

**Service 层：真正的请求总控**
- `IChatService` 接口定义在 `src/vs/workbench/contrib/chat/common/chatService/chatService.ts:1344`
- 最关键的方法就是 `sendRequest(...)`，定义在 `src/vs/workbench/contrib/chat/common/chatService/chatService.ts:1403`
- `ChatService` 实现在 `src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:97`
- `ChatService.sendRequest(...)` 入口在 `src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:799`
- 它会先 parse 用户请求，关键解析入口在 `src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:858`
- 解析器实际调用点在 `src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:877`
- 真正进入“发给 agent / slash command / contributed session”的主逻辑在 `_sendRequestAsync()` 内，核心请求准备函数是 `prepareChatAgentRequest(...)`，在 `src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:1000`

**Agent 路由：决定发给谁**
- Chat 里的“participant/agent”服务接口在 `src/vs/workbench/contrib/chat/common/participants/chatAgents.ts:202`
- `IChatAgentService` 接口定义在 `src/vs/workbench/contrib/chat/common/participants/chatAgents.ts:218`
- 真实实现 `ChatAgentService` 在 `src/vs/workbench/contrib/chat/common/participants/chatAgents.ts:258`
- agent 实现注册入口在 `registerAgentImplementation(...)`，在 `src/vs/workbench/contrib/chat/common/participants/chatAgents.ts:358`
- 如果没有显式 agent，系统会做 participant detection，入口在 `detectAgentOrCommand(...)`，位于 `src/vs/workbench/contrib/chat/common/participants/chatAgents.ts:572`
- 真正调用 agent 的入口在 `invokeAgent(...)`，位于 `src/vs/workbench/contrib/chat/common/participants/chatAgents.ts:507`
- `ChatService` 里触发 participant detection 的位置在 `src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:1084`
- `ChatService` 真正调用 agent 的位置在 `src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:1132`

**如果不是 agent，而是 slash command**
- `ChatService` 在另一条分支里会走 slash command 执行，而不是 `invokeAgent(...)`
- 这个分支在 `src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:1151`
- 所以如果你要改“/xxx 指令”的行为，主要不是改 agent，而是改 slash command 体系

**主线程 / 扩展宿主桥接**
- 主线程桥接类在 `src/vs/workbench/api/browser/mainThreadChatAgents2.ts:92`
- 扩展宿主桥接类在 `src/vs/workbench/api/common/extHostChatAgents2.ts:463`
- Main thread 调扩展宿主执行 agent 的地方是 `$invokeAgent(...)`，调用点在 `src/vs/workbench/api/browser/mainThreadChatAgents2.ts:287`
- 扩展宿主实际接收并执行 agent 的入口是 `$invokeAgent(...)`，在 `src/vs/workbench/api/common/extHostChatAgents2.ts:751`
- agent 动态注册 / 普通注册分别落在 `src/vs/workbench/api/browser/mainThreadChatAgents2.ts:324` 和 `src/vs/workbench/api/browser/mainThreadChatAgents2.ts:343`
- 如果你要把 VS Code Chat 接到你自己的扩展侧 agent，实现重点就是这两端

**Tool 链路**
- Tool 服务接口在 `src/vs/workbench/contrib/chat/common/tools/languageModelToolsService.ts:495`
- `ILanguageModelToolsService` 定义在 `src/vs/workbench/contrib/chat/common/tools/languageModelToolsService.ts:499`
- 注册工具的入口在 `registerTool(...)`，位于 `src/vs/workbench/contrib/chat/common/tools/languageModelToolsService.ts:510`
- tool 调用生命周期入口有三类：
  - `beginToolCall(...)` 在 `src/vs/workbench/contrib/chat/common/tools/languageModelToolsService.ts:554`
  - `updateToolStream(...)` 在 `src/vs/workbench/contrib/chat/common/tools/languageModelToolsService.ts:560`
  - `invokeTool(...)` 在 `src/vs/workbench/contrib/chat/common/tools/languageModelToolsService.ts:562`
- main thread 收到 agent 侧发来的 tool 流式进度后，会调用 tool service；关键处理点在 `src/vs/workbench/api/browser/mainThreadChatAgents2.ts:365`
- `beginToolInvocation` 的处理在 `src/vs/workbench/api/browser/mainThreadChatAgents2.ts:390`
- `updateToolInvocation` 的处理在 `src/vs/workbench/api/browser/mainThreadChatAgents2.ts:402`
- 扩展宿主向主线程发 tool 进度的结构在 `src/vs/workbench/api/common/extHostChatAgents2.ts:346` 和 `src/vs/workbench/api/common/extHostChatAgents2.ts:362`

**内置 Tool 注册表**
- 内置工具注册集中在 `src/vs/workbench/contrib/chat/common/tools/builtinTools/tools.ts:29`
- 典型内置工具包括：
  - 编辑工具 `EditToolData`，注册点在 `src/vs/workbench/contrib/chat/common/tools/builtinTools/tools.ts:29`
  - 问用户问题 `AskQuestionsToolData`，注册点在 `src/vs/workbench/contrib/chat/common/tools/builtinTools/tools.ts:32`
  - todo 工具，注册点在 `src/vs/workbench/contrib/chat/common/tools/builtinTools/tools.ts:37`
  - confirmation 工具，注册点在 `src/vs/workbench/contrib/chat/common/tools/builtinTools/tools.ts:40`
  - subagent 工具，注册点在 `src/vs/workbench/contrib/chat/common/tools/builtinTools/tools.ts:61`
- 如果你要改“AI 聊天模块”的工具能力，`builtinTools/tools.ts` 是非常直接的入口

**如果你想改“模式 / Prompt / 权限级别”**
- `ChatModeKind` 定义在 `src/vs/workbench/contrib/chat/common/constants.ts:63`
- Widget 会把当前 mode 信息塞进 request options，在 `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:2335`
- Service 会把 `modeInstructions` / `permissionLevel` 写进 `IChatAgentRequest`，在 `src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:1040`
- 这块特别适合做“自定义系统提示词 / 模式差异化行为 / auto-approval 策略”

**你最该从哪里开始改**
- **改 UI/交互**：`src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:2127`
- **改发送前处理**：`src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:2199`
- **改请求组装 / 排队 / 会话策略**：`src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:799`
- **改 agent 路由 / 默认 agent / participant detection**：`src/vs/workbench/contrib/chat/common/participants/chatAgents.ts:258`
- **改扩展桥接 / 自定义 agent 接入**：`src/vs/workbench/api/browser/mainThreadChatAgents2.ts:92` 和 `src/vs/workbench/api/common/extHostChatAgents2.ts:463`
- **改 tool 体系 / coding 能力**：`src/vs/workbench/contrib/chat/common/tools/languageModelToolsService.ts:499` 和 `src/vs/workbench/contrib/chat/common/tools/builtinTools/tools.ts:29`