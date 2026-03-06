# VS Code 源码拉取、环境修复与启动验证笔记

## 基本信息
- 工作目录：`D:\Programming\vscode plus\vscode`
- 克隆来源：`https://github.com/microsoft/vscode.git`
- 当前目标：
  1. 把 VS Code 源码拉下来并能启动
  2. 为后续改造 AI 聊天模块准备可调试环境

## 最终结论
本次任务已经完成到“可启动、可继续开发”的程度：
- 源码已成功克隆到本地
- 依赖已安装完成
- `Code - OSS` 已实际启动验证通过
- 已定位 AI/Chat 模块核心入口，后续可以直接开始改造

## 这次遇到的核心问题

### 1. 当前目录名包含空格
仓库位于：`D:\Programming\vscode plus\vscode`

这会导致 VS Code 的部分安装/预检脚本在 Windows 下调用子进程时出问题，典型现象是：
- 某些脚本把路径截断到 `D:\Programming\vscode`
- `node-gyp.cmd`、预安装脚本或派生脚本执行失败

### 2. 本机默认 Node 版本不满足仓库要求
本机初始版本：`Node v22.14.0`

仓库预检脚本要求：`Node.js v22.22.0 or later`

这会导致：
- `build/npm/preinstall.ts` 主动报错
- 某些 `.ts` 脚本执行行为不符合当前仓库要求

### 3. Windows 原生模块编译依赖与本机 VS Build Tools 不完全匹配
仓库中包含大量需要 `node-gyp rebuild` 的原生模块，例如：
- `@vscode/spdlog`
- `@vscode/sqlite3`
- `@vscode/deviceid`
- `@vscode/native-watchdog`
- `@vscode/windows-registry`
- `@vscode/windows-process-tree`
- `@vscode/policy-watcher`
- `node-pty`
- `kerberos`

一开始的失败原因主要包括：
- `node-gyp` 无法正确识别当前 VS Build Tools 安装
- 工具集默认映射到 `v143`，而本机 VS18 Build Tools 实际默认工具集更接近 `v145`
- 某些包启用了 `SpectreMitigation`，但本机未安装对应 Spectre 库，因此报 `MSB8040`

### 4. Electron 被当成普通 Node 进程启动
环境变量中残留了：`ELECTRON_RUN_AS_NODE=1`

这会导致：
- 启动 `Code - OSS.exe` 时并不是按 Electron App 启动
- 会出现类似 `electron does not provide an export named ...` 之类的误导性错误

### 5. 启动时缺少运行产物
安装完成后直接启动，仍然缺少部分运行时产物：
- `out/nls.messages.json`
- 若干原生模块 `.node` 文件未落到最终需要的位置

这意味着“npm install 成功”并不等于“桌面版已能跑起来”。

## 我实际做过的修复步骤

### 第一步：克隆源码
执行：
- `git clone https://github.com/microsoft/vscode.git`

结果：
- 仓库成功拉取到：`D:\Programming\vscode plus\vscode`

### 第二步：确认仓库要求和本机环境
检查了：
- `README.md`
- `AGENTS.md`
- `.github/copilot-instructions.md`
- `.nvmrc`
- `package.json`

得到的关键结论：
- 仓库要求的 Node 版本比本机更高
- Windows 下需要完整可用的 C/C++ 编译工具链
- 聊天功能主体在 `src/vs/workbench/contrib/chat/`

### 第三步：解决 Node 版本问题
下载并解压便携版 Node：
- `D:\Programming\vscode plus\_tooling\node-v22.22.0-win-x64`

后续统一使用这套 Node / npm，而不是系统默认 `22.14.0`。

### 第四步：绕过路径空格问题
为了避免 `D:\Programming\vscode plus\vscode` 中的空格继续破坏脚本调用，创建了盘符映射：
- `subst V: "D:\Programming\vscode plus\vscode"`

