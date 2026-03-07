# VS Code 源码版本地开发流程

## 当前可用方案
当前仓库已经具备两类能力：

1. **稳定启动源码版 VS Code**
2. **开启 watch 增量编译，方便改代码后验证**

仓库路径：`D:\Programming\vscode plus\vscode`

源码版可执行文件：`D:\Programming\vscode plus\vscode\.build\electron\Code - OSS.exe`

## 为什么当前启动比较慢
现在的 `start-vscode-dev.bat` 采用的是“稳定优先”策略：

1. 先执行：`node build/next/index.ts bundle --nls --out out`
2. 再启动源码版 `Code - OSS.exe`

这样做的原因是：
- 当前这台机器上，直接启动源码版时，`out/main.js` 和 `out/nls.messages.json` 偶尔会不同步
- 不同步时会触发 `NLS MISSING: 138`
- 因此稳定方案必须先修复 `out`

所以现在打开慢，主要慢在“启动前修复构建产物”，**不是正式版程序本身启动慢**。

## 正式版会不会也这么慢
正常不会。

现在慢的是：
- 开发环境启动前的构建/修复步骤

正式版/打包版不会在每次启动时再执行：
- `bundle --nls --out out`

所以：
- **开发环境当前慢** ≠ **最终产物启动慢**

## 当前推荐脚本

### 1. 稳定启动源码版
文件：`start-vscode-dev.bat`

用途：
- 修复 `out` / NLS 产物
- 然后启动源码版 VS Code

特点：
- 最稳
- 但通常要等 45~60 秒左右

适合场景：
- 刚开机第一次启动
- 遇到过 `NLS MISSING`
- 编译产物可能已经乱了

### 2. watch 增量编译
文件：`watch-vscode-dev.bat`

用途：
- 持续监听源码变化
- 增量编译 `src` 和内置扩展
- 适合你后面持续改 AI/Chat 模块

特点：
- 第一次启动后会一直挂着
- 你改代码后，它会自动重新编译
- 配合源码版窗口的 `Developer: Reload Window` 使用

## 推荐开发工作流

### 第一步：开 watch 窗口
运行：
- `watch-vscode-dev.bat`

这一步会一直运行，不要关。

### 第二步：开源码版 VS Code
运行：
- `start-vscode-dev.bat`

第一次会比较慢，因为会修复 `out`。

### 第三步：改代码
例如你后面改这些位置：
- `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts`
- `src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts`
- `src/vs/workbench/api/browser/mainThreadChatAgents2.ts`
- `src/vs/workbench/api/common/extHostChatAgents2.ts`

### 第四步：等 watch 编译完成
watch 窗口里出现新的编译完成输出后，再回到源码版 VS Code。

### 第五步：在源码版窗口里执行 Reload Window
命令：
- `Developer: Reload Window`

这样通常就能看到你刚改的效果。

## 关于“实时生效”
当前不是前端意义上的热更新。

更准确地说是：
- **增量编译 + Reload Window**

也就是：
- 改代码
- watch 自动编译
- 你手动 Reload Window
- 新逻辑生效

这是 VS Code 主仓库更典型的开发方式。

## 日常建议

### 每天第一次启动
- 先 `watch-vscode-dev.bat`
- 再 `start-vscode-dev.bat`

### 中途持续改代码
- 保持 `watch-vscode-dev.bat` 运行
- 改完代码后在源码版窗口执行 `Developer: Reload Window`

### 如果再次遇到 `NLS MISSING`
- 直接再运行一次：`start-vscode-dev.bat`

## 后续最适合你改 Chat 模块的方式
如果接下来主要目标是改造 AI 聊天模块，最省时间的组合就是：

- 一个窗口跑：`watch-vscode-dev.bat`
- 一个窗口跑：`start-vscode-dev.bat`
- 改完 Chat 源码后：`Developer: Reload Window`

这比每次都重新从零修环境要高效很多。
