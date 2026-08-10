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
  readonly item: SvnItemStatus;
  readonly propertyStatus: SvnItemStatus;
  readonly revision?: string;
  readonly treeConflicted: boolean;
  readonly switched: boolean;
  readonly copied: boolean;
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
  update(resource?: vscode.Uri): Promise<void>;
  add(resources: readonly vscode.Uri[]): Promise<void>;
  remove(resources: readonly vscode.Uri[]): Promise<void>;
  revert(resources: readonly vscode.Uri[]): Promise<void>;
  rename(resource: vscode.Uri): Promise<void>;
  ignore(resources: readonly vscode.Uri[]): Promise<void>;
  cleanup(): Promise<void>;
  compare(resource: vscode.Uri): Promise<void>;
  openConflict(resource: vscode.Uri): Promise<void>;
  resolve(resources: readonly vscode.Uri[]): Promise<void>;
  showLog(resource?: vscode.Uri): Promise<void>;
  showBlame(resource: vscode.Uri): Promise<void>;
  dispose(): void;
}
