/* =========================================================
   Gemini による翻訳
   - API キーはこの端末のブラウザ（localStorage）にだけ保存し、
     Google の Gemini API 以外には送信しない
   - Markdown をブロック単位の JSON 配列で送り、同じ長さの配列で受け取る
     → 見出し・リスト・表・リンクなどの書式を保ったまま訳せる
   ========================================================= */
(() => {
  'use strict';

  const API = 'https://generativelanguage.googleapis.com/v1beta';
  const DEFAULT_MODEL = 'gemini-flash-latest';
  const CHUNK_CHARS = 3500;
  const CHUNK_ITEMS = 40;

  // 訳さないブロック
  const SKIP_TYPES = new Set(['space', 'code', 'html', 'hr', 'def', 'mathBlock']);

  const LANGS = {
    ja: '日本語 (Japanese)',
    en: 'English',
    'zh-CN': '简体中文 (Simplified Chinese)',
    ko: '한국어 (Korean)'
  };

  const settings = {
    get key() { try { return localStorage.getItem('geminiKey') || ''; } catch (e) { return ''; } },
    set key(v) { try { v ? localStorage.setItem('geminiKey', v) : localStorage.removeItem('geminiKey'); } catch (e) { /* noop */ } },
    get model() { try { return localStorage.getItem('geminiModel') || DEFAULT_MODEL; } catch (e) { return DEFAULT_MODEL; } },
    set model(v) { try { localStorage.setItem('geminiModel', v || DEFAULT_MODEL); } catch (e) { /* noop */ } },
    get target() { try { return localStorage.getItem('translateTarget') || 'ja'; } catch (e) { return 'ja'; } },
    set target(v) { try { localStorage.setItem('translateTarget', v); } catch (e) { /* noop */ } }
  };

  function systemPrompt(target) {
    return [
      `You are a professional translator. Translate Markdown fragments into ${LANGS[target] || target}.`,
      'Input: a JSON array of strings, each a Markdown fragment from one document, in order.',
      'Output: a JSON array of strings with EXACTLY the same length and order.',
      'Rules:',
      '- Preserve all Markdown syntax: heading markers (#), list markers and their indentation, task boxes ([ ] / [x]), blockquote markers (>), table pipes and alignment rows, emphasis, line breaks.',
      '- Keep inline code (`...`), math ($...$), URLs, link targets, image paths, HTML tags, file paths and identifiers unchanged. Translate link text and image alt text.',
      '- Keep GitHub alert markers like [!NOTE] unchanged.',
      '- Keep the same number of lines in each fragment whenever possible.',
      '- If a fragment is already in the target language, return it unchanged.',
      '- Use natural, fluent wording for technical documentation. Do not add explanations or notes.'
    ].join('\n');
  }

  async function callGemini(items, target, signal) {
    const key = settings.key;
    if (!key) throw new Error('NO_KEY');
    const res = await fetch(`${API}/models/${encodeURIComponent(settings.model)}:generateContent`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt(target) }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(items) }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: { type: 'ARRAY', items: { type: 'STRING' } }
        }
      })
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const err = await res.json();
        if (err && err.error && err.error.message) msg += ': ' + err.error.message;
      } catch (e) { /* noop */ }
      const e = new Error(msg);
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    const cand = data.candidates && data.candidates[0];
    const text = cand && cand.content && cand.content.parts
      ? cand.content.parts.filter((p) => !p.thought).map((p) => p.text || '').join('')
      : '';
    let out;
    try { out = JSON.parse(text); } catch (e) { throw new Error('翻訳結果を読み取れませんでした'); }
    if (!Array.isArray(out)) throw new Error('翻訳結果の形式が正しくありません');
    return out;
  }

  /** 利用できるモデルの一覧（テキスト生成できる Gemini のみ） */
  async function listModels(key) {
    const res = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /^gemini/.test(n) && !/(image|tts|audio|live|embedding|computer|robotics|veo|lyria)/.test(n))
      .sort();
  }

  /**
   * トップレベルのトークン列を翻訳する。
   * onProgress(results, done, total) が各チャンク完了ごとに呼ばれる。
   * results は { [トークン番号]: 訳文 }
   */
  async function translateTokens(tokens, target, { signal, onProgress, cached = {} } = {}) {
    const results = { ...cached };
    const todo = [];
    tokens.forEach((t, i) => {
      if (SKIP_TYPES.has(t.type)) return;
      if (!t.raw || !t.raw.trim()) return;
      if (results[i] != null) return;
      todo.push({ i, raw: t.raw.replace(/\n+$/, '') });
    });

    const chunks = [];
    let cur = [];
    let size = 0;
    todo.forEach((item) => {
      if (cur.length && (size + item.raw.length > CHUNK_CHARS || cur.length >= CHUNK_ITEMS)) {
        chunks.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(item);
      size += item.raw.length;
    });
    if (cur.length) chunks.push(cur);

    onProgress && onProgress(results, 0, chunks.length);
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];
      const out = await callGemini(chunk.map((x) => x.raw), target, signal);
      chunk.forEach((item, k) => {
        if (typeof out[k] === 'string' && out[k].trim()) results[item.i] = out[k];
      });
      onProgress && onProgress(results, c + 1, chunks.length);
    }
    return results;
  }

  window.MdTranslate = { settings, translateTokens, listModels, LANGS, DEFAULT_MODEL, SKIP_TYPES };
})();
