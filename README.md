# YF SVN 1.3.4

YF SVN 是面向 Windows 10、Windows 11 和最新版 VS Code 的 Subversion 集成插件。插件通过本机 `svn.exe` 工作，在 VS Code 内提供状态查看、提交、更新、冲突处理和历史追溯等日常 SVN 工作流。

## 环境要求

- Windows 10 或 Windows 11
- VS Code 1.131 或更高版本
- SVN CLI 1.10 或更高版本

请先在 PowerShell 中执行 `svn --version` 确认 SVN CLI 可用。如果 `svn.exe` 不在 `PATH` 中，请在设置中配置 `yfSvn.path`。中文路径需要 SVN CLI 发行版本身支持 Unicode。

## 安装

在 VS Code 中执行“扩展: 从 VSIX 安装”，选择 `yf-svn-1.3.4.vsix`，然后重新加载窗口。打开包含 `.svn` 的工作区后，插件会自动发现工作副本并注册 Source Control Provider。

## 功能

### 工作副本与状态

- 自动发现多根工作区、嵌套工作副本和 SVN Externals。
- Source Control 按更改、Changelist、未版本控制、冲突、已忽略和 Externals 分组。
- 显示修改、添加、删除、替换、缺失、冲突和忽略等状态。
- 资源管理器和 SCM 使用主题颜色、状态标记或原生图标区分状态，悬停显示统一中文说明；默认修改为蓝色，未版本控制为黄色。
- 未版本控制、冲突、已忽略和 Externals 分组为空时自动隐藏，保留“更改”分组作为固定入口。
- VS Code 启动完成后自动初始化 SCM，并发现工作区中的 SVN 工作副本。
- 保存文件或窗口重新获得焦点后自动刷新，也可手动刷新。
- 刷新失败时旧状态会保留；状态栏显示工作副本名称及“状态已过期”，单击可重试对应工作副本。写操作后的刷新失败不会把已完成的操作误报为失败。
- 工作副本状态栏显示可见更改及冲突数量，悬停可查看分类计数、路径、扫描深度和刷新时间；浅层扫描的“无可见更改”只表示已扫描范围内没有更改。
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
- 在 SCM 中明确选中的多个文件默认保持勾选，全部提交入口仍由用户选择范围。冲突只阻止所选范围，不影响无关文件的部分提交。
- 支持在 SCM 中多选指定文件提交，以及按整个 Changelist 提交。
- 提交前提示所选范围的冲突，任务出队后再次检查；失败或取消保留提交说明，成功时保留等待期间新编辑的草稿。
- 提交前显示目标文件、状态和相对路径。
- 更新整个工作副本、单个文件或所选目录。
- Update 支持 HEAD、指定 revision、depth 和 ignore externals，成功后显示通知。
- 普通更新沿用 HEAD 和当前深度；需要其他选项时使用“SVN: 高级更新”。两种入口均保留目标及选项的最终确认。
- Checkout 支持仓库 URL、目标目录、revision、depth 和 externals 选项。
- 检出、创建分支或标签、切换及高级更新支持分步输入、返回和内容保留，取消不执行写操作。
- 支持中文、空格及包含 `@` 的工作副本路径，检出使用所选目标目录。

### 分支、锁、属性与 Changelist

- 从当前工作副本 URL 创建远程 Branch 或 Tag，支持 HEAD 和指定 revision。
- 将整个工作副本 Switch 到同一仓库中的其他 URL。
- Lock、Force Lock、Unlock 和 Force Unlock，操作前显示目标确认。
- 查看、新建、编辑和删除 SVN 属性；属性输入中使用 `\n` 表示换行。
- 将文件加入、移动到或移出 SVN Changelist。
- Changelist 在 Source Control 中显示为独立分组，可直接按整组提交。

### 分支合并与 Mergeinfo

