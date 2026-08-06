// 轻量 Markdown 渲染（仅依赖 DOM，无第三方库）。
// 内容经 HTML 转义后渲染，避免 XSS。供自定义对话框(dialogUI)与设置页(embyWall)复用。

export function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineMd(s: string): string {
    // 入参已是转义后的纯文本
    s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/(^|[^\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => {
        const safe = /^https?:\/\//i.test(u) ? u : '#';
        return `<a href="${safe}" target="_blank" rel="noopener">${t}</a>`;
    });
    return s;
}

export function renderMarkdown(md: string): string {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let listType: '' | 'ul' | 'ol' = '';
    const closeList = () => { if (listType) { html += `</${listType}>`; listType = ''; } };
    const isBlockStart = (l: string) => /^(#{1,6}\s|>\s?|\s*[-*+]\s|\s*\d+\.\s|```)/.test(l)
        || /^(\-{3,}|\*{3,}|_{3,})$/.test(l.trim());
    let i = 0;
    while (i < lines.length) {
        let line = lines[i];
        // 代码块
        if (/^```/.test(line)) {
            closeList();
            i++;
            const buf: string[] = [];
            while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
            i++;
            html += `<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`;
            continue;
        }
        // 分隔线
        if (/^(\-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { closeList(); html += '<hr>'; i++; continue; }
        // 标题
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) { closeList(); const lvl = h[1].length; html += `<h${lvl}>${inlineMd(escapeHtml(h[2].trim()))}</h${lvl}>`; i++; continue; }
        // 引用
        if (/^>\s?/.test(line)) {
            closeList();
            const buf: string[] = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
            html += `<blockquote>${inlineMd(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</blockquote>`;
            continue;
        }
        // 表格（| 分隔，且下一行是分隔行）
        if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
            closeList();
            const splitRow = (r: string) => r.replace(/^\s*\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
            const headers = splitRow(line);
            i += 2;
            const rows: string[][] = [];
            while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') { rows.push(splitRow(lines[i])); i++; }
            let t = '<table><thead><tr>';
            headers.forEach(hd => { t += `<th>${inlineMd(escapeHtml(hd))}</th>`; });
            t += '</tr></thead><tbody>';
            rows.forEach(r => { t += '<tr>'; headers.forEach((_hd, idx) => { t += `<td>${inlineMd(escapeHtml(r[idx] || ''))}</td>`; }); t += '</tr>'; });
            t += '</tbody></table>';
            html += t;
            continue;
        }
        // 列表
        const ul = line.match(/^\s*[-*+]\s+(.*)$/);
        const ol = line.match(/^\s*\d+\.\s+(.*)$/);
        if (ul || ol) {
            const type = ul ? 'ul' : 'ol';
            if (listType !== type) { closeList(); html += `<${type}>`; listType = type; }
            const content = ul ? ul[1] : ol![1];
            html += `<li>${inlineMd(escapeHtml(content))}</li>`;
            i++; continue;
        }
        // 空行
        if (line.trim() === '') { closeList(); i++; continue; }
        // 段落
        closeList();
        const buf: string[] = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
        html += `<p>${inlineMd(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</p>`;
    }
    closeList();
    return `<div class="md-body">${html}</div>`;
}

// 供对话框等独立场景注入，无需依赖 embyWall 的全局 CSS。
// 同 embyWall.md-body 样式，统一维护（弹窗卡片内独立生效，浅色亚克力底色适配）。
export const MD_BODY_CSS = `
.md-body{font-size:13px;line-height:1.7;color:#3a2d4d;word-break:break-word;}
.md-body h1{font-size:18px;font-weight:700;margin:12px 0 8px;color:#2e2340;border-bottom:1px solid rgba(139,111,209,.22);padding-bottom:6px;}
.md-body h2{font-size:15.5px;font-weight:700;margin:12px 0 6px;color:#2e2340;}
.md-body h3{font-size:14px;font-weight:600;margin:10px 0 5px;color:#3a2d4d;}
.md-body h4{font-size:13px;font-weight:600;margin:8px 0 4px;color:#3a2d4d;}
.md-body p{margin:6px 0;}
.md-body ul,.md-body ol{margin:6px 0;padding-left:20px;}
.md-body li{margin:3px 0;}
.md-body code{background:rgba(139,111,209,.12);padding:1px 5px;border-radius:4px;font-family:Consolas,Menlo,monospace;font-size:12px;color:#5a3ec0;}
.md-body pre{background:rgba(46,35,64,.06);border:1px solid rgba(139,111,209,.18);border-radius:8px;padding:10px 12px;overflow-x:auto;margin:6px 0;}
.md-body pre code{background:none;padding:0;color:#3a2d4d;white-space:pre;}
.md-body blockquote{margin:6px 0;padding:5px 11px;border-left:3px solid rgba(139,111,209,.4);background:rgba(139,111,209,.06);color:#5a4d6e;}
.md-body a{color:#7c4dff;text-decoration:underline;}
.md-body hr{border:none;border-top:1px solid rgba(139,111,209,.22);margin:10px 0;}
.md-body strong{font-weight:700;}
`;
