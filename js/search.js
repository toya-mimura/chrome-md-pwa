/* =========================================================
   ページ内検索
   - インストール版 PWA ではブラウザの「ページ内検索」が使えないため自前で実装
   - CSS Custom Highlight API で DOM を書き換えずにハイライトする
   - 太字やリンクをまたぐ一致も見つかるよう、テキストノードを連結して検索する
   ========================================================= */
(() => {
  'use strict';

  const MAX_MATCHES = 2000;
  const HAS_HIGHLIGHT = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';

  class DocSearch {
    constructor({ root, bar, input, count, prevBtn, nextBtn, closeBtn, onOpenChange }) {
      this.root = root;
      this.bar = bar;
      this.input = input;
      this.countEl = count;
      this.onOpenChange = onOpenChange || (() => {});
      this.index = null;
      this.matches = [];
      this.current = -1;
      this.timer = null;

      input.addEventListener('input', () => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.search(input.value), 120);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          clearTimeout(this.timer);
          if (this.lastQuery !== input.value) this.search(input.value);
          else if (e.shiftKey) this.prev();
          else this.next();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.close();
        }
      });
      prevBtn.addEventListener('click', () => this.prev());
      nextBtn.addEventListener('click', () => this.next());
      closeBtn.addEventListener('click', () => this.close());
    }

    get isOpen() { return !this.bar.hidden; }

    open() {
      if (!this.isOpen) {
        this.bar.hidden = false;
        this.onOpenChange(true);
      }
      // 選択中の文字があれば検索語にする
      const sel = window.getSelection && String(window.getSelection()).trim();
      if (sel && sel.length < 80 && !sel.includes('\n')) {
        this.input.value = sel;
        this.search(sel);
      }
      this.input.focus();
      this.input.select();
    }

    close() {
      if (!this.isOpen) return;
      this.bar.hidden = true;
      this.clearHighlights();
      this.onOpenChange(false);
      this.input.blur();
    }

    /** 文書を描画し直したら呼ぶ */
    reset() {
      this.index = null;
      this.matches = [];
      this.current = -1;
      this.clearHighlights();
      if (this.isOpen && this.input.value) this.search(this.input.value);
      else this.updateCount();
    }

    buildIndex() {
      const nodes = [];
      const starts = [];
      let text = '';
      const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement && n.parentElement.closest('.heading-anchor, script, style, .katex-mathml, .mermaid-diagram, .code-header')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
      });
      let n;
      while ((n = walker.nextNode())) {
        nodes.push(n);
        starts.push(text.length);
        text += n.nodeValue;
      }
      this.index = { nodes, starts, lower: text.toLowerCase() };
    }

    /** 連結テキスト上の位置 → (テキストノード, オフセット) */
    locate(pos) {
      const { starts, nodes } = this.index;
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
      }
      return { node: nodes[lo], offset: pos - starts[lo] };
    }

    search(query) {
      this.lastQuery = query;
      this.clearHighlights();
      this.matches = [];
      this.current = -1;

      const q = query.toLowerCase();
      if (!q.trim()) { this.updateCount(); return; }
      if (!this.index) this.buildIndex();

      const hay = this.index.lower;
      let from = 0;
      while (this.matches.length < MAX_MATCHES) {
        const i = hay.indexOf(q, from);
        if (i < 0) break;
        const a = this.locate(i);
        const b = this.locate(i + q.length - 1);
        const range = document.createRange();
        try {
          range.setStart(a.node, a.offset);
          range.setEnd(b.node, b.offset + 1);
          this.matches.push(range);
        } catch (e) { /* noop */ }
        from = i + q.length;
      }

      if (HAS_HIGHLIGHT) CSS.highlights.set('search', new Highlight(...this.matches));

      // 画面に見えている位置以降で最初の一致から始める
      if (this.matches.length) {
        const top = window.innerHeight * 0.15;
        let idx = this.matches.findIndex((r) => r.getBoundingClientRect().top >= top);
        if (idx < 0) idx = 0;
        this.goTo(idx);
      } else {
        this.updateCount();
      }
    }

    next() { if (this.matches.length) this.goTo((this.current + 1) % this.matches.length); }
    prev() { if (this.matches.length) this.goTo((this.current - 1 + this.matches.length) % this.matches.length); }

    goTo(i) {
      this.current = i;
      const range = this.matches[i];
      if (HAS_HIGHLIGHT) {
        CSS.highlights.set('search-current', new Highlight(range));
      } else {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      this.reveal(range);
      this.updateCount();
    }

    reveal(range) {
      // コードブロック内なら横スクロールも合わせる
      const el = range.startContainer.parentElement;
      const pre = el && el.closest('pre');
      if (pre) {
        const r = range.getBoundingClientRect();
        const p = pre.getBoundingClientRect();
        if (r.left < p.left + 60 || r.right > p.right - 20) {
          pre.scrollLeft += r.left - p.left - p.width / 3;
        }
      }
      const rect = range.getBoundingClientRect();
      const topLimit = this.bar.getBoundingClientRect().bottom + 24;
      if (rect.top < topLimit || rect.bottom > window.innerHeight - 64) {
        window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight / 3 });
      }
    }

    updateCount() {
      if (!this.input.value.trim()) this.countEl.textContent = '';
      else if (!this.matches.length) this.countEl.textContent = '0件';
      else this.countEl.textContent = `${this.current + 1} / ${this.matches.length}${this.matches.length >= MAX_MATCHES ? '+' : ''}`;
      this.bar.classList.toggle('no-match', !!this.input.value.trim() && !this.matches.length);
    }

    clearHighlights() {
      if (HAS_HIGHLIGHT) {
        CSS.highlights.delete('search');
        CSS.highlights.delete('search-current');
      }
    }
  }

  window.DocSearch = DocSearch;
})();