- 通过命令面板或 Source Control 的更多操作菜单执行“SVN: 合并”。
- 来源填写同一仓库的完整分支 URL，不附加 `@REV`；插件固定读取到的来源 HEAD，供预演及实际合并共用。
- revision 范围留空表示合并全部可合并变更；`10:15` 表示合并 r11 至 r15，不包含 r10。
- 预演不修改工作文件；检查只读预演文档后，可点击通知中的“执行合并”，也可使用编辑器右上角或命令面板的“SVN: 执行本次合并”，再确认来源和目标。
- 取消最终确认后仍可继续同一预演；已经执行、失败或被新预演替代的记录不能重复执行。预演只在当前扩展会话有效，重新加载窗口后需重新预演。
- 目标工作副本需要没有未提交的版本化修改、未保存内容和未解决冲突；基础合并不支持已切换的子路径。混合 revision 工作副本应先执行 Update。
- 合并修改保留在本地，出现冲突时通过现有冲突处理流程解决，再检查差异并提交，包括 `svn:mergeinfo` 属性变化。
- “SVN: 查看合并信息”同时显示已合并和未合并 revision，带 `*` 表示仅在部分子路径上合并。
- 当前提供单来源基础合并，two-URL merge、反向合并、record-only 和高级合并选项尚未提供。

### 冲突处理

- 冲突资源显示在独立分组中。
- 文本冲突优先使用 VS Code 三方合并编辑器，缺少完整冲突文件时自动降级为 Diff。
- 支持 SVN 未生成 `.mine` 文件的情况。
- 属性冲突显示属性差异，树冲突显示冲突操作与处理说明。
- Mark Resolved 支持 `working`、`mine-full`、`theirs-full` 和 `base`。
- 使用 `working` 前检查残留文本冲突标记，普通资源不能误标记为已解决。

### 历史与逐行追溯

- 查看文件、目录或工作副本历史，支持分页以及作者、日期和 revision 筛选。
- 筛选结果支持继续翻页，日期和 revision 范围保留原始方向及边界；作者关键字只匹配真实作者，不匹配提交说明。
- 查看 revision 详情、变更路径和指定 revision 的文件内容。
- SVN Blame 在代码左侧默认紧凑显示 revision 和作者，设置 `yfSvn.blameStyle` 为 `full` 可同时显示日期；长内容以省略号收起，悬停显示完整信息。
- 对同一文件再次执行“显示/隐藏逐行追溯”可关闭所有分栏中的追溯；编辑后自动撤下旧追溯，需要时重新执行命令。

### VS Code 集成

- Source Control 标题栏使用图标提供刷新、更新和全部提交入口。
- SCM 文件右侧使用图标提供比较、添加、冲突处理和标记已解决等快捷操作。
- Source Control 的更多操作菜单提供 Branch/Tag、Switch 和常用操作入口。
- 资源管理器的 `SVN` 子菜单根据资源类型和实时状态，仅显示当前可执行的命令；强制操作独立分组。
- 编辑器正文右键提供按 SVN 状态过滤的 `SVN` 二级菜单，例如未版本控制文件只显示添加和忽略。
- 提供诊断命令和独立输出通道；日志不会记录明文凭据。
- 工作副本写操作依次执行，进度显示等待、执行和刷新阶段；排队时取消的任务不会执行，外部命令支持取消和超时。
- 常见认证、工作副本锁、冲突和版本错误提供中文原因及恢复入口；由用户选择恢复操作，不自动重复写操作。
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
| `yfSvn.blameStyle` | `compact` | 追溯显示方式：紧凑 `compact` 或包含日期的 `full`，修改即时生效 |

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
- 仓库浏览器和 Shelf 尚未包含在当前版本中。
- VS Code 不支持在行号栏绘制文字，Blame 信息显示在每行代码内容左侧。

## 开发

```powershell
npm install
npm run compile
npm test
npm run test:host
npm run package
```

在 VS Code 中按 `F5` 启动 Extension Development Host。提交或打包前必须运行 `npm test`。

`npm run test:host` 需要 Windows、本机 VS Code、`svn` 和 `svnadmin`。默认从 `PATH` 查找 `code.cmd`，也可通过环境变量 `YF_SVN_TEST_CODE` 指定 `Code.exe` 的完整路径。测试使用 `.test-tmp/` 下的独立仓库、用户配置和扩展目录，结束后自动清理；不会安装扩展到日常 VS Code 配置中。

测试覆盖 SVN 本地操作、提交与更新、分支合并、冲突处理、历史分页、工作副本状态和原生交互。真实扩展宿主测试使用隔离配置验证编辑器集成；不同主题、字体缩放、远程认证和支持版本的兼容性需另行人工验收。
