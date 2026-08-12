import * as path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import {
  SvnBlameLine,
  SvnConflictType,
  SvnInfo,
  SvnItemStatus,
  SvnLogEntry,
  SvnLogPath,
  SvnStatusEntry
} from './types';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  parseTagValue: false,
  trimValues: false
});

/**
 * 把 XML 解析结果统一转换为数组。
 *
 * @param value 单个节点、节点数组或空值。
 * @returns 可安全遍历的节点数组。
 */
function asArray<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value as T];
}

/**
 * 把 XML 节点值转换为字符串。
 *
 * @param value XML 解析器返回的节点值。
 * @returns 节点文本；空值返回空字符串。
 */
function asText(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['#text'] ?? '');
  }
  return String(value);
}

/**
 * 将 SVN 返回的状态名称收敛为插件支持的状态。
 *
 * @param value SVN XML 中的状态名称。
 * @returns 已校验的状态名称。
 */
function toStatus(value: unknown): SvnItemStatus {
  const status = String(value ?? 'none') as SvnItemStatus;
  const supported: readonly SvnItemStatus[] = [
    'added',
    'conflicted',
    'deleted',
    'external',
    'ignored',
    'incomplete',
    'missing',
    'modified',
    'none',
    'normal',
    'obstructed',
    'replaced',
    'unversioned'
  ];
  return supported.includes(status) ? status : 'none';
}

/**
 * 解析 `svn status --xml` 输出。
 *
 * @param xml SVN 状态 XML。
 * @param workingDirectory 执行命令的工作副本根目录。
 * @returns 工作副本状态列表。
 */
export function parseStatusXml(xml: string, workingDirectory: string): readonly SvnStatusEntry[] {
  const document = parser.parse(xml) as {
    status?: {
      target?: { entry?: unknown } | readonly { entry?: unknown }[];
      changelist?:
        | { name?: unknown; entry?: unknown }
        | readonly { name?: unknown; entry?: unknown }[];
    };
  };
  const containers = [
    ...asArray(document.status?.target).map((target) => ({ target })),
    ...asArray(document.status?.changelist).map((target) => ({
      target,
      changelist: String(target.name ?? '') || undefined
    }))
  ];
  const result: SvnStatusEntry[] = [];

  for (const container of containers) {
    const target = container.target;
    const changelist =
      'changelist' in container ? (container.changelist as string | undefined) : undefined;
    const entries = asArray((target as { entry?: unknown }).entry) as readonly Record<string, unknown>[];
    for (const entry of entries) {
      const wcStatus = (entry['wc-status'] ?? {}) as Record<string, unknown>;
      const entryPath = String(entry.path ?? '');
      result.push({
        absolutePath: path.resolve(workingDirectory, entryPath),
        item: toStatus(wcStatus.item),
        propertyStatus: toStatus(wcStatus.props),
        changelist,
        revision: wcStatus.revision === undefined ? undefined : String(wcStatus.revision),
        treeConflicted: String(wcStatus['tree-conflicted'] ?? 'false') === 'true',
        switched: String(wcStatus.switched ?? 'false') === 'true',
        copied: String(wcStatus.copied ?? 'false') === 'true',
        locked: wcStatus.lock !== undefined
      });
    }
  }
  return result;
}

/**
 * 解析 `svn proplist --xml` 输出中的属性名称。
 *
 * @param xml SVN 属性列表 XML。
 * @returns 去重并按名称排序的属性名称。
 */
