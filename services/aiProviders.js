// services/aiProviders.js
//
// Unified Gemini/OpenAI/OpenRouter/DeepSeek/Groq fallback chain, ported
// from content.js's generateReplyWithFallback + callGemini/callOpenAI/
// callOpenRouter/callDeepSeek/callGroq. Fallback ORDER is kept identical
// per the migration constraints: DeepSeek -> Groq -> Gemini 2.0 Flash ->
// (smartSwitch) Gemini 1.5 Flash -> Gemini 1.5 Flash-8B -> OpenAI ->
// OpenRouter (free model cascade).
//
// The only behavioral difference from the old client-side version: API
// keys now come from a server-side Firebase lookup (services/firebase.js)
// instead of chrome.storage.local, and this never runs in a browser.

const { buildPrompt, filterAlphaReply, repBuildPrompt, feedBuildPrompt } = require('./promptBuilder');

async function callGemini(tweetText, tone, style, apiKey, model, useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords) {
  const prompt = buildPrompt(tweetText, tone, style, useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords);
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.95, maxOutputTokens: 120 }
      })
    }
  );
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err?.error?.message || 'API Error';
    if (msg.includes('API_KEY_INVALID')) throw new Error('Invalid Gemini API key!');
    if (msg.includes('QUOTA') || msg.includes('429') || resp.status === 429) throw new Error('Quota exceeded');
    throw new Error(msg);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response');
  return filterAlphaReply(text.trim().replace(/^["']|["']$/g, ''), tone);
}

async function callOpenAI(tweetText, tone, style, apiKey, useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords) {
  const prompt = buildPrompt(tweetText, tone, style, useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords);
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 120, temperature: 0.95
    })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${resp.status}`;
    if (resp.status === 401) throw new Error('Invalid OpenAI key');
    if (resp.status === 429) throw new Error('OpenAI rate limit / quota exceeded');
    throw new Error(msg);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response');
  return filterAlphaReply(text.trim().replace(/^["']|["']$/g, ''), tone);
}

async function callOpenRouter(tweetText, tone, style, apiKey, model, useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords) {
  const prompt = buildPrompt(tweetText, tone, style, useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords);
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://x.com',
      'X-Title': 'Z EX'
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 120, temperature: 0.95
    })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${resp.status}`;
    if (resp.status === 401) throw new Error('Invalid OpenRouter key');
    if (resp.status === 429) throw new Error('Rate limit');
    throw new Error(msg);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response');
  return filterAlphaReply(text.trim().replace(/^["']|["']$/g, ''), tone);
}

async function callDeepSeek(tweetText, tone, style, apiKey, useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords) {
  const prompt = buildPrompt(tweetText, tone, style, useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords);
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: 120, temperature: 0.95 })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    if (resp.status === 401) throw new Error('Invalid DeepSeek key');
    if (resp.status === 429) throw new Error('Rate limit');
    throw new Error(err?.error?.message || `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response');
  return filterAlphaReply(text.trim().replace(/^["']|["']$/g, ''), tone);
}

async function callGroq(tweetText, tone, style, apiKey, useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords) {
  const prompt = buildPrompt(tweetText, tone, style, useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords);
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], max_tokens: 120, temperature: 0.95 })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    if (resp.status === 401) throw new Error('Invalid Groq key');
    if (resp.status === 429) throw new Error('Rate limit');
    throw new Error(err?.error?.message || `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response');
  return filterAlphaReply(text.trim().replace(/^["']|["']$/g, ''), tone);
}

// ─── Smart Fallback System (verbatim order from content.js) ──────────
async function generateReplyWithFallback(opts) {
  const {
    tweetText, tone, style,
    geminiKey, openrouterKey, openaiKey, deepseekKey, groqKey,
    smartSwitch, useGrammar, useProjectName, prevReplies, bigReplyWords,
    customPrompt, customWords,
    onStep,
  } = opts;

  const step = typeof onStep === 'function' ? onStep : () => {};
  const errors = [];

  step('SCANNING TWEET CONTEXT');

  // DeepSeek — try first if key present (fast & cheap)
  if (deepseekKey) {
    step('QUERYING → DEEPSEEK');
    try {
      const r = await callDeepSeek(tweetText, tone, style, deepseekKey, useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords);
      step('DEEPSEEK OK ✓');
      return r;
    } catch (e) { step('DEEPSEEK NODE DOWN ✗'); errors.push('DeepSeek: ' + e.message); }
  }

  // Groq — very fast
  if (groqKey) {
    step('QUERYING → GROQ');
    try {
      const r = await callGroq(tweetText, tone, style, groqKey, useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords);
      step('GROQ OK ✓');
      return r;
    } catch (e) { step('GROQ NODE DOWN ✗'); errors.push('Groq: ' + e.message); }
  }

  if (geminiKey) {
    step('QUERYING → GEMINI 2.0 FLASH');
    try {
      const r = await callGemini(tweetText, tone, style, geminiKey, 'gemini-2.0-flash', useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords);
      step('GEMINI 2.0 OK ✓');
      return r;
    } catch (e) {
      step('GEMINI 2.0 DOWN ✗');
      errors.push('Gemini 2.0 Flash: ' + e.message);
      if (smartSwitch) {
        step('AUTO-SWITCH → GEMINI 1.5 FLASH');
        try {
          const r2 = await callGemini(tweetText, tone, style, geminiKey, 'gemini-1.5-flash', useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords);
          step('GEMINI 1.5 OK ✓');
          return r2;
        } catch (e2) { step('GEMINI 1.5 DOWN ✗'); errors.push('Gemini 1.5 Flash: ' + e2.message); }
        step('AUTO-SWITCH → GEMINI 1.5 FLASH-8B');
        try {
          const r3 = await callGemini(tweetText, tone, style, geminiKey, 'gemini-1.5-flash-8b', useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords);
          step('GEMINI 1.5-8B OK ✓');
          return r3;
        } catch (e3) { step('GEMINI 1.5-8B DOWN ✗'); errors.push('Gemini 1.5 Flash-8B: ' + e3.message); }
      }
    }
  }

  if (openaiKey) {
    step('QUERYING → OPENAI GPT');
    try {
      const r = await callOpenAI(tweetText, tone, style, openaiKey, useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords);
      step('OPENAI OK ✓');
      return r;
    } catch (e) { step('OPENAI NODE DOWN ✗'); errors.push('OpenAI: ' + e.message); }
  }

  if (openrouterKey) {
    const freeModels = [
      'meta-llama/llama-3.1-8b-instruct:free',
      'mistralai/mistral-7b-instruct:free',
      'google/gemma-2-9b-it:free',
      'qwen/qwen-2-7b-instruct:free'
    ];
    for (const model of freeModels) {
      const shortName = model.split('/')[1].split(':')[0].toUpperCase();
      step('QUERYING → OPENROUTER: ' + shortName);
      try {
        const r = await callOpenRouter(tweetText, tone, style, openrouterKey, model, useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords);
        step('OPENROUTER OK ✓');
        return r;
      } catch (e) {
        step(shortName + ' NODE DOWN ✗');
        errors.push('OpenRouter ' + model + ': ' + e.message);
        if (!smartSwitch) break;
      }
    }
  }

  step('ALL NODES UNREACHABLE ✗');
  throw new Error('All APIs failed. Details: ' + errors.slice(-2).join(' | '));
      }
// ─── Quick-mode fallback chains (REP one-click + FED "Model 1") ──────
// Ported verbatim from content.js's repGenerateReplyWithFallback /
// feedGenerateReplyWithFallback + their repCall*/feedCall* provider
// functions. Same fallback ORDER as the main chain (DeepSeek -> Groq ->
// Gemini 2.0 -> smartSwitch Gemini 1.5/1.5-8B -> OpenAI -> OpenRouter
// free-model cascade), but with the shorter/simpler prompt, lower
// max_tokens (60 vs 120), and slightly lower temperature (0.9 vs 0.95)
// these two engines have always used, and no filterAlphaReply (neither
// engine has tone/Alpha-mode).

async function repCallGemini(postText, commentText, apiKey, model) {
  const prompt = repBuildPrompt(postText, commentText);
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, maxOutputTokens: 60 } })
    }
  );
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err?.error?.message || 'API Error';
    if (msg.includes('API_KEY_INVALID')) throw new Error('Invalid Gemini API key!');
    if (msg.includes('QUOTA') || msg.includes('429') || resp.status === 429) throw new Error('Quota exceeded');
    throw new Error(msg);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response');
  return text.trim().replace(/^["']|["']$/g, '');
}

async function repCallOpenAI(postText, commentText, apiKey) {
  const prompt = repBuildPrompt(postText, commentText);
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 60, temperature: 0.9 })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${resp.status}`;
    if (resp.status === 401) throw new Error('Invalid OpenAI key');
    if (resp.status === 429) throw new Error('OpenAI rate limit / quota exceeded');
    throw new Error(msg);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response');
  return text.trim().replace(/^["']|["']$/g, '');
}

async function repCallOpenRouter(postText, commentText, apiKey, model) {
  const prompt = repBuildPrompt(postText, commentText);
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://x.com',
      'X-Title': 'Z EX'
    },
    body: JSON.stringify({ model: model, messages: [{ role: 'user', content: prompt }], max_tokens: 60, temperature: 0.9 })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${resp.status}`;
    if (resp.status === 401) throw new Error('Invalid OpenRouter key');
    if (resp.status === 429) throw new Error('Rate limit');
    throw new Error(msg);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response');
  return text.trim().replace(/^["']|["']$/g, '');
}

async function repCallDeepSeek(postText, commentText, apiKey) {
  const prompt = repBuildPrompt(postText, commentText);
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: 60, temperature: 0.9 })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    if (resp.status === 401) throw new Error('Invalid DeepSeek key');
    if (resp.status === 429) throw new Error('Rate limit');
    throw new Error(err?.error?.message || `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response');
  return text.trim().replace(/^["']|["']$/g, '');
}

async function repCallGroq(postText, commentText, apiKey) {
  const prompt = repBuildPrompt(postText, commentText);
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], max_tokens: 60, temperature: 0.9 })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    if (resp.status === 401) throw new Error('Invalid Groq key');
    if (resp.status === 429) throw new Error('Rate limit');
    throw new Error(err?.error?.message || `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response');
  return text.trim().replace(/^["']|["']$/g, '');
}

async function generateRepReplyWithFallback(opts) {
  const {
    postText, commentText,
    geminiKey, openrouterKey, openaiKey, deepseekKey, groqKey,
    smartSwitch,
    onStep,
  } = opts;

  const step = typeof onStep === 'function' ? onStep : () => {};
  const errors = [];

  if (deepseekKey) {
    step('QUERYING → DEEPSEEK');
    try { const r = await repCallDeepSeek(postText, commentText, deepseekKey); step('DEEPSEEK OK ✓'); return r; }
    catch (e) { step('DEEPSEEK NODE DOWN ✗'); errors.push('DeepSeek: ' + e.message); }
  }
  if (groqKey) {
    step('QUERYING → GROQ');
    try { const r = await repCallGroq(postText, commentText, groqKey); step('GROQ OK ✓'); return r; }
    catch (e) { step('GROQ NODE DOWN ✗'); errors.push('Groq: ' + e.message); }
  }
  if (geminiKey) {
    step('QUERYING → GEMINI 2.0 FLASH');
    try {
      const r = await repCallGemini(postText, commentText, geminiKey, 'gemini-2.0-flash');
      step('GEMINI 2.0 OK ✓');
      return r;
    } catch (e) {
      step('GEMINI 2.0 DOWN ✗');
      errors.push('Gemini 2.0 Flash: ' + e.message);
      if (smartSwitch) {
        try { const r2 = await repCallGemini(postText, commentText, geminiKey, 'gemini-1.5-flash'); step('GEMINI 1.5 OK ✓'); return r2; }
        catch (e2) { step('GEMINI 1.5 DOWN ✗'); errors.push('Gemini 1.5 Flash: ' + e2.message); }
        try { const r3 = await repCallGemini(postText, commentText, geminiKey, 'gemini-1.5-flash-8b'); step('GEMINI 1.5-8B OK ✓'); return r3; }
        catch (e3) { step('GEMINI 1.5-8B DOWN ✗'); errors.push('Gemini 1.5 Flash-8B: ' + e3.message); }
      }
    }
  }
  if (openaiKey) {
    step('QUERYING → OPENAI GPT');
    try { const r = await repCallOpenAI(postText, commentText, openaiKey); step('OPENAI OK ✓'); return r; }
    catch (e) { step('OPENAI NODE DOWN ✗'); errors.push('OpenAI: ' + e.message); }
  }
  if (openrouterKey) {
    const freeModels = [
      'meta-llama/llama-3.1-8b-instruct:free',
      'mistralai/mistral-7b-instruct:free',
      'google/gemma-2-9b-it:free',
      'qwen/qwen-2-7b-instruct:free'
    ];
    for (const model of freeModels) {
      const shortName = model.split('/')[1].split(':')[0].toUpperCase();
      step('QUERYING → OPENROUTER: ' + shortName);
      try { const r = await repCallOpenRouter(postText, commentText, openrouterKey, model); step('OPENROUTER OK ✓'); return r; }
      catch (e) { step(shortName + ' NODE DOWN ✗'); errors.push('OpenRouter ' + model + ': ' + e.message); if (!smartSwitch) break; }
    }
  }

  step('ALL NODES UNREACHABLE ✗');
  throw new Error('All APIs failed. Details: ' + errors.slice(-2).join(' | '));
}

async function feedCallGemini(postText, apiKey, model) {
  const prompt = feedBuildPrompt(postText);
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, maxOutputTokens: 60 } })
    }
  );
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err?.error?.message || 'API Error';
    if (msg.includes('API_KEY_INVALID')) throw new Error('Invalid Gemini API key!');
    if (msg.includes('QUOTA') || msg.includes('429') || resp.status === 429) throw new Error('Quota exceeded');
    throw new Error(msg);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response');
  return text.trim().replace(/^["']|["']$/g, '');
}

async function feedCallOpenAI(postText, apiKey) {
  const prompt = feedBuildPrompt(postText);
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 60, temperature: 0.9 })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${resp.status}`;
    if (resp.status === 401) throw new Error('Invalid OpenAI key');
    if (resp.status === 429) throw new Error('OpenAI rate limit / quota exceeded');
    throw new Error(msg);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response');
  return text.trim().replace(/^["']|["']$/g, '');
}

async function feedCallOpenRouter(postText, apiKey, model) {
  const prompt = feedBuildPrompt(postText);
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://x.com',
      'X-Title': 'Z EX'
    },
    body: JSON.stringify({ model: model, messages: [{ role: 'user', content: prompt }], max_tokens: 60, temperature: 0.9 })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${resp.status}`;
    if (resp.status === 401) throw new Error('Invalid OpenRouter key');
    if (resp.status === 429) throw new Error('Rate limit');
    throw new Error(msg);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response');
  return text.trim().replace(/^["']|["']$/g, '');
}

async function feedCallDeepSeek(postText, apiKey) {
  const prompt = feedBuildPrompt(postText);
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: 60, temperature: 0.9 })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    if (resp.status === 401) throw new Error('Invalid DeepSeek key');
    if (resp.status === 429) throw new Error('Rate limit');
    throw new Error(err?.error?.message || `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response');
  return text.trim().replace(/^["']|["']$/g, '');
}

async function feedCallGroq(postText, apiKey) {
  const prompt = feedBuildPrompt(postText);
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], max_tokens: 60, temperature: 0.9 })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    if (resp.status === 401) throw new Error('Invalid Groq key');
    if (resp.status === 429) throw new Error('Rate limit');
    throw new Error(err?.error?.message || `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response');
  return text.trim().replace(/^["']|["']$/g, '');
}

async function generateFeedReplyWithFallback(opts) {
  const {
    postText,
    geminiKey, openrouterKey, openaiKey, deepseekKey, groqKey,
    smartSwitch,
    onStep,
  } = opts;

  const step = typeof onStep === 'function' ? onStep : () => {};
  const errors = [];

  if (deepseekKey) {
    step('QUERYING → DEEPSEEK');
    try { const r = await feedCallDeepSeek(postText, deepseekKey); step('DEEPSEEK OK ✓'); return r; }
    catch (e) { step('DEEPSEEK NODE DOWN ✗'); errors.push('DeepSeek: ' + e.message); }
  }
  if (groqKey) {
    step('QUERYING → GROQ');
    try { const r = await feedCallGroq(postText, groqKey); step('GROQ OK ✓'); return r; }
    catch (e) { step('GROQ NODE DOWN ✗'); errors.push('Groq: ' + e.message); }
  }
  if (geminiKey) {
    step('QUERYING → GEMINI 2.0 FLASH');
    try {
      const r = await feedCallGemini(postText, geminiKey, 'gemini-2.0-flash');
      step('GEMINI 2.0 OK ✓');
      return r;
    } catch (e) {
      step('GEMINI 2.0 DOWN ✗');
      errors.push('Gemini 2.0 Flash: ' + e.message);
      if (smartSwitch) {
        try { const r2 = await feedCallGemini(postText, geminiKey, 'gemini-1.5-flash'); step('GEMINI 1.5 OK ✓'); return r2; }
        catch (e2) { step('GEMINI 1.5 DOWN ✗'); errors.push('Gemini 1.5 Flash: ' + e2.message); }
        try { const r3 = await feedCallGemini(postText, geminiKey, 'gemini-1.5-flash-8b'); step('GEMINI 1.5-8B OK ✓'); return r3; }
        catch (e3) { step('GEMINI 1.5-8B DOWN ✗'); errors.push('Gemini 1.5 Flash-8B: ' + e3.message); }
      }
    }
  }
  if (openaiKey) {
    step('QUERYING → OPENAI GPT');
    try { const r = await feedCallOpenAI(postText, openaiKey); step('OPENAI OK ✓'); return r; }
    catch (e) { step('OPENAI NODE DOWN ✗'); errors.push('OpenAI: ' + e.message); }
  }
  if (openrouterKey) {
    const freeModels = [
      'meta-llama/llama-3.1-8b-instruct:free',
      'mistralai/mistral-7b-instruct:free',
      'google/gemma-2-9b-it:free',
      'qwen/qwen-2-7b-instruct:free'
    ];
    for (const model of freeModels) {
      const shortName = model.split('/')[1].split(':')[0].toUpperCase();
      step('QUERYING → OPENROUTER: ' + shortName);
      try { const r = await feedCallOpenRouter(postText, openrouterKey, model); step('OPENROUTER OK ✓'); return r; }
      catch (e) { step(shortName + ' NODE DOWN ✗'); errors.push('OpenRouter ' + model + ': ' + e.message); if (!smartSwitch) break; }
    }
  }

  step('ALL NODES UNREACHABLE ✗');
  throw new Error('All APIs failed. Details: ' + errors.slice(-2).join(' | '));
}

module.exports = {
  generateReplyWithFallback,
  generateRepReplyWithFallback,
  generateFeedReplyWithFallback,
};