后续安装、编译、启动，均以 `V:\` 为工作根目录更稳定。

### 第五步：让 node-gyp 正确认识本机 VS Build Tools
本机 Build Tools 位于：
- `D:\Microsoft Visual Studio\18\BuildTools`

我在运行时使用了以下关键环境变量：
- `vs2022_install=D:\Microsoft Visual Studio\18\BuildTools`
- `VCINSTALLDIR=D:\Microsoft Visual Studio\18\BuildTools\VC\`
- `VSCMD_VER=17.14.0`
- `WindowsSDKVersion=10.0.26100.0\`
- `npm_config_msvs_version=2022`

此外，还为便携 Node 自带的 `node-gyp` 做了本地兼容处理，使其优先识别本机的 `v145` 工具集，而不是死用 `v143`。

相关本地工具目录：
- `D:\Programming\vscode plus\_tooling\node-v22.22.0-win-x64`
- 早期测试过程中也保留过一份：`D:\Programming\vscode plus\_tooling\npm-patched`

### 第六步：处理 SpectreMitigation 导致的原生模块编译失败
多个模块的 `binding.gyp` 中带有：
- `SpectreMitigation: Spectre`

由于本机没有安装对应 Spectre 库，这些模块会在 MSBuild 阶段报：
- `MSB8040`

我的处理方式是：
- 对本地 `node_modules` 中需要的相关 `binding.gyp` 做兼容修改
- 移除显式的 `SpectreMitigation` 配置
- 然后对关键模块单独执行 `node-gyp rebuild`

重点处理过的模块包括：
- 根目录：
  - `node_modules/@vscode/deviceid`
  - `node_modules/@vscode/native-watchdog`
  - `node_modules/@vscode/policy-watcher`
  - `node_modules/@vscode/spdlog`
  - `node_modules/@vscode/windows-registry`
- `remote` 子项目：
  - `remote/node_modules/@vscode/deviceid`
  - `remote/node_modules/@vscode/native-watchdog`
  - `remote/node_modules/@vscode/windows-registry`

### 第七步：完成根项目与 remote 子项目安装
最终成功完成：
- 根项目 `npm install`
- `remote` 子项目 `npm install`
- 扩展、测试、辅助子项目依赖安装

### 第八步：补齐运行时产物
为了生成启动时需要的 NLS 资源，执行了：
- `npm run transpile-client`
- `npm run gulp compile`
- `node build/next/index.ts bundle --nls --out out`

最终成功生成：
- `out/nls.messages.json`
- `out/nls.keys.json`
- `out/nls.metadata.json`

### 第九步：清理 Electron 启动环境
发现环境中存在：
- `ELECTRON_RUN_AS_NODE=1`

启动桌面版前必须清掉，否则 `Code - OSS.exe` 会被当作普通 Node 进程执行。

## 最终启动验证结果
最终验证方式：
- 直接执行 `V:\.build\electron\Code - OSS.exe`
- 清除 `ELECTRON_RUN_AS_NODE`
- 确认进程成功驻留

已确认成功启动的可执行文件：
- `V:\.build\electron\Code - OSS.exe`

我最终观察到的后台进程路径即为上面的 `Code - OSS.exe`，说明桌面版已经可以运行。

## 当前推荐启动方式
以后如果你要在这台机器上继续启动这份源码版 VS Code，建议按下面流程：

### 1. 映射无空格盘符
```powershell
subst V: "D:\Programming\vscode plus\vscode"
```

### 2. 设置关键环境变量
```powershell
$portable = 'D:\Programming\vscode plus\_tooling\node-v22.22.0-win-x64'
$env:PATH = "$portable;$portable\node_modules\npm\bin;$env:PATH"
$env:vs2022_install = 'D:\Microsoft Visual Studio\18\BuildTools'
$env:VCINSTALLDIR = 'D:\Microsoft Visual Studio\18\BuildTools\VC\'
$env:VSCMD_VER = '17.14.0'
$env:WindowsSDKVersion = '10.0.26100.0\'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
cd V:\
```

### 3. 启动
```powershell
.\.build\electron\Code - OSS.exe .
```

## AI 聊天模块后续改造入口
如果下一步是“改造 VS Code 的 AI 聊天模块”，建议从以下位置开始：

### 1. 聊天模块总览
- `src/vs/workbench/contrib/chat/chatCodeOrganization.md:1`

这个文件对聊天模块目录分工说明得比较清楚，适合作为入口地图。

### 2. 功能注册入口
- `src/vs/workbench/contrib/chat/browser/chat.contribution.ts:1717`

这里能看到聊天相关 contribution 的整体挂载位置。

### 3. 聊天 Widget 服务入口
- `src/vs/workbench/contrib/chat/browser/chat.ts:102`

这里定义了 `IChatWidgetService`。

### 4. 聊天主 UI 组件
- `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:192`

如果你主要想改聊天面板、消息渲染、输入框交互、按钮和工具调用反馈，这里很关键。

### 5. 侧边栏 Chat 面板
- `src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.ts:86`

如果你想改侧边栏 Chat 视图本身，从这里切入很合适。

### 6. 聊天服务接口与实现
- 接口：`src/vs/workbench/contrib/chat/common/chatService/chatService.ts:1344`
- 实现：`src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts:97`

如果你想改对话生命周期、请求分发、会话管理、上下文与响应流，重点看这里。

### 7. 扩展宿主 / 主线程桥接
- `src/vs/workbench/api/browser/mainThreadChatAgents2.ts:92`
- `src/vs/workbench/api/common/extHostChatAgents2.ts:463`

如果你想把聊天能力接到自己的 agent、模型、工具、或扩展 API，上面这两处非常关键。

## 当前环境的现实约束
这套环境虽然已经能启动，但有几个重要前提：

1. 不建议直接删掉当前 `node_modules`
   - 因为这套环境里已经做过若干本地兼容修复
   - 直接删掉后重新安装，可能还要重新走一轮 native 模块适配

2. 后续最好继续在 `V:\` 下操作
   - 能明显降低路径空格带来的脚本兼容问题

3. 当前本机 VS Build Tools 是非标准版本布局
   - 仓库和 `node-gyp` 对它不是开箱即用
   - 如果未来升级系统 Node 或清空工具目录，可能需要重新做兼容处理

## 本次产出/落地的关键目录
- 仓库根目录：`D:\Programming\vscode plus\vscode`
- 无空格映射盘符：`V:\`
- 便携 Node：`D:\Programming\vscode plus\_tooling\node-v22.22.0-win-x64`
- 运行产物目录：`V:\out`
- 桌面可执行文件：`V:\.build\electron\Code - OSS.exe`

## 建议的下一步
建议紧接着做下面两件事之一：

### 方案 A：我继续帮你做开发辅助脚本
我可以再补一份：
- `start-vscode-dev.ps1`
- 一键设置环境变量、映射 `V:`、清除 `ELECTRON_RUN_AS_NODE`、并启动源码版 VS Code

### 方案 B：我继续帮你梳理 AI 聊天模块调用链
我可以下一步直接输出一份更细的源码导图，包括：
- UI 层入口
- Chat Service 调用链
- Agent / Tool 调用链
- Extension Host 桥接点
- 哪些点最适合接入你自己的 AI 能力

---

记录时间：2026-03-07
记录目的：为后续 VS Code AI/Chat 模块改造提供可复现环境和源码入口说明。