export function parsePropertyNamesXml(xml: string): readonly string[] {
  const document = parser.parse(xml) as {
    properties?: {
      target?: { property?: unknown } | readonly { property?: unknown }[];
    };
  };
  const names = new Set<string>();
  for (const target of asArray(document.properties?.target)) {
    const properties = asArray(target.property) as readonly Record<string, unknown>[];
    for (const property of properties) {
      const name = String(property.name ?? '').trim();
      if (name) {
        names.add(name);
      }
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

/**
 * 解析 `svn info --xml` 的首个条目。
 *
 * @param xml SVN 信息 XML。
 * @returns 标准化的工作副本信息。
 */
export function parseInfoXml(xml: string): SvnInfo {
  const document = parser.parse(xml) as {
    info?: {
      entry?: {
        path?: unknown;
        revision?: unknown;
        url?: unknown;
        repository?: { root?: unknown; uuid?: unknown };
        wcInfo?: { 'wcroot-abspath'?: unknown };
        'wc-info'?: { 'wcroot-abspath'?: unknown };
        conflict?: {
          type?: unknown;
          operation?: unknown;
          'prev-base-file'?: unknown;
          'prev-wc-file'?: unknown;
          'cur-base-file'?: unknown;
        };
      };
    };
  };
  const entry = document.info?.entry;
  if (!entry) {
    throw new Error('SVN 信息中没有工作副本条目。');
  }
  const wcInfo = entry['wc-info'] ?? entry.wcInfo;
  const conflict = entry.conflict;
  const supportedConflictTypes: readonly SvnConflictType[] = ['text', 'property', 'tree'];
  const conflictType = asText(conflict?.type) as SvnConflictType;
  return {
    path: asText(entry.path),
    url: asText(entry.url),
    repositoryRoot: asText(entry.repository?.root),
    repositoryUuid: asText(entry.repository?.uuid),
    revision: asText(entry.revision),
    workingCopyRoot: asText(wcInfo?.['wcroot-abspath']),
    conflict: conflict
      ? {
          type: supportedConflictTypes.includes(conflictType) ? conflictType : 'unknown',
          operation: asText(conflict.operation),
          previousBaseFile: asText(conflict['prev-base-file']) || undefined,
          previousWorkingFile: asText(conflict['prev-wc-file']) || undefined,
          currentBaseFile: asText(conflict['cur-base-file']) || undefined
        }
      : undefined
  };
}

/**
 * 解析 `svn log --xml --verbose` 输出。
 *
 * @param xml SVN 历史 XML。
 * @returns 按 SVN 输出顺序排列的历史记录。
 */
export function parseLogXml(xml: string): readonly SvnLogEntry[] {
  const document = parser.parse(xml) as {
    log?: { logentry?: unknown };
  };
  const entries = asArray(document.log?.logentry) as readonly Record<string, unknown>[];
  return entries.map((entry): SvnLogEntry => {
    const pathContainer = (entry.paths ?? {}) as { path?: unknown };
    const paths = (asArray(pathContainer.path) as readonly Record<string, unknown>[]).map(
      (changedPath): SvnLogPath => ({
        action: String(changedPath.action ?? ''),
        path: asText(changedPath),
        copyFromPath:
          changedPath['copyfrom-path'] === undefined
            ? undefined
            : String(changedPath['copyfrom-path']),
        copyFromRevision:
          changedPath['copyfrom-rev'] === undefined
            ? undefined
            : String(changedPath['copyfrom-rev'])
      })
    );
    return {
      revision: String(entry.revision ?? ''),
      author: asText(entry.author) || '未知作者',
      date: asText(entry.date),
      message: asText(entry.msg),
      paths
    };
  });
}

/**
 * 解析 `svn blame --xml` 输出。
 *
 * @param xml SVN Blame XML。
 * @returns 按文件行号排列的追溯信息。
 */
export function parseBlameXml(xml: string): readonly SvnBlameLine[] {
  const document = parser.parse(xml) as {
    blame?: { target?: { entry?: unknown } | readonly { entry?: unknown }[] };
  };
  const targets = asArray(document.blame?.target);
  const result: SvnBlameLine[] = [];
  for (const target of targets) {
    const entries = asArray((target as { entry?: unknown }).entry) as readonly Record<
      string,
      unknown
    >[];
    for (const entry of entries) {
      const commit = (entry.commit ?? {}) as Record<string, unknown>;
      result.push({
        lineNumber: Number(entry['line-number'] ?? 0),
        revision: String(commit.revision ?? ''),
        author: asText(commit.author) || '未知作者',
        date: asText(commit.date)
      });
    }
  }
  return result.sort((left, right) => left.lineNumber - right.lineNumber);
}
