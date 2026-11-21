/* =========================================================
   リッチ表示（フェーズ3）
   - コードの色分け（highlight.js）
   - 数式（KaTeX）：$...$ / $$...$$ / ```math
   - 図（Mermaid）：```mermaid
   - GitHub のアラート：> [!NOTE] など
   - コードのコピーボタン
   重いライブラリは、その要素が文書内にあるときだけ読み込む
   ========================================================= */
(() => {
  'use strict';

  const VENDOR = 'js/vendor/';
  const loaded = new Map();

  function loadScript(src) {
    if (!loaded.has(src)) {
      loaded.set(src, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { loaded.delete(src); reject(new Error('読み込み失敗: ' + src)); };
        document.head.appendChild(s);
      }));
    }
    return loaded.get(src);
  }

  function loadStyle(href) {
    if (!loaded.has(href)) {
      loaded.set(href, new Promise((resolve, reject) => {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = href;
        l.onload = resolve;
        l.onerror = () => { loaded.delete(href); reject(new Error('読み込み失敗: ' + href)); };
        document.head.appendChild(l);
      }));
    }
    return loaded.get(href);
  }

  const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* ---------------- marked 拡張：数式 ---------------- */
  const mathExtensions = [
    {
      name: 'mathBlock',
      level: 'block',
      start(src) { const i = src.indexOf('$$'); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$[ \t]*(?:\n+|$)/.exec(src);
        if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
        return undefined;
      },
      renderer(token) {
        return `<div class="math-block" data-tex="${escapeAttr(token.text)}">$$${escapeText(token.text)}$$</div>\n`;
      }
    },
    {
      name: 'mathInline',
      level: 'inline',
      start(src) { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
      tokenizer(src) {
        // $...$（$ の直後・直前が空白なら数式とみなさない。$5 と $10 のような金額を避ける）
        const m = /^\$(?!\s)((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?![0-9])/.exec(src);
        if (m) return { type: 'mathInline', raw: m[0], text: m[1] };
        return undefined;
      },
      renderer(token) {
        return `<span class="math-inline" data-tex="${escapeAttr(token.text)}">$${escapeText(token.text)}$</span>`;
      }
    }
  ];

  /* ---------------- GitHub アラート ---------------- */
  const ALERTS = {
    note: { label: 'Note', icon: '<path d="M12 8h.01M11 12h1v4h1" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/>' },
    tip: { label: 'Tip', icon: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/>' },
    important: { label: 'Important', icon: '<path d="M4 4h16v12H8l-4 4z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M12 7v4M12 13.5h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
    warning: { label: 'Warning', icon: '<path d="M12 3l10 18H2z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
    caution: { label: 'Caution', icon: '<path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' }
  };

  function decorateAlerts(root) {
    root.querySelectorAll('blockquote').forEach((bq) => {
      const p = bq.firstElementChild;
      if (!p || p.tagName !== 'P') return;
      const first = p.firstChild;
      if (!first || first.nodeType !== Node.TEXT_NODE) return;
      const m = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(first.nodeValue);
      if (!m) return;
      const type = m[1].toLowerCase();

      first.nodeValue = first.nodeValue.slice(m[0].length);
      if (p.firstChild && p.firstChild.nodeName === 'BR') p.firstChild.remove();
      if (!p.textContent.trim() && !p.querySelector('img')) p.remove();

      const box = document.createElement('div');
      box.className = `markdown-alert markdown-alert-${type}`;
      if (bq.dataset.ln) box.dataset.ln = bq.dataset.ln;
      const title = document.createElement('p');
      title.className = 'markdown-alert-title';
      title.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">${ALERTS[type].icon}</svg>`;
      title.append(ALERTS[type].label);
      box.appendChild(title);
      while (bq.firstChild) box.appendChild(bq.firstChild);
      bq.replaceWith(box);
    });
  }

  /* ---------------- コードの色分け ---------------- */

  /** highlight.js の HTML を行ごとに分割（行をまたぐ <span> は行末で閉じて次の行で開き直す） */
  function splitHighlightedLines(html) {
    const lines = [];
    const stack = [];
    let cur = '';
    const re = /<span class="([^"]*)">|<\/span>|\n|[^<\n]+/g;
    let m;
    while ((m = re.exec(html))) {
      const t = m[0];
      if (t === '\n') {
        cur += '</span>'.repeat(stack.length);
        lines.push(cur);
        cur = stack.map((c) => `<span class="${c}">`).join('');
      } else if (t === '</span>') {
        stack.pop();
        cur += t;
      } else if (m[1] !== undefined) {
        stack.push(m[1]);
        cur += t;
      } else {
        cur += t;
      }
    }
    lines.push(cur);
    return lines;
  }

  async function highlightCode(root, isStale) {
    const targets = Array.from(root.querySelectorAll('.code-block[data-lang] pre > code'))
      .filter((code) => {
        const lang = code.closest('.code-block').dataset.lang;
        return lang && !['text', 'plain', 'plaintext', 'txt', 'mermaid', 'math'].includes(lang);
      });
    if (!targets.length) return false;

    await Promise.all([loadScript(VENDOR + 'highlight.min.js'), loadStyle('css/vendor/hljs-github-dark.min.css')]);
    if (isStale() || !window.hljs) return false;
    // シェーダー言語は C++ の文法で近似して色分けする（Unity / UE5 用）
    if (!hljs.getLanguage('hlsl') && hljs.getLanguage('cpp')) {
      hljs.registerAliases(['hlsl', 'shader', 'shaderlab', 'usf', 'ush', 'cg'], { languageName: 'cpp' });
    }

    let changed = false;
    targets.forEach((code) => {
      const lang = code.closest('.code-block').dataset.lang;
      if (!hljs.getLanguage(lang)) return;
      const spans = Array.from(code.querySelectorAll(':scope > .line'));
      const text = spans.map((s) => s.textContent.replace(/\n$/, '')).join('\n');
      let html;
      try {
        html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
      } catch (e) { return; }
      const lines = splitHighlightedLines(html);
      if (lines.length !== spans.length) return;
      spans.forEach((span, i) => {
        span.innerHTML = lines[i] + (i < spans.length - 1 ? '\n' : '');
      });
      code.classList.add('hljs');
      changed = true;
    });
    return changed;
  }

  /* ---------------- 数式 ---------------- */
  async function renderMath(root, isStale) {
    // ```math のコードブロックも数式として扱う
    root.querySelectorAll('.code-block[data-lang="math"]').forEach((wrap) => {
      const code = wrap.querySelector('code');
      const div = document.createElement('div');
      div.className = 'math-block';
      div.dataset.tex = code.textContent;
      const header = wrap.querySelector('.code-header');
      if (header && header.dataset.ln) div.dataset.ln = header.dataset.ln;
      div.textContent = code.textContent;
      wrap.replaceWith(div);
    });

    const nodes = Array.from(root.querySelectorAll('.math-block[data-tex], .math-inline[data-tex]'));
    if (!nodes.length) return false;

    await Promise.all([loadScript(VENDOR + 'katex/katex.min.js'), loadStyle(VENDOR + 'katex/katex.min.css')]);
    if (isStale() || !window.katex) return false;

    nodes.forEach((el) => {
      try {
        katex.render(el.dataset.tex, el, {
          displayMode: el.classList.contains('math-block'),
          throwOnError: false,
          output: 'htmlAndMathml'
        });
      } catch (e) {
        el.classList.add('math-error');
      }
    });
    return true;
  }

  /* ---------------- Mermaid ---------------- */
  let mermaidReady = null;
  let mermaidSeq = 0;

  async function renderMermaid(root, isStale) {
    const blocks = Array.from(root.querySelectorAll('.code-block[data-lang="mermaid"]'));
    if (!blocks.length) return false;

    // 読み込み中であることを表示
    blocks.forEach((wrap) => wrap.classList.add('is-mermaid', 'mermaid-loading'));

    if (!mermaidReady) {
      mermaidReady = loadScript(VENDOR + 'mermaid.min.js').then(() => {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'strict',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif',
          themeVariables: {
            background: '#151b23',
            primaryColor: '#1c2532',
            primaryBorderColor: '#4493f8',
            primaryTextColor: '#e6edf3',
            lineColor: '#9198a1',
            edgeLabelBackground: '#151b23',
            clusterBkg: '#0d1117',
            clusterBorder: '#3d444d'
          }
        });
      }).catch((e) => { mermaidReady = null; throw e; });
    }
    try {
      await mermaidReady;
    } catch (e) {
      blocks.forEach((wrap) => wrap.classList.remove('mermaid-loading'));
      return false;
    }
    if (isStale()) return false;

    for (const wrap of blocks) {
      const code = wrap.querySelector('code');
      const src = code.textContent;
      const diagram = document.createElement('div');
      diagram.className = 'mermaid-diagram';
      try {
        const { svg } = await window.mermaid.render(`mmd-${++mermaidSeq}`, src);
        if (isStale()) return false;
        diagram.innerHTML = svg;
        // 狭い画面で縮みすぎないよう、本来の幅（最大600px）を下限にして横スクロールさせる
        const svgEl = diagram.querySelector('svg');
        const vb = svgEl && svgEl.viewBox && svgEl.viewBox.baseVal;
        if (vb && vb.width) svgEl.style.minWidth = Math.min(Math.round(vb.width), 600) + 'px';
        wrap.classList.add('show-diagram');
      } catch (err) {
        diagram.className = 'mermaid-error';
        diagram.textContent = '図を描けませんでした: ' + (err && err.message ? err.message.split('\n')[0] : err);
        wrap.classList.add('show-source');
      }
      wrap.classList.remove('mermaid-loading');
      wrap.insertBefore(diagram, wrap.querySelector('pre'));

      // 図とコードの切り替えボタン
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'code-action mermaid-toggle';
      toggle.textContent = wrap.classList.contains('show-source') ? '図' : 'コード';
      toggle.addEventListener('click', () => {
        const showSource = wrap.classList.toggle('show-source');
        toggle.textContent = showSource ? '図' : 'コード';
      });
      const actions = wrap.querySelector('.code-actions');
      if (actions) actions.prepend(toggle);
    }
    // mermaid が body に残す一時要素の掃除
    document.querySelectorAll('body > [id^="dmmd-"]').forEach((el) => el.remove());
    return true;
  }

  /* ---------------- コピーボタン ---------------- */
  function bindCopyButtons(root) {
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('.code-copy');
      if (!btn || !root.contains(btn)) return;
      const code = btn.closest('.code-block').querySelector('pre code');
      const text = Array.from(code.querySelectorAll('.line')).map((l) => l.textContent.replace(/\n$/, '')).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'コピーしました';
      } catch (err) {
        btn.textContent = 'コピーできません';
      }
      btn.classList.add('done');
      setTimeout(() => { btn.textContent = 'コピー'; btn.classList.remove('done'); }, 1500);
    });
  }

  /**
   * 描画後に呼ぶ。同期で済む処理をしてから、必要なライブラリを読み込んで仕上げる。
   * isStale() が true になったら（別の文書を開いたら）途中でやめる。
   * 返り値の Promise は、本文の DOM が変わった場合に true で解決する。
   */
  async function enhance(root, isStale) {
    decorateAlerts(root);
    const results = await Promise.allSettled([
      highlightCode(root, isStale),
      renderMath(root, isStale),
      renderMermaid(root, isStale)
    ]);
    return results.some((r) => r.status === 'fulfilled' && r.value);
  }

  window.MdRich = { mathExtensions, enhance, bindCopyButtons, loadScript, loadStyle };
})();
