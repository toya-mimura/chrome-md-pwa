/* =========================================================
   Markdown Viewer PWA
   ========================================================= */
(() => {
  'use strict';

  const DESKTOP_MQ = window.matchMedia('(min-width: 961px)');
  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
  const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g;

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v;
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, String(value)); } catch (e) { /* private mode 等 */ }
    }
  };

  const $ = (id) => document.getElementById(id);

  class MarkdownViewerPWA {
    constructor() {
      this.prefs = {
        theme: store.get('theme', 'system'),
        tocVisible: store.get('tocVisible', 'true') !== 'false',
        lineNumbers: store.get('lineNumbers', 'true') !== 'false',
        wrapCode: store.get('wrapCode', 'false') === 'true'
      };

      this.el = {
        upload: $('upload-area'),
        viewer: $('markdown-viewer'),
        body: $('markdown-body'),
        layout: $('layout'),
        tocPanel: $('toc-panel'),
        tocList: $('toc-list'),
        tocFilter: $('toc-filter'),
        tocBackdrop: $('toc-backdrop'),
        tocToggle: $('toc-toggle'),
        tocFab: $('toc-fab'),
        progressBar: document.querySelector('.reading-progress-bar'),
        backToTop: $('back-to-top'),
        stats: $('reading-stats'),
        docTitle: $('doc-title'),
        settingsButton: $('settings-button'),
        settingsMenu: $('settings-menu'),
        fileInput: $('file-input')
      };

      this.headings = [];
      this.tocIndex = new Map();   // id -> { link, item, ancestors: [link...] }
      this.activeId = null;
      this.deferredPrompt = null;

      this.configureMarked();
      this.bindStaticEvents();
      this.applyTheme(this.prefs.theme);
      this.applyCodePrefs();
      this.registerServiceWorker();
      this.setupInstallPrompt();
      this.setupLaunchQueue();
    }

    /* ---------------- 初期設定 ---------------- */

    configureMarked() {
      if (window.marked && typeof marked.setOptions === 'function') {
        marked.setOptions({ gfm: true, breaks: false });
      }
    }

    bindStaticEvents() {
      const el = this.el;

      // ファイル入力
      $('file-button').addEventListener('click', () => el.fileInput.click());
      el.fileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) this.openFile(file);
        e.target.value = '';   // 同じファイルを再選択できるように
      });
      $('paste-button').addEventListener('click', () => this.handlePasteButton());
      $('sample-button').addEventListener('click', () => this.loadSample());
      $('new-file-button').addEventListener('click', () => this.showUploadArea());

      // Ctrl+V でも貼り付けできるように（ファイル選択画面のみ）
      document.addEventListener('paste', (e) => {
        if (el.upload.hidden) return;
        const text = e.clipboardData && e.clipboardData.getData('text/plain');
        if (text && text.trim()) {
          e.preventDefault();
          this.render(text, 'クリップボード');
        }
      });

      // ドラッグ&ドロップ（画面全体で受け付ける）
      let dragDepth = 0;
      window.addEventListener('dragenter', (e) => {
        if (!this.hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        document.body.classList.add('drag-over');
      });
      window.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) document.body.classList.remove('drag-over');
      });
      window.addEventListener('dragover', (e) => e.preventDefault());
      window.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        document.body.classList.remove('drag-over');
        const file = e.dataTransfer && e.dataTransfer.files[0];
        if (file) this.openFile(file);
      });

      // 目次
      el.tocToggle.addEventListener('click', () => this.toggleToc());
      el.tocFab.addEventListener('click', () => this.openTocSheet());
      el.tocBackdrop.addEventListener('click', () => this.closeTocSheet());
      el.tocList.addEventListener('click', (e) => this.onTocClick(e));
      el.tocFilter.addEventListener('input', () => this.filterToc(el.tocFilter.value));
      el.tocFilter.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { el.tocFilter.value = ''; this.filterToc(''); }
        if (e.key === 'Enter') {
          const first = el.tocList.querySelector('.toc-item:not(.filtered-out) > .toc-row .toc-link');
          if (first) first.click();
        }
      });
      $('toc-expand-all').addEventListener('click', () => this.setAllCollapsed(false));
      $('toc-collapse-all').addEventListener('click', () => this.setAllCollapsed(true));
      this.setupSheetSwipe();
      DESKTOP_MQ.addEventListener('change', () => { this.closeTocSheet(); this.applyTocVisibility(); });

      // 設定メニュー
      el.settingsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setSettingsOpen(el.settingsMenu.hidden);
      });
      document.addEventListener('click', (e) => {
        if (!el.settingsMenu.hidden && !el.settingsMenu.contains(e.target)) this.setSettingsOpen(false);
      });
      el.settingsMenu.querySelectorAll('[data-theme-value]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.prefs.theme = btn.dataset.themeValue;
          store.set('theme', this.prefs.theme);
          this.applyTheme(this.prefs.theme);
        });
      });
      const lnToggle = $('line-numbers-toggle');
      const wrapToggle = $('wrap-code-toggle');
      lnToggle.checked = this.prefs.lineNumbers;
      wrapToggle.checked = this.prefs.wrapCode;
      lnToggle.addEventListener('change', () => {
        this.prefs.lineNumbers = lnToggle.checked;
        store.set('lineNumbers', this.prefs.lineNumbers);
        this.applyCodePrefs();
      });
      wrapToggle.addEventListener('change', () => {
        this.prefs.wrapCode = wrapToggle.checked;
        store.set('wrapCode', this.prefs.wrapCode);
        this.applyCodePrefs();
      });

      // Esc でシート・メニューを閉じる
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        this.setSettingsOpen(false);
        this.closeTocSheet();
      });

      // スクロール（進捗バー・トップへ戻る・現在地ハイライト）
      let ticking = false;
      window.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          this.onScroll();
        });
      }, { passive: true });
      window.addEventListener('resize', () => this.onScroll(), { passive: true });

      el.backToTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    }

    hasFiles(e) {
      return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    }

    /* ---------------- 読み込み ---------------- */

    async openFile(file) {
      try {
        const text = await file.text();
        this.render(text, file.name);
      } catch (err) {
        alert('ファイルを読み込めませんでした: ' + err.message);
      }
    }

    async handlePasteButton() {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          this.render(text, 'クリップボード');
        } else {
          alert('クリップボードにテキストが見つかりません');
        }
      } catch (err) {
        alert('クリップボードを読み取れませんでした。Ctrl+V（長押し→貼り付け）でも貼り付けできます。');
      }
    }

    async loadSample() {
      try {
        const res = await fetch('test-markdown.md', { cache: 'no-cache' });
        if (!res.ok) throw new Error(res.status);
        this.render(await res.text(), 'test-markdown.md');
      } catch (e) {
        this.render('# サンプルを読み込めませんでした\n\nオフラインの場合は一度オンラインで開いてください。', 'サンプル');
      }
    }

    setupLaunchQueue() {
      // manifest.json の file_handlers から起動されたとき
      if (!('launchQueue' in window)) return;
      window.launchQueue.setConsumer(async (params) => {
        if (!params.files || params.files.length === 0) return;
        const file = await params.files[0].getFile();
        this.openFile(file);
      });
    }

    /* ---------------- 描画 ---------------- */

    render(markdownText, sourceName) {
      const rawHtml = marked.parse(markdownText);
      const safeHtml = window.DOMPurify
        ? DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target'] })
        : rawHtml;

      this.el.body.innerHTML = safeHtml;

      this.decorateHeadings();
      this.decorateCodeBlocks();
      this.decorateLinks();
      this.buildToc();
      this.updateStats();
      this.updateTitle(sourceName);

      this.el.upload.hidden = true;
      this.el.viewer.hidden = false;
      this.el.tocFilter.value = '';
      this.applyTocVisibility();
      window.scrollTo(0, 0);
      this.activeId = null;
      this.onScroll();
    }

    showUploadArea() {
      this.closeTocSheet();
      this.setSettingsOpen(false);
      this.el.viewer.hidden = true;
      this.el.upload.hidden = false;
      document.title = 'Markdown Viewer PWA';
      window.scrollTo(0, 0);
    }

    /** GitHub 互換の見出しスラッグ（日本語などの Unicode 文字を保持する） */
    slugify(text) {
      return text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-');
    }

    decorateHeadings() {
      const used = new Set();
      this.headings = Array.from(this.el.body.querySelectorAll(HEADING_SELECTOR));

      this.headings.forEach((h) => {
        const base = this.slugify(h.textContent) || 'section';
        let id = base;
        let n = 1;
        while (used.has(id)) id = `${base}-${n++}`;
        used.add(id);
        h.id = id;

        const anchor = document.createElement('a');
        anchor.className = 'heading-anchor';
        anchor.href = '#' + encodeURIComponent(id);
        anchor.setAttribute('aria-label', 'この見出しへのリンク');
        anchor.textContent = '#';
        h.prepend(anchor);
      });
    }

    decorateCodeBlocks() {
      this.el.body.querySelectorAll('pre > code').forEach((code) => {
        const pre = code.parentElement;
        const langClass = Array.from(code.classList).find((c) => c.startsWith('language-'));
        if (langClass) pre.dataset.lang = langClass.slice('language-'.length);

        // 各行を <span class="line"> で包む（行番号は CSS の counter で描画）
        const text = code.textContent.replace(/\n$/, '');
        const lines = text.split('\n');
        const frag = document.createDocumentFragment();
        lines.forEach((line, i) => {
          const span = document.createElement('span');
          span.className = 'line';
          span.textContent = line + (i < lines.length - 1 ? '\n' : '');
          frag.appendChild(span);
        });
        code.textContent = '';
        code.appendChild(frag);

        pre.classList.add('has-lines');
        pre.style.setProperty('--ln-digits', String(lines.length).length);
      });
    }

    decorateLinks() {
      this.el.body.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href');
        if (/^https?:\/\//i.test(href)) {
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        }
      });
    }

    updateTitle(sourceName) {
      const h1 = this.el.body.querySelector('h1');
      const headingTitle = h1 ? h1.textContent.replace(/^#/, '').trim() : '';
      const title = headingTitle || sourceName || 'MD Viewer';
      this.el.docTitle.textContent = title;
      this.el.docTitle.title = sourceName || '';
      document.title = `${title} - MD Viewer`;
    }

    updateStats() {
      const text = this.el.body.innerText || this.el.body.textContent || '';
      const cjk = (text.match(CJK_RE) || []).length;
      const words = (text.replace(CJK_RE, ' ').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
      const chars = text.replace(/\s/g, '').length;
      // 日本語 約500字/分、英語 約200語/分
      const minutes = Math.max(1, Math.ceil(cjk / 500 + words / 200));
      this.el.stats.textContent = `${chars.toLocaleString()}文字 · 約${minutes}分`;
    }

    applyCodePrefs() {
      document.body.classList.toggle('ln-on', this.prefs.lineNumbers);
      document.body.classList.toggle('wrap-code', this.prefs.wrapCode);
    }

    applyTheme(theme) {
      document.documentElement.dataset.theme = theme;
      this.el.settingsMenu.querySelectorAll('[data-theme-value]').forEach((btn) => {
        btn.setAttribute('aria-checked', String(btn.dataset.themeValue === theme));
      });
    }

    setSettingsOpen(open) {
      this.el.settingsMenu.hidden = !open;
      this.el.settingsButton.setAttribute('aria-expanded', String(open));
    }

    /* ---------------- 目次 ---------------- */

    buildToc() {
      const list = this.el.tocList;
      list.textContent = '';
      list.classList.remove('filtering');
      this.tocIndex.clear();
      this.spyHeadings = [];

      if (this.headings.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'toc-empty';
        empty.textContent = '見出しが見つかりません';
        list.appendChild(empty);
        return;
      }

      // 先頭に H1 が1つだけある場合は文書タイトルとみなし、目次から外す（ナビバーに表示済み）
      let tocHeadings = this.headings;
      const h1s = this.headings.filter((h) => h.tagName === 'H1');
      if (h1s.length === 1 && this.headings[0] === h1s[0] && this.headings.length > 1) {
        tocHeadings = this.headings.slice(1);
      }

      const minLevel = Math.min(...tocHeadings.map((h) => +h.tagName[1]));
      const root = document.createElement('ul');
      // stack[i] = { level, ul, link }
      const stack = [{ level: minLevel - 1, ul: root, link: null }];
      const autoCollapse = tocHeadings.length > 40;

      tocHeadings.forEach((h) => {
        const level = +h.tagName[1];
        while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();

        let parent = stack[stack.length - 1];
        // 親の <li> に子用の <ul> がまだなければ作る
        if (parent.item && !parent.childUl) {
          parent.childUl = document.createElement('ul');
          parent.item.appendChild(parent.childUl);
          parent.item.classList.add('has-children');
          if (autoCollapse && parent.depth >= 1) parent.item.classList.add('collapsed');
        }
        const ul = parent.childUl || parent.ul;
        const depth = stack.length - 1;

        const item = document.createElement('li');
        item.className = `toc-item toc-level-${level - minLevel + 1}`;
        item.dataset.target = h.id;

        const row = document.createElement('div');
        row.className = 'toc-row';

        const spacer = document.createElement('span');
        spacer.className = 'toc-caret-spacer';
        row.appendChild(spacer);

        const link = document.createElement('a');
        link.className = 'toc-link';
        link.href = '#' + encodeURIComponent(h.id);
        link.dataset.target = h.id;
        const label = h.textContent.replace(/^#/, '').trim();
        link.textContent = label;
        link.dataset.label = label;
        link.title = label;
        row.appendChild(link);

        item.appendChild(row);
        ul.appendChild(item);

        const ancestors = stack.slice(1).map((s) => s.link);
        this.tocIndex.set(h.id, { link, item, ancestors });
        stack.push({ level, ul, item, link, depth, childUl: null });
      });

      // 子を持つ項目の spacer を開閉ボタンに置き換える
      root.querySelectorAll('.toc-item.has-children').forEach((item) => {
        const spacer = item.querySelector(':scope > .toc-row > .toc-caret-spacer');
        const caret = document.createElement('button');
        caret.className = 'toc-caret';
        caret.type = 'button';
        caret.setAttribute('aria-label', '折りたたみ切り替え');
        caret.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        caret.setAttribute('aria-expanded', String(!item.classList.contains('collapsed')));
        spacer.replaceWith(caret);
      });

      list.appendChild(root);
      this.spyHeadings = tocHeadings;
    }

    onTocClick(e) {
      const caret = e.target.closest('.toc-caret');
      if (caret) {
        const item = caret.closest('.toc-item');
        const collapsed = item.classList.toggle('collapsed');
        caret.setAttribute('aria-expanded', String(!collapsed));
        return;
      }

      const link = e.target.closest('.toc-link');
      if (!link) return;
      e.preventDefault();
      const id = link.dataset.target;
      const target = document.getElementById(id);
      if (!target) return;

      this.closeTocSheet();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', '#' + encodeURIComponent(id));
      this.setActive(id, { scrollToc: false });
    }

    setAllCollapsed(collapsed) {
      this.el.tocList.querySelectorAll('.toc-item.has-children').forEach((item) => {
        item.classList.toggle('collapsed', collapsed);
        const caret = item.querySelector(':scope > .toc-row > .toc-caret');
        if (caret) caret.setAttribute('aria-expanded', String(!collapsed));
      });
      if (!collapsed && this.activeId) this.setActive(this.activeId, { force: true });
    }

    filterToc(query) {
      const q = query.trim().toLowerCase();
      const list = this.el.tocList;
      list.classList.toggle('filtering', q.length > 0);

      const items = Array.from(list.querySelectorAll('.toc-item'));
      items.forEach((item) => item.classList.remove('filtered-out'));

      // ラベルのハイライトを戻す/付ける
      items.forEach((item) => {
        const link = item.querySelector(':scope > .toc-row > .toc-link');
        const label = link.dataset.label;
        link.textContent = '';
        const idx = q ? label.toLowerCase().indexOf(q) : -1;
        if (idx < 0) {
          link.textContent = label;
        } else {
          const mark = document.createElement('mark');
          mark.textContent = label.slice(idx, idx + q.length);
          link.append(label.slice(0, idx), mark, label.slice(idx + q.length));
        }
        item.dataset.match = String(idx >= 0);
      });

      if (!q) return;

      // 子孫のどれかが一致すれば親も表示する（後ろから処理）
      items.reverse().forEach((item) => {
        const selfMatch = item.dataset.match === 'true';
        const childVisible = item.querySelector(':scope > ul > .toc-item:not(.filtered-out)');
        if (!selfMatch && !childVisible) item.classList.add('filtered-out');
      });
    }

    toggleToc() {
      if (DESKTOP_MQ.matches) {
        this.prefs.tocVisible = !this.prefs.tocVisible;
        store.set('tocVisible', this.prefs.tocVisible);
        this.applyTocVisibility();
      } else if (this.el.tocPanel.classList.contains('open')) {
        this.closeTocSheet();
      } else {
        this.openTocSheet();
      }
    }

    applyTocVisibility() {
      const collapsed = DESKTOP_MQ.matches && !this.prefs.tocVisible;
      this.el.layout.classList.toggle('toc-collapsed', collapsed);
      this.el.tocToggle.setAttribute('aria-pressed', String(DESKTOP_MQ.matches && !collapsed));
    }

    openTocSheet() {
      if (DESKTOP_MQ.matches) return;
      this.el.tocPanel.style.transform = '';
      this.el.tocPanel.classList.add('open');
      this.el.tocBackdrop.hidden = false;
      document.body.style.overflow = 'hidden';
      if (this.activeId) this.setActive(this.activeId, { force: true });
    }

    closeTocSheet() {
      if (!this.el.tocPanel.classList.contains('open')) return;
      this.el.tocPanel.classList.remove('open');
      this.el.tocPanel.style.transform = '';
      this.el.tocBackdrop.hidden = true;
      document.body.style.overflow = '';
    }

    setupSheetSwipe() {
      // シート上部（ハンドル・ヘッダー）を下にスワイプすると閉じる
      const panel = this.el.tocPanel;
      let startY = null;
      let dy = 0;

      panel.addEventListener('touchstart', (e) => {
        if (DESKTOP_MQ.matches) return;
        const onHandle = e.target.closest('.toc-sheet-handle, .toc-header');
        const listAtTop = this.el.tocList.scrollTop <= 0 && e.target.closest('.toc-list');
        if (!onHandle && !listAtTop) return;
        startY = e.touches[0].clientY;
        dy = 0;
        panel.style.transition = 'none';
      }, { passive: true });

      panel.addEventListener('touchmove', (e) => {
        if (startY === null) return;
        dy = Math.max(0, e.touches[0].clientY - startY);
        if (dy > 0) panel.style.transform = `translateY(${dy}px)`;
      }, { passive: true });

      panel.addEventListener('touchend', () => {
        if (startY === null) return;
        panel.style.transition = '';
        if (dy > 80) this.closeTocSheet();
        else panel.style.transform = '';
        startY = null;
      });
    }

    /* ---------------- スクロール連動 ---------------- */

    onScroll() {
      if (this.el.viewer.hidden) return;

      const scrollTop = window.scrollY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const pct = max > 0 ? Math.min(100, (scrollTop / max) * 100) : 100;
      this.el.progressBar.style.width = pct + '%';
      this.el.backToTop.classList.toggle('visible', scrollTop > 400);

      this.updateActiveHeading(max - scrollTop < 4);
    }

    updateActiveHeading(atBottom) {
      const hs = this.spyHeadings || [];
      if (hs.length === 0) return;
      const navbarH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--navbar-h')) || 56;
      const threshold = navbarH + 40;

      let current = null;
      if (atBottom) {
        current = hs[hs.length - 1];
      } else {
        for (const h of hs) {
          if (h.getBoundingClientRect().top <= threshold) current = h;
          else break;
        }
      }
      if (current) this.setActive(current.id);
      else this.clearActive();
    }

    clearActive() {
      if (this.activeId === null) return;
      this.el.tocList.querySelectorAll('.toc-link.active, .toc-link.ancestor')
        .forEach((l) => l.classList.remove('active', 'ancestor'));
      this.activeId = null;
      this.el.tocList.scrollTop = 0;
    }

    setActive(id, { scrollToc = true, force = false } = {}) {
      if (id === this.activeId && !force) return;
      const entry = this.tocIndex.get(id);
      if (!entry) return;

      this.el.tocList.querySelectorAll('.toc-link.active, .toc-link.ancestor')
        .forEach((l) => l.classList.remove('active', 'ancestor'));

      entry.link.classList.add('active');
      entry.ancestors.forEach((l) => l.classList.add('ancestor'));

      // 折りたたまれた親を開く
      let item = entry.item.parentElement && entry.item.parentElement.closest('.toc-item');
      while (item) {
        if (item.classList.contains('collapsed')) {
          item.classList.remove('collapsed');
          const caret = item.querySelector(':scope > .toc-row > .toc-caret');
          if (caret) caret.setAttribute('aria-expanded', 'true');
        }
        item = item.parentElement && item.parentElement.closest('.toc-item');
      }

      this.activeId = id;
      if (scrollToc) this.scrollTocTo(entry.link);
    }

    /** 目次リスト内だけをスクロールして現在地を見える位置に（ページはスクロールしない） */
    scrollTocTo(link) {
      const list = this.el.tocList;
      if (!list.offsetParent) return;
      const listRect = list.getBoundingClientRect();
      const linkRect = link.getBoundingClientRect();
      const margin = 48;
      if (linkRect.top < listRect.top + margin || linkRect.bottom > listRect.bottom - margin) {
        list.scrollTop += (linkRect.top - listRect.top) - list.clientHeight / 3;
      }
    }

    /* ---------------- PWA ---------------- */

    registerServiceWorker() {
      if (!('serviceWorker' in navigator)) return;
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => {
          console.warn('Service Worker registration failed:', err);
        });
      });
    }

    setupInstallPrompt() {
      const prompt = $('install-prompt');
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        this.deferredPrompt = e;
        if (store.get('installPromptDismissed', '') !== 'true') prompt.hidden = false;
      });
      window.addEventListener('appinstalled', () => { prompt.hidden = true; });

      $('install-button').addEventListener('click', async () => {
        if (!this.deferredPrompt) return;
        this.deferredPrompt.prompt();
        await this.deferredPrompt.userChoice;
        this.deferredPrompt = null;
        prompt.hidden = true;
      });
      $('dismiss-button').addEventListener('click', () => {
        prompt.hidden = true;
        store.set('installPromptDismissed', 'true');
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    window.mdViewer = new MarkdownViewerPWA();
  });
})();
