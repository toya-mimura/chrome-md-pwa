class MarkdownViewerPWA {
  constructor() {
    this.currentTheme = localStorage.getItem('theme') || 'system';
    this.tocVisible = localStorage.getItem('tocVisible') !== 'false';
    this.deferredPrompt = null;
    
    this.init();
  }
  
  init() {
    this.setupEventListeners();
    this.applyTheme(this.currentTheme);
    this.registerServiceWorker();
    this.setupPWAInstallPrompt();
  }
  
  setupEventListeners() {
    const fileInput = document.getElementById('file-input');
    const fileButton = document.getElementById('file-button');
    const pasteButton = document.getElementById('paste-button');
    const sampleButton = document.getElementById('sample-button');
    const dragDropArea = document.getElementById('drag-drop-area');
    const newFileButton = document.getElementById('new-file-button');
    const navbarToggle = document.getElementById('navbar-toggle');
    const navbarMenu = document.getElementById('navbar-menu');
    
    fileButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
    pasteButton.addEventListener('click', () => this.handlePaste());
    sampleButton.addEventListener('click', () => this.loadSampleContent());
    newFileButton.addEventListener('click', () => this.showUploadArea());
    
    if (navbarToggle && navbarMenu) {
      navbarToggle.addEventListener('click', () => this.toggleNavbarMenu());
      
      document.addEventListener('click', (e) => {
        if (!navbarToggle.contains(e.target) && !navbarMenu.contains(e.target)) {
          this.closeNavbarMenu();
        }
      });
    }
    
    dragDropArea.addEventListener('dragover', (e) => this.handleDragOver(e));
    dragDropArea.addEventListener('dragleave', (e) => this.handleDragLeave(e));
    dragDropArea.addEventListener('drop', (e) => this.handleDrop(e));
    
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());
  }
  
  handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
      this.readFile(file);
    }
  }
  
  async handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        this.renderMarkdown(text);
      } else {
        alert('クリップボードにテキストが見つかりません');
      }
    } catch (err) {
      alert('クリップボードの読み取りに失敗しました。ブラウザの設定を確認してください。');
    }
  }
  
  loadSampleContent() {
    fetch('test-markdown.md')
      .then(response => response.text())
      .then(text => this.renderMarkdown(text))
      .catch(() => {
        const sampleMarkdown = `# Markdown Viewer PWA

## 概要

このPWAはMarkdownファイルを美しく表示するためのアプリケーションです。

### 主な機能

- 📋 **目次の自動生成**: 見出しから目次を自動作成
- 🔗 **クリックナビゲーション**: 目次をクリックして該当箇所にジャンプ
- 📊 **読書進捗表示**: スクロール位置に応じた進捗バー
- 🎨 **テーマ切り替え**: ライト・ダーク・システムテーマ
- 📱 **モバイル対応**: スマートフォンでも快適に閲覧

### 使用方法

1. **ファイル選択**: 📁ボタンでMarkdownファイルを選択
2. **ドラッグ&ドロップ**: ファイルを直接ドロップ
3. **クリップボード**: コピーしたテキストを貼り付け

## コード例

\`\`\`javascript
function example() {
    console.log("Hello, Markdown!");
}
\`\`\`

## 表の例

| 機能 | 対応状況 |
|------|----------|
| 目次生成 | ✅ |
| テーマ切り替え | ✅ |
| モバイル対応 | ✅ |

## まとめ

このPWAを使って、どこでもMarkdownを快適に閲覧できます！`;
        
        this.renderMarkdown(sampleMarkdown);
      });
  }
  
  handleDragOver(event) {
    event.preventDefault();
    event.currentTarget.classList.add('drag-over');
  }
  
  handleDragLeave(event) {
    event.preventDefault();
    event.currentTarget.classList.remove('drag-over');
  }
  
  handleDrop(event) {
    event.preventDefault();
    event.currentTarget.classList.remove('drag-over');
    
    const files = event.dataTransfer.files;
    if (files.length > 0) {
      this.readFile(files[0]);
    }
  }
  
  readFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      this.renderMarkdown(e.target.result);
    };
    reader.readAsText(file);
  }
  
  renderMarkdown(markdownText) {
    document.getElementById('upload-area').style.display = 'none';
    document.getElementById('markdown-viewer').style.display = 'block';
    
    const renderedHtml = marked.parse(markdownText);
    document.querySelector('.markdown-body').innerHTML = renderedHtml;
    
    this.addHeadingIds();
    this.generateTableOfContents();
    this.calculateReadingStats();
    this.setupMarkdownEventListeners();
    this.initScrollSpy();
    this.applyTheme(this.currentTheme);
    
    document.title = 'Markdown Viewer PWA';
  }
  
  showUploadArea() {
    document.getElementById('upload-area').style.display = 'flex';
    document.getElementById('markdown-viewer').style.display = 'none';
    document.title = 'Markdown Viewer PWA';
  }
  
  addHeadingIds() {
    const headings = document.querySelectorAll('.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6');
    const usedIds = new Set();
    
    headings.forEach(heading => {
      let id = this.createSlug(heading.textContent);
      let counter = 1;
      let originalId = id;
      
      while (usedIds.has(id)) {
        id = `${originalId}-${counter}`;
        counter++;
      }
      
      usedIds.add(id);
      heading.id = id;
    });
  }
  
  createSlug(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  
  generateTableOfContents() {
    const headings = document.querySelectorAll('.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6');
    const tocList = document.getElementById('toc-list');
    
    if (headings.length === 0) {
      tocList.innerHTML = '<div class="toc-empty">見出しが見つかりません</div>';
      return;
    }
    
    let tocHtml = '';
    headings.forEach(heading => {
      const level = parseInt(heading.tagName.charAt(1));
      const text = heading.textContent;
      const id = heading.id;
      
      tocHtml += `
        <div class="toc-item level-${level}">
          <a href="#${id}" class="toc-link" data-target="${id}">${text}</a>
        </div>
      `;
    });
    
    tocList.innerHTML = tocHtml;
  }
  
  calculateReadingStats() {
    const text = document.querySelector('.markdown-body').textContent;
    const words = text.trim().split(/\s+/).length;
    const readingTime = Math.ceil(words / 200);
    
    document.getElementById('reading-stats').textContent = `${words.toLocaleString()}語 • 約${readingTime}分`;
  }
  
  setupMarkdownEventListeners() {
    const themeSelector = document.getElementById('theme-selector');
    const tocToggle = document.getElementById('toc-toggle');
    const tocList = document.getElementById('toc-list');
    const backToTop = document.getElementById('back-to-top');
    
    themeSelector.value = this.currentTheme;
    themeSelector.addEventListener('change', (e) => {
      this.currentTheme = e.target.value;
      localStorage.setItem('theme', this.currentTheme);
      this.applyTheme(this.currentTheme);
    });
    
    tocToggle.addEventListener('click', () => {
      const tocPanel = document.getElementById('toc-panel');
      const isHidden = tocPanel.classList.contains('hidden');
      
      if (isHidden) {
        tocPanel.classList.remove('hidden');
        this.tocVisible = true;
      } else {
        tocPanel.classList.add('hidden');
        this.tocVisible = false;
      }
      
      localStorage.setItem('tocVisible', this.tocVisible);
    });
    
    if (!this.tocVisible) {
      document.getElementById('toc-panel').classList.add('hidden');
    }
    
    tocList.addEventListener('click', (e) => {
      if (e.target.classList.contains('toc-link')) {
        e.preventDefault();
        const targetId = e.target.getAttribute('data-target');
        const targetElement = document.getElementById(targetId);
        
        if (targetElement) {
          targetElement.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
          });
          
          history.pushState(null, null, `#${targetId}`);
        }
      }
    });
    
    backToTop.addEventListener('click', () => {
      window.scrollTo({
        top: 0,
        behavior: 'smooth'
      });
    });
    
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          this.updateReadingProgress();
          this.updateBackToTopButton();
          ticking = false;
        });
        ticking = true;
      }
    });
  }
  
  initScrollSpy() {
    const headings = document.querySelectorAll('.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6');
    const tocLinks = document.querySelectorAll('.toc-link');
    
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          
          tocLinks.forEach(link => link.classList.remove('active'));
          
          const activeLink = document.querySelector(`.toc-link[data-target="${id}"]`);
          if (activeLink) {
            activeLink.classList.add('active');
          }
        }
      });
    }, {
      rootMargin: '-20% 0px -70% 0px'
    });
    
    headings.forEach(heading => {
      observer.observe(heading);
    });
  }
  
  updateReadingProgress() {
    const scrollTop = window.pageYOffset;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const scrollPercent = (scrollTop / docHeight) * 100;
    
    document.querySelector('.reading-progress-bar').style.width = `${Math.min(scrollPercent, 100)}%`;
  }
  
  updateBackToTopButton() {
    const backToTopButton = document.getElementById('back-to-top');
    if (window.pageYOffset > 300) {
      backToTopButton.classList.add('visible');
    } else {
      backToTopButton.classList.remove('visible');
    }
  }
  
  applyTheme(theme) {
    document.body.className = '';
    
    if (theme === 'light') {
      document.body.classList.add('theme-light');
    } else if (theme === 'dark') {
      document.body.classList.add('theme-dark');
    } else {
      document.body.classList.add('theme-system');
    }
  }
  
  async registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('sw.js');
        console.log('Service Worker registered successfully');
      } catch (error) {
        console.log('Service Worker registration failed:', error);
      }
    }
  }
  
  setupPWAInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      this.showInstallPrompt();
    });
    
    const installButton = document.getElementById('install-button');
    const dismissButton = document.getElementById('dismiss-button');
    
    installButton.addEventListener('click', async () => {
      if (this.deferredPrompt) {
        this.deferredPrompt.prompt();
        const { outcome } = await this.deferredPrompt.userChoice;
        
        if (outcome === 'accepted') {
          console.log('PWA installed');
        }
        
        this.deferredPrompt = null;
        this.hideInstallPrompt();
      }
    });
    
    dismissButton.addEventListener('click', () => {
      this.hideInstallPrompt();
      localStorage.setItem('installPromptDismissed', 'true');
    });
  }
  
  showInstallPrompt() {
    const dismissed = localStorage.getItem('installPromptDismissed');
    if (!dismissed) {
      document.getElementById('install-prompt').style.display = 'block';
    }
  }
  
  hideInstallPrompt() {
    document.getElementById('install-prompt').style.display = 'none';
  }
  
  toggleNavbarMenu() {
    const navbarToggle = document.getElementById('navbar-toggle');
    const navbarMenu = document.getElementById('navbar-menu');
    
    if (navbarToggle && navbarMenu) {
      const isActive = navbarMenu.classList.contains('active');
      
      if (isActive) {
        navbarMenu.classList.remove('active');
        navbarToggle.classList.remove('active');
      } else {
        navbarMenu.classList.add('active');
        navbarToggle.classList.add('active');
      }
    }
  }
  
  closeNavbarMenu() {
    const navbarToggle = document.getElementById('navbar-toggle');
    const navbarMenu = document.getElementById('navbar-menu');
    
    if (navbarToggle && navbarMenu) {
      navbarMenu.classList.remove('active');
      navbarToggle.classList.remove('active');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new MarkdownViewerPWA();
});
