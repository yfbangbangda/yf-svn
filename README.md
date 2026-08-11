# YF SVN 1.1.0

YF SVN 是面向 Windows 10、Windows 11 和最新版 VS Code 的 Subversion 集成插件。插件通过本机 `svn.exe` 工作，在 VS Code 内提供状态查看、提交、更新、冲突处理和历史追溯等日常 SVN 工作流。

## 环境要求

- Windows 10 或 Windows 11
- VS Code 1.131 或更高版本
- SVN CLI 1.10 或更高版本

请先在 PowerShell 中执行 `svn --version` 确认 SVN CLI 可用。如果 `svn.exe` 不在 `PATH` 中，请在设置中配置 `yfSvn.path`。中文路径需要 SVN CLI 发行版本身支持 Unicode。

## 安装

在 VS Code 中执行“扩展: 从 VSIX 安装”，选择 `yf-svn-1.1.0.vsix`，然后重新加载窗口。打开包含 `.svn` 的工作区后，插件会自动发现工作副本并注册 Source Control Provider。

## 功能

### 工作副本与状态

- 自动发现多根工作区、嵌套工作副本和 SVN Externals。
- Source Control 按更改、Changelist、未版本控制、冲突、已忽略和 Externals 分组。
- 显示修改、添加、删除、替换、缺失、冲突和忽略等状态。
- 资源管理器使用主题颜色装饰文件和目录；默认修改为蓝色，未版本控制为黄色。
- VS Code 启动完成后自动初始化 SCM，并发现工作区中的 SVN 工作副本。
- 保存文件或窗口重新获得焦点后自动刷新，也可手动刷新。
- 自动刷新会合并短时间内的重复请求，并优先只刷新发生文件事件的工作副本。
- 状态扫描不会把完整状态 XML 写入输出通道，避免大型工作副本产生大量日志。
- 编辑器行号区域通过 Quick Diff 显示相对 BASE 的修改，并可打开内联差异。

### 本地操作

- Add、Delete、Revert、Move/Rename、Ignore 和 Cleanup。
- Ignore 支持 `svn:ignore` 与 `svn:global-ignores`。
- 比较工作文件与 BASE、HEAD 或指定 revision。
- 删除、还原、提交、更新和冲突解决等关键操作执行前显示确认信息。

### 提交、更新与检出

- 在 SCM 输入框填写提交说明，可按 `Ctrl+Enter` 提交，也可点击顶部“全部提交”图标。
- 多文件提交前显示复选列表，可勾选本次需要提交的文件并排除无关文件。
- 支持在 SCM 中多选指定文件提交，以及按整个 Changelist 提交。
- 提交前显示目标文件、状态和相对路径。
- 更新整个工作副本、单个文件或所选目录。
- Update 支持 HEAD、指定 revision、depth 和 ignore externals，成功后显示通知。
- Checkout 支持仓库 URL、目标目录、revision、depth 和 externals 选项。
- 外部命令显示可取消进度，并支持超时控制。

### 分支、锁、属性与 Changelist

- 从当前工作副本 URL 创建远程 Branch 或 Tag，支持 HEAD 和指定 revision。
- 将整个工作副本 Switch 到同一仓库中的其他 URL。
- Lock、Force Lock、Unlock 和 Force Unlock，操作前显示目标确认。
- 查看、新建、编辑和删除 SVN 属性；属性输入中使用 `\n` 表示换行。
- 将文件加入、移动到或移出 SVN Changelist。
- Changelist 在 Source Control 中显示为独立分组，可直接按整组提交。

### 冲突处理

- 冲突资源显示在独立分组中。
- 文本冲突优先使用 VS Code 三方合并编辑器，缺少完整冲突文件时自动降级为 Diff。
- 支持 SVN 未生成 `.mine` 文件的情况。
- 属性冲突显示属性差异，树冲突显示冲突操作与处理说明。
- Mark Resolved 支持 `working`、`mine-full`、`theirs-full` 和 `base`。
- 使用 `working` 前检查残留文本冲突标记，普通资源不能误标记为已解决。

### 历史与逐行追溯

- 查看文件、目录或工作副本历史，支持分页以及作者、日期和 revision 筛选。
- 查看 revision 详情、变更路径和指定 revision 的文件内容。
- SVN Blame 在每行代码左侧显示 revision、作者和日期，悬停显示完整信息。
- 对同一文件再次执行“查看逐行追溯”可关闭追溯信息。

### VS Code 集成

- Source Control 标题栏使用图标提供刷新、更新和全部提交入口。
- SCM 文件右侧使用图标提供比较、添加、冲突处理和标记已解决等快捷操作。
- Source Control 的更多操作菜单提供 Branch/Tag、Switch 和常用操作入口。
- 资源管理器根据资源类型显示“更新文件”或“更新目录”等右键命令。
- 编辑器正文右键提供 `SVN` 二级菜单，包括更新、添加、比较、历史和逐行追溯。
- 提供诊断命令和独立输出通道；日志不会记录明文凭据。
- 未授予 Workspace Trust 时不执行外部 SVN 命令。

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `yfSvn.path` | `svn` | `svn.exe` 的完整路径或可执行文件名 |
| `yfSvn.autoRefresh` | `true` | 保存文件和窗口重新聚焦后自动刷新 |
| `yfSvn.statusDepth` | `infinity` | 状态扫描深度 |
| `yfSvn.ignoreExternals` | `false` | 更新和检出时忽略 Externals |
| `yfSvn.logLimit` | `50` | 每页加载的历史记录数量 |
| `yfSvn.timeout` | `120000` | SVN 命令超时时间，单位为毫秒 |

## 常用流程

1. 打开 SVN 工作副本，等待 Source Control 显示状态。
2. 修改文件后通过 Diff 检查内容。
3. 在 SCM 输入框填写说明，点击“全部提交”或按 `Ctrl+Enter`，在复选列表中确认提交文件。
4. 使用“SVN: 更新”同步整个工作副本，或在资源管理器中更新文件、目录。
5. 出现冲突时打开三方合并，保存结果后使用 `working` 标记已解决。

## 已知边界

- 仅支持 Windows 桌面版 VS Code，不支持 `vscode.dev`。
- 插件不内置 SVN 引擎，需要用户自行安装 SVN CLI。
- 认证、证书和凭据缓存由 SVN CLI 负责。
- Merge、仓库浏览器和 Shelf 尚未包含在 1.1.0 中。
- VS Code 不支持在行号栏绘制文字，Blame 信息显示在每行代码内容左侧。

## 开发

```powershell
npm install
npm run compile
npm test
npm run package
```

在 VS Code 中按 `F5` 启动 Extension Development Host。提交或打包前必须运行 `npm test`。
