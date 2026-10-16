/**
 * 格式化有固定占宽上限的行内追溯信息，完整内容由编辑器悬浮提示保留。
 * @param revision 此行对应的 revision。
 * @param author 完整作者名称。
 * @param date SVN 提交时间。
 * @param style 紧凑或完整显示模式。
 * @returns 单行文字及以字符为单位的固定宽度。
 */
export function formatBlameAnnotation(
  revision: string,
  author: string,
  date: string,
  style: 'compact' | 'full'
): { readonly text: string; readonly width: string } {
  const width = style === 'full' ? 46 : 24;
  const shortDate = /^\d{4}-\d{2}-\d{2}T/.test(date) ? date.slice(0, 10) : '未知日期';
  const content = `r${revision} · ${author || '未知作者'}${style === 'full' ? ` · ${shortDate}` : ''}`;
  // 关键逻辑：移除换行等控制字符，保守地按非拉丁字符双宽计算，避免长作者名挤占代码区。
  const characters = [...content.replace(/[\u0000-\u001f\u007f]/g, ' ')];
  let used = 0;
  let text = '';
  for (const character of characters) {
    const size = character.codePointAt(0)! > 0xff ? 2 : 1;
    if (used + size > width - 2) {
      return { text: `${text}…`, width: `${width}ch` };
    }
    text += character;
    used += size;
  }
  return { text, width: `${width}ch` };
}
