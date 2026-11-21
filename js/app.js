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
        tocVisible: store.get('tocVisible', 'true') !== 'false',
        lineNumbers: store.get('sourceLineNumbers', 'true') !== 'false',
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
        fileInput: $('file-input'),
        recentSection: $('recent-section'),
        recentList: $('recent-list'),
        toast: $('toast'),
        toastText: $('toast-text'),
        toastAction: $('toast-action')
      };

      this.currentDoc = null;      // { key, name, kind, url }
      this.renderSeq = 0;
      this.translation = { active: false, running: null, results: null };
      this.baseUrl = null;         // URL から開いた文書の相対パス解決用
      this.search = new DocSearch({
        root: this.el.body,
        bar: $('search-bar'),
        input: $('search-input'),
        count: $('search-count'),
        prevBtn: $('search-prev'),
        nextBtn: $('search-next'),
        closeBtn: $('search-close'),
        onOpenChange: (open) => {
          document.documentElement.style.setProperty('--searchbar-h', open ? '52px' : '0px');
        }
      });

      this.headings = [];
      this.tocIndex = new Map();   // id -> { link, item, ancestors: [link...] }
      this.activeId = null;
      this.deferredPrompt = null;

      this.configureMarked();
      this.bindStaticEvents();
      this.applyCodePrefs();
      this.registerServiceWorker();
      this.setupInstallPrompt();
      this.setupLaunchQueue();
      if (window.MdRich) MdRich.bindCopyButtons(this.el.body);
      this.setupTranslation();
      this.renderRecent();
      this.handleStartupParams();
    }

    /* ---------------- 初期設定 ---------------- */

    configureMarked() {
      if (window.marked && typeof marked.setOptions === 'function') {
        marked.setOptions({ gfm: true, breaks: false });
        if (window.MdRich) marked.use({ extensions: MdRich.mathExtensions });
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
          this.openDocument(text, { kind: 'text', name: this.guessName(text, 'クリップボード') });
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
      const lnToggle = $('line-numbers-toggle');
      const wrapToggle = $('wrap-code-toggle');
      lnToggle.checked = this.prefs.lineNumbers;
      wrapToggle.checked = this.prefs.wrapCode;
      lnToggle.addEventListener('change', () => {
        this.prefs.lineNumbers = lnToggle.checked;
        store.set('sourceLineNumbers', this.prefs.lineNumbers);
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

      // URL から開く
      $('url-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const url = $('url-input').value.trim();
        if (url) this.openUrl(url);
      });

      // ページ内検索
      $('search-button').addEventListener('click', () => {
        if (this.search.isOpen) this.search.close(); else this.search.open();
      });
      document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f' && !el.viewer.hidden) {
          e.preventDefault();
          this.search.open();
        }
      });

      // 最近開いたファイル
      el.recentList.addEventListener('click', (e) => this.onRecentClick(e));

      // 本文中の .md リンク
      el.body.addEventListener('click', (e) => {
        const a = e.target.closest('a[data-md-link]');
        if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        this.openUrl(a.dataset.mdLink);
      });

      // 読んでいる位置の保存（スクロールが止まったら／アプリを離れるとき）
      let saveTimer = null;
      window.addEventListener('scroll', () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => this.savePosition(), 700);
      }, { passive: true });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.savePosition();
      });
      window.addEventListener('pagehide', () => this.savePosition());

      el.toastAction.addEventListener('click', () => {
        if (this.toastHandler) this.toastHandler();
        this.hideToast();
      });
    }

    hasFiles(e) {
      return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    }

    /* ---------------- 読み込み ---------------- */

    async openFile(file) {
      try {
        const text = await file.text();
        await this.openDocument(text, { kind: 'file', name: file.name });
      } catch (err) {
        alert('ファイルを読み込めませんでした: ' + err.message);
      }
    }

    async handlePasteButton() {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          await this.openDocument(text, { kind: 'text', name: this.guessName(text, 'クリップボード') });
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
        await this.openDocument(await res.text(), { kind: 'file', name: 'test-markdown.md', remember: false });
      } catch (e) {
        this.render('# サンプルを読み込めませんでした\n\nオフラインの場合は一度オンラインで開いてください。', 'サンプル');
      }
    }

    setupLaunchQueue() {
      // manifest.json の file_handlers から起動されたとき（PC のインストール版）
      if (!('launchQueue' in window)) return;
      window.launchQueue.setConsumer(async (params) => {
        if (!params.files || params.files.length === 0) return;
        const file = await params.files[0].getFile();
        this.openFile(file);
      });
    }

    /** テキストの先頭見出しから名前を推測 */
    guessName(text, fallback) {
      const m = text.match(/^\s*#\s+(.+)$/m);
      return m ? m[1].trim().slice(0, 60) : fallback;
    }

    /** GitHub / Gist のページ URL を、本文を直接取れる raw URL に変換する */
    toRawUrl(input) {
      let url;
      try { url = new URL(input); } catch (e) { return null; }
      if (!/^https?:$/.test(url.protocol)) return null;

      // https://github.com/{owner}/{repo}/blob/{ref}/{path}
      let m = url.hostname === 'github.com' && url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
      if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;

      // https://github.com/{owner}/{repo} → README.md（デフォルトブランチ）
      m = url.hostname === 'github.com' && url.pathname.match(/^\/([^/]+)\/([^/]+?)\/?$/);
      if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/README.md`;

      // https://gist.github.com/{user}/{id}
      m = url.hostname === 'gist.github.com' && url.pathname.match(/^\/([^/]+)\/([0-9a-f]+)\/?$/i);
      if (m) return `https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw`;

      return url.href;
    }

    async openUrl(input, { silent = false } = {}) {
      const raw = this.toRawUrl(input);
      if (!raw) {
        if (!silent) alert('URL の形式が正しくありません');
        return false;
      }
      try {
        const res = await fetch(raw, { mode: 'cors', redirect: 'follow' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        const name = decodeURIComponent(new URL(raw).pathname.split('/').pop() || '') || raw;
        await this.openDocument(text, { kind: 'url', name, url: raw, displayUrl: input });
        return true;
      } catch (err) {
        if (!silent) {
          alert('URL から読み込めませんでした（' + err.message + '）。\n'
            + 'サイトが外部からの読み込みを許可していない（CORS）可能性があります。'
            + 'GitHub の場合は raw のURL、またはファイルページのURLを試してください。');
        }
        return false;
      }
    }

    /** 起動時：共有メニュー（Share Target）や ?url= から開かれた場合の処理 */
    async handleStartupParams() {
      const params = new URLSearchParams(location.search);
      const clean = () => history.replaceState(null, '', location.pathname);

      if (params.has('shared')) {
        clean();
        await this.openSharedPayload();
        return;
      }
      if (params.get('url')) {
        const url = params.get('url');
        clean();
        await this.openUrl(url);
      }
    }

    async openSharedPayload() {
      let payload = null;
      try {
        const cache = await caches.open('mdv-share-inbox');
        const res = await cache.match('./__shared__');
        if (res) {
          payload = await res.json();
          await cache.delete('./__shared__');
        }
      } catch (e) { /* noop */ }
      if (!payload) return;

      if (payload.fileText != null) {
        await this.openDocument(payload.fileText, { kind: 'file', name: payload.fileName || '共有されたファイル' });
        return;
      }

      // 共有されたのが URL だけなら、その URL を開く
      const text = (payload.text || '').trim();
      const urlOnly = payload.url || (/^https?:\/\/\S+$/.test(text) ? text : '');
      if (urlOnly && (!text || text === urlOnly)) {
        if (await this.openUrl(urlOnly, { silent: true })) return;
      }
      const body = [text, payload.url && payload.url !== text ? payload.url : ''].filter(Boolean).join('\n\n');
      if (body) {
        await this.openDocument(body, { kind: 'text', name: payload.title || this.guessName(body, '共有されたテキスト') });
      }
    }

    /**
     * 文書を開く共通の入口：描画 → 前回の位置を復元 → 最近開いたファイルに保存
     */
    async openDocument(text, { kind, name, url = null, displayUrl = null, remember = true }) {
      this.savePosition();
      const key = MdLibrary.keyFor({ kind, name, url, content: text });
      const previous = remember ? await MdLibrary.get(key) : null;

      this.baseUrl = kind === 'url' ? url : null;
      this.resetTranslation();
      this.render(text, name);
      this.currentDoc = remember ? { key, name, kind, url, displayUrl } : null;

      if (remember) {
        await MdLibrary.save({
          key,
          name,
          kind,
          url,
          displayUrl,
          content: text,
          chars: text.length,
          opened: Date.now(),
          position: previous ? previous.position : null
        });
      }

      if (previous && previous.position && previous.position.line > 1) {
        // 画像などのレイアウトが落ち着いてから復元する
        requestAnimationFrame(() => {
          if (this.restorePosition(previous.position)) {
            this.showToast(`前回の位置（${previous.position.line}行目）から再開しました`, '最初から', () => {
              window.scrollTo({ top: 0 });
            });
          }
        });
      }
    }

    /* ---------------- 翻訳（Gemini） ---------------- */

    setupTranslation() {
      const dlg = $('gemini-dialog');
      const keyInput = $('gemini-key');
      const modelInput = $('gemini-model');
      const targetSelect = $('translate-target');
      const datalist = $('gemini-models');
      $('gemini-host').textContent = location.host || 'このサイト';

      const openDialog = () => {
        this.setSettingsOpen(false);
        keyInput.value = MdTranslate.settings.key;
        modelInput.value = MdTranslate.settings.model;
        targetSelect.value = MdTranslate.settings.target;
        $('gemini-status').textContent = '';
        dlg.showModal();
      };
      this.openTranslateSettings = openDialog;

      $('translate-button').addEventListener('click', () => this.toggleTranslation());
      $('translate-settings-button').addEventListener('click', openDialog);

      $('gemini-list-models').addEventListener('click', async () => {
        const key = keyInput.value.trim();
        const status = $('gemini-status');
        if (!key) { status.textContent = '先に API キーを入力してください'; return; }
        status.textContent = '取得中…';
        try {
          const models = await MdTranslate.listModels(key);
          datalist.textContent = '';
          models.forEach((m) => {
            const o = document.createElement('option');
            o.value = m;
            datalist.appendChild(o);
          });
          status.textContent = `${models.length}件のモデルが使えます。入力欄から選べます`;
        } catch (e) {
          status.textContent = '取得できませんでした（' + e.message + '）。キーを確認してください';
        }
      });

      $('gemini-clear').addEventListener('click', () => {
        keyInput.value = '';
        MdTranslate.settings.key = '';
        $('gemini-status').textContent = 'キーを削除しました';
      });

      $('gemini-form').addEventListener('submit', (e) => {
        if (e.submitter && e.submitter.value === 'cancel') return;
        const prevTarget = MdTranslate.settings.target;
        MdTranslate.settings.key = keyInput.value.trim();
        MdTranslate.settings.model = modelInput.value.trim() || MdTranslate.DEFAULT_MODEL;
        MdTranslate.settings.target = targetSelect.value;
        // 翻訳先を変えたら、表示中の訳文は破棄する
        if (prevTarget !== targetSelect.value && this.translation.active) this.showOriginal();
      });
    }

    resetTranslation() {
      if (this.translation.running) this.translation.running.abort();
      this.translation = { active: false, running: null, results: null };
      this.updateTranslateButton();
    }

    updateTranslateButton() {
      const btn = $('translate-button');
      btn.setAttribute('aria-pressed', String(this.translation.active));
      btn.title = this.translation.active ? '原文に戻す' : 'Gemini で翻訳';
      $('translate-badge').hidden = !this.translation.active;
    }

    showOriginal() {
      if (this.translation.running) this.translation.running.abort();
      this.translation.active = false;
      this.translation.running = null;
      this.updateTranslateButton();
      this.render(this.sourceText, this.sourceName, { keepPosition: true });
    }

    async toggleTranslation() {
      if (this.translation.active) {
        this.showOriginal();
        this.showToast('原文を表示しています');
        return;
      }
      if (!MdTranslate.settings.key) {
        this.openTranslateSettings();
        return;
      }

      const target = MdTranslate.settings.target;
      const source = this.sourceText;
      const name = this.sourceName;
      const hash = MdLibrary.hash(source);
      const tokens = this.lastTokens;

      // 以前の訳文が残っていれば使う
      let cached = {};
      if (this.currentDoc) {
        const doc = await MdLibrary.get(this.currentDoc.key);
        const tr = doc && doc.translation;
        if (tr && tr.hash === hash && tr.target === target) cached = tr.results || {};
      }

      const controller = new AbortController();
      this.translation = { active: true, running: controller, results: cached };
      this.updateTranslateButton();
      this.render(source, name, { overrides: cached, keepPosition: true });

      try {
        const results = await MdTranslate.translateTokens(tokens, target, {
          signal: controller.signal,
          cached,
          onProgress: (res, done, total) => {
            if (controller.signal.aborted) return;
            this.translation.results = res;
            if (done > 0) this.render(source, name, { overrides: res, keepPosition: true });
            if (total > 0 && done < total) {
              this.showToast(`翻訳中… ${done} / ${total}`, '中止', () => this.showOriginal());
              clearTimeout(this.toastTimer);   // 翻訳中は出したままにする
            }
          }
        });
        if (controller.signal.aborted) return;
        this.translation.running = null;
        if (this.currentDoc) {
          await MdLibrary.setField(this.currentDoc.key, 'translation', {
            hash, target, results, model: MdTranslate.settings.model, saved: Date.now()
          });
        }
        this.showToast(`${MdTranslate.LANGS[target] || target}に翻訳しました`, '原文に戻す', () => this.showOriginal());
      } catch (err) {
        if (controller.signal.aborted || err.name === 'AbortError') return;
        this.translation.running = null;
        let msg = '翻訳できませんでした：' + err.message;
        if (err.status === 400 || err.status === 401 || err.status === 403) msg = 'API キーが正しくないか、使えない状態です（' + err.message + '）';
        else if (err.status === 404) msg = 'モデルが見つかりません。設定の「一覧を取得」で使えるモデルを選んでください';
        else if (err.status === 429) msg = '利用上限に達しました。少し待ってから再度お試しください';
        // 途中まで訳せていればそのまま表示しておく
        if (!this.translation.results || Object.keys(this.translation.results).length === 0) {
          this.translation.active = false;
          this.updateTranslateButton();
          this.render(source, name, { keepPosition: true });
        }
        this.showToast(msg, '設定', () => this.openTranslateSettings());
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => this.hideToast(), 12000);
      }
    }

    /* ---------------- 読んでいる位置 ---------------- */

    /** 画面上端にある要素の「元ファイルの行番号」と、その要素内のずれを返す */
    currentPosition() {
      const navbarH = this.topOffset();
      const els = this.el.body.querySelectorAll('[data-ln]');
      let best = null;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.bottom > navbarH + 4) { best = { el, r }; break; }
      }
      if (!best) return null;
      return {
        line: Number(best.el.dataset.ln),
        offset: Math.max(0, Math.round(navbarH - best.r.top)),
        ratio: this.scrollRatio()
      };
    }

    scrollRatio() {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      return max > 0 ? window.scrollY / max : 0;
    }

    topOffset() {
      const cs = getComputedStyle(document.documentElement);
      return (parseFloat(cs.getPropertyValue('--navbar-h')) || 56)
        + (parseFloat(cs.getPropertyValue('--searchbar-h')) || 0);
    }

    savePosition() {
      if (!this.currentDoc || this.el.viewer.hidden) return;
      const pos = window.scrollY < 40 ? { line: 1, offset: 0, ratio: 0 } : this.currentPosition();
      if (pos) MdLibrary.updatePosition(this.currentDoc.key, { ...pos, saved: Date.now() });
    }

    restorePosition(pos) {
      const els = Array.from(this.el.body.querySelectorAll('[data-ln]'));
      if (!els.length) return false;
      // 保存した行番号以下で最も近い要素（ファイルが編集されていても近い位置に戻る）
      let target = null;
      for (const el of els) {
        if (Number(el.dataset.ln) <= pos.line) target = el; else break;
      }
      if (!target) return false;
      const top = window.scrollY + target.getBoundingClientRect().top - this.topOffset()
        + (Number(target.dataset.ln) === pos.line ? pos.offset || 0 : 0);
      window.scrollTo({ top: Math.max(0, top) });
      return true;
    }

    /* ---------------- 最近開いたファイル ---------------- */

    async renderRecent() {
      const docs = await MdLibrary.list();
      const list = this.el.recentList;
      list.textContent = '';
      this.el.recentSection.hidden = docs.length === 0;

      docs.forEach((doc) => {
        const li = document.createElement('li');
        li.className = 'recent-item';
        li.dataset.key = doc.key;

        const open = document.createElement('button');
        open.className = 'recent-open';
        open.type = 'button';

        const icon = document.createElement('span');
        icon.className = 'recent-icon';
        icon.textContent = doc.kind === 'url' ? '🔗' : doc.kind === 'file' ? '📄' : '📋';

        const textWrap = document.createElement('span');
        textWrap.className = 'recent-text';
        const name = document.createElement('span');
        name.className = 'recent-name';
        name.textContent = doc.name;
        const meta = document.createElement('span');
        meta.className = 'recent-meta';
        const where = doc.position && doc.position.line > 1 ? ` · ${doc.position.line}行目まで` : '';
        const unavailable = !doc.content && !doc.url ? ' · 内容は保存されていません' : '';
        meta.textContent = this.relativeTime(doc.opened) + where + unavailable;
        textWrap.append(name, meta);

        open.append(icon, textWrap);

        const del = document.createElement('button');
        del.className = 'recent-remove';
        del.type = 'button';
        del.title = '履歴から削除';
        del.setAttribute('aria-label', `${doc.name} を履歴から削除`);
        del.textContent = '×';

        li.append(open, del);
        list.appendChild(li);
      });
    }

    async onRecentClick(e) {
      const li = e.target.closest('.recent-item');
      if (!li) return;
      const key = li.dataset.key;

      if (e.target.closest('.recent-remove')) {
        await MdLibrary.remove(key);
        this.renderRecent();
        return;
      }

      const doc = await MdLibrary.get(key);
      if (!doc) return;
      if (doc.kind === 'url' && doc.url) {
        // URL は最新版を取りに行き、だめなら保存済みの内容を表示
        if (await this.openUrl(doc.displayUrl || doc.url, { silent: true })) return;
      }
      if (doc.content) {
        await this.openDocument(doc.content, { kind: doc.kind, name: doc.name, url: doc.url, displayUrl: doc.displayUrl });
      } else {
        alert('このファイルは大きすぎたため内容が保存されていません。もう一度ファイルを選択してください。');
      }
    }

    relativeTime(ts) {
      const diff = (Date.now() - ts) / 1000;
      if (diff < 60) return 'たった今';
      if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
      if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}日前`;
      return new Date(ts).toLocaleDateString('ja-JP');
    }

    /* ---------------- トースト ---------------- */

    showToast(text, actionLabel, handler) {
      const el = this.el;
      el.toastText.textContent = text;
      el.toastAction.hidden = !actionLabel;
      el.toastAction.textContent = actionLabel || '';
      this.toastHandler = handler || null;
      el.toast.hidden = false;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => this.hideToast(), 6000);
    }

    hideToast() {
      this.el.toast.hidden = true;
      this.toastHandler = null;
    }

    /* ---------------- 描画 ---------------- */

    /**
     * 描画する。
     * options.overrides … { トークン番号: 差し替える Markdown }（翻訳表示に使う）
     * options.keepPosition … 今読んでいる位置を保つ（翻訳の途中経過の再描画など）
     */
    render(markdownText, sourceName, { overrides = null, keepPosition = false } = {}) {
      const keep = keepPosition && !this.el.viewer.hidden ? this.currentPosition() : null;

      const rawHtml = this.renderWithSourceLines(markdownText, overrides);
      const safeHtml = window.DOMPurify
        ? DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target'] })
        : rawHtml;

      this.el.body.innerHTML = safeHtml;
      this.sourceText = markdownText;
      this.sourceName = sourceName;

      this.decorateHeadings();
      if (overrides) this.keepOriginalHeadingIds();
      else this.originalHeadingIds = this.headings.map((h) => h.id);
      this.decorateCodeBlocks();
      this.decorateLinks();
      this.applyLanguage(overrides ? MdTranslate.settings.target : null);
      this.buildToc();
      this.updateStats();
      this.updateTitle(sourceName);

      this.el.upload.hidden = true;
      this.el.viewer.hidden = false;
      this.el.tocFilter.value = '';
      this.applyTocVisibility();
      this.activeId = null;
      if (keep) this.restorePosition(keep);
      else window.scrollTo(0, 0);
      this.onScroll();
      this.search.reset();

      // コードの色分け・数式・図（必要なライブラリを読み込んでから仕上げる）
      const seq = ++this.renderSeq;
      if (window.MdRich) {
        MdRich.enhance(this.el.body, () => seq !== this.renderSeq).then((changed) => {
          if (!changed || seq !== this.renderSeq) return;
          this.search.reset();
          this.onScroll();
        }).catch((e) => console.warn('enhance failed', e));
      }
    }

    /** 翻訳表示でも見出しの ID を原文と同じにする（目次・文書内リンク・位置の復元が崩れないように） */
    keepOriginalHeadingIds() {
      const ids = this.originalHeadingIds || [];
      if (ids.length !== this.headings.length) return;
      this.headings.forEach((h, i) => {
        h.id = ids[i];
        const a = h.querySelector('.heading-anchor');
        if (a) a.href = '#' + encodeURIComponent(ids[i]);
      });
    }

    showUploadArea() {
      this.savePosition();
      this.resetTranslation();
      this.currentDoc = null;
      this.search.close();
      this.hideToast();
      this.renderRecent();
      document.documentElement.lang = 'ja';
      this.closeTocSheet();
      this.setSettingsOpen(false);
      this.el.viewer.hidden = true;
      this.el.upload.hidden = false;
      document.title = 'Markdown Viewer PWA';
      window.scrollTo(0, 0);
    }

    /**
     * Markdown をトップレベルのブロック単位で描画し、各要素に元ファイルの行番号
     * (data-ln) を付ける。行番号は marked のトークンの raw に含まれる改行数から求める。
     */
    renderWithSourceLines(markdownText, overrides = null) {
      const countNL = (str) => (str.match(/\n/g) || []).length;
      const src = markdownText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      const tokens = marked.lexer(src);
      this.lastTokens = tokens;
      const tpl = document.createElement('template');
      const parts = [];
      let line = 1;

      const emit = (token, start, links) => {
        if (token.type === 'space' || token.type === 'def') return;
        const single = [token];
        single.links = links;   // 参照リンク [text][id] を解決するため
        tpl.innerHTML = marked.parser(single);
        this.annotateBlock(tpl.content, token, start, countNL);
        parts.push(tpl.innerHTML);
      };

      tokens.forEach((token, idx) => {
        const start = line;
        line += countNL(token.raw || '');

        if (overrides && overrides[idx] != null) {
          // 訳文：原文の行番号を起点に描画する
          const subTokens = marked.lexer(overrides[idx]);
          const links = Object.assign({}, tokens.links, subTokens.links);
          let sub = start;
          subTokens.forEach((st) => {
            const s0 = sub;
            sub += countNL(st.raw || '');
            emit(st, s0, links);
          });
          return;
        }
        emit(token, start, tokens.links);
      });
      return parts.join('\n');
    }

    annotateBlock(frag, token, start, countNL) {
      const el = frag.firstElementChild;
      if (!el) return;

      switch (token.type) {
        case 'code': {
          const fenced = token.codeBlockStyle !== 'indented';
          if (fenced) el.dataset.fenceLn = start;
          el.dataset.codeStart = fenced ? start + 1 : start;
          break;
        }
        case 'list':
          this.annotateList(el, token, start, countNL);
          break;
        case 'table': {
          const th = el.querySelector('thead th');
          if (th) th.dataset.ln = start;
          el.querySelectorAll('tbody tr').forEach((tr, i) => {
            if (tr.firstElementChild) tr.firstElementChild.dataset.ln = start + 2 + i;
          });
          break;
        }
        default:
          el.dataset.ln = start;
      }
    }

    annotateList(listEl, token, start, countNL) {
      const lis = Array.from(listEl.children).filter((c) => c.tagName === 'LI');
      let line = start;
      token.items.forEach((item, i) => {
        const li = lis[i];
        if (!li) return;
        li.dataset.ln = line;

        // 入れ子のリスト
        const nested = Array.from(li.children).filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
        let sub = line;
        let k = 0;
        (item.tokens || []).forEach((t) => {
          if (t.type === 'list' && nested[k]) this.annotateList(nested[k++], t, sub, countNL);
          sub += countNL(t.raw || '');
        });
        line += countNL(item.raw || '');
      });
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
        pre.setAttribute('translate', 'no');   // コードは自動翻訳させない
        const langClass = Array.from(code.classList).find((c) => c.startsWith('language-'));
        const lang = langClass ? langClass.slice('language-'.length) : '';
        const codeStart = pre.dataset.codeStart ? Number(pre.dataset.codeStart) : null;

        // 各行を <span class="line" data-ln="元の行番号"> で包む
        const text = code.textContent.replace(/\n$/, '');
        const lines = text.split('\n');
        const frag = document.createDocumentFragment();
        lines.forEach((line, i) => {
          const span = document.createElement('span');
          span.className = 'line';
          span.textContent = line + (i < lines.length - 1 ? '\n' : '');
          if (codeStart !== null) span.dataset.ln = codeStart + i;
          frag.appendChild(span);
        });
        code.textContent = '';
        code.appendChild(frag);

        // ヘッダー（```言語 の行。行番号もここに出す）＋コピーボタン
        const wrapper = document.createElement('div');
        wrapper.className = 'code-block';
        if (lang) wrapper.dataset.lang = lang.toLowerCase();
        const header = document.createElement('div');
        header.className = 'code-header';
        if (pre.dataset.fenceLn) header.dataset.ln = pre.dataset.fenceLn;
        const label = document.createElement('span');
        label.className = 'code-lang';
        label.textContent = lang || 'text';
        const actions = document.createElement('span');
        actions.className = 'code-actions';
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'code-action code-copy';
        copy.textContent = 'コピー';
        actions.appendChild(copy);
        header.append(label, actions);
        pre.replaceWith(wrapper);
        wrapper.append(header, pre);
      });
    }

    /**
     * 本文の言語を判定して <html lang> に設定する。
     * 英語の文書なのに lang="ja" のままだと、Chrome が翻訳を提案しないため。
     */
    applyLanguage(forced = null) {
      if (forced) {
        document.documentElement.lang = forced;
        this.el.body.setAttribute('lang', forced);
        this.el.body.querySelectorAll('code').forEach((c) => c.setAttribute('translate', 'no'));
        return;
      }
      const text = (this.el.body.textContent || '').slice(0, 20000);
      const kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
      const cjk = (text.match(CJK_RE) || []).length;
      const latin = (text.match(/[A-Za-z]/g) || []).length;
      let lang = 'en';
      if (kana > 20 || (cjk > 0 && kana / Math.max(1, cjk) > 0.1 && cjk / Math.max(1, cjk + latin / 4) > 0.15)) lang = 'ja';
      else if (cjk / Math.max(1, cjk + latin / 4) > 0.3) lang = 'zh';
      document.documentElement.lang = lang;
      this.el.body.setAttribute('lang', lang);

      // インラインコードも翻訳させない
      this.el.body.querySelectorAll('code').forEach((c) => c.setAttribute('translate', 'no'));
    }

    decorateLinks() {
      // URL から開いた文書は、相対パスの画像・リンクを元の場所基準で解決する
      if (this.baseUrl) {
        this.el.body.querySelectorAll('img[src]').forEach((img) => {
          const src = img.getAttribute('src');
          if (src && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) {
            try { img.src = new URL(src, this.baseUrl).href; } catch (e) { /* noop */ }
          }
        });
        this.el.body.querySelectorAll('a[href]').forEach((a) => {
          const href = a.getAttribute('href');
          if (href && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) {
            try { a.href = new URL(href, this.baseUrl).href; } catch (e) { /* noop */ }
          }
        });
      }

      this.el.body.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href');
        // 別の .md へのリンクはこのビューアで開く
        if (/^https?:\/\//i.test(href) && /\.(md|markdown|mdown|mkd)(?:[?#].*)?$/i.test(new URL(href).pathname + new URL(href).search)) {
          a.dataset.mdLink = href;
          a.title = 'このビューアで開く';
          return;
        }
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
