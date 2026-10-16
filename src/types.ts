import * as vscode from 'vscode';

export type SvnItemStatus =
  | 'added'
  | 'conflicted'
  | 'deleted'
  | 'external'
  | 'ignored'
  | 'incomplete'
  | 'missing'
  | 'modified'
  | 'none'
  | 'normal'
  | 'obstructed'
  | 'replaced'
  | 'unversioned';

export interface SvnCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SvnStatusEntry {
  readonly absolutePath: string;
  /** 文件系统中可确认的节点类型；缺失或删除后可能无法读取。 */
  readonly kind?: 'file' | 'dir';
  readonly item: SvnItemStatus;
  readonly propertyStatus: SvnItemStatus;
  readonly changelist?: string;
  readonly revision?: string;
  readonly treeConflicted: boolean;
  readonly switched: boolean;
  readonly copied: boolean;
  readonly locked: boolean;
}

export type SvnConflictType = 'text' | 'property' | 'tree' | 'unknown';

export interface SvnConflictInfo {
  readonly type: SvnConflictType;
  readonly operation: string;
  readonly previousBaseFile?: string;
  readonly previousWorkingFile?: string;
  readonly currentBaseFile?: string;
}

export interface SvnInfo {
  readonly path: string;
  readonly url: string;
  readonly repositoryRoot: string;
  readonly repositoryUuid: string;
  readonly revision: string;
  readonly workingCopyRoot: string;
  readonly conflict?: SvnConflictInfo;
}

export interface SvnLogPath {
  readonly action: string;
  readonly path: string;
  readonly copyFromPath?: string;
  readonly copyFromRevision?: string;
}

export interface SvnLogEntry {
  readonly revision: string;
  readonly author: string;
  readonly date: string;
  readonly message: string;
  readonly paths: readonly SvnLogPath[];
}

export interface SvnBlameLine {
  readonly lineNumber: number;
  readonly revision: string;
  readonly author: string;
  readonly date: string;
}

export interface SvnResourceState extends vscode.SourceControlResourceState {
  readonly status: SvnStatusEntry;
}

export interface SvnRepositoryOperations {
  readonly root: vscode.Uri;
  readonly sourceControl: vscode.SourceControl;
  refresh(): Promise<void>;
  commit(resources?: readonly vscode.Uri[]): Promise<void>;
  /** 更新目标。@param resource 可选目标。@param advanced 是否选择高级更新参数。 */
  update(resource?: vscode.Uri, advanced?: boolean): Promise<void>;
  /** 创建远程分支或标签。 */
  branchOrTag(): Promise<void>;
  /** 将工作副本切换到其他仓库 URL。 */
  switchBranch(): Promise<void>;
  /** 预演并确认将来源分支的变更合并到当前工作副本。 */
  merge(): Promise<void>;
  /** 继续已完成的合并预演。@param uri 预演文档 URI。 */
  continueMerge(uri: vscode.Uri): Promise<void>;
  /** 查看来源分支相对当前工作副本已合并或尚未合并的 revision。 */
  showMergeinfo(): Promise<void>;
  add(resources: readonly vscode.Uri[]): Promise<void>;
  remove(resources: readonly vscode.Uri[]): Promise<void>;
  revert(resources: readonly vscode.Uri[]): Promise<void>;
  rename(resource: vscode.Uri): Promise<void>;
  ignore(resources: readonly vscode.Uri[]): Promise<void>;
  /** 锁定文件。@param resources 要锁定的 SVN 文件。@param force 是否直接强制锁定。 */
  lock(resources: readonly vscode.Uri[], force?: boolean): Promise<void>;
  /** 解锁文件。@param resources 要解锁的 SVN 文件。@param force 是否直接强制解锁。 */
  unlock(resources: readonly vscode.Uri[], force?: boolean): Promise<void>;
  /** @param resource 要管理属性的文件或目录。 */
  manageProperty(resource: vscode.Uri): Promise<void>;
  /** @param resources 要调整 Changelist 的文件。 */
  assignChangelist(resources: readonly vscode.Uri[]): Promise<void>;
  cleanup(): Promise<void>;
  compare(resource: vscode.Uri): Promise<void>;
  openConflict(resource: vscode.Uri): Promise<void>;
  resolve(resources: readonly vscode.Uri[]): Promise<void>;
  showLog(resource?: vscode.Uri): Promise<void>;
  showBlame(resource: vscode.Uri): Promise<void>;
  dispose(): void;
}
