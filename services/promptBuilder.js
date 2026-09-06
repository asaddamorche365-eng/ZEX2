// services/promptBuilder.js
//
// Ported VERBATIM from the extension's content.js `buildPrompt()` and
// `extractProjectNameHint`/`simplifyProjectName` helpers, and the
// `filterAlphaReply` post-processor. Do not "improve" the wording here —
// the whole point of this migration is that reply text/quality does not
// shift. If tone copy ever needs to change, change it in exactly one
// place (here) and it applies to every engine (Comment REP / FED /
// Search / Session Auto Mode) since they now all call this same server
// endpoint instead of each carrying their own copy.

// ─── Extract clean project name from tweet (verbatim from content.js) ───
function extractProjectNameHint(tweetText) {
  const handle = tweetText.match(/@([A-Za-z0-9_]+)/);
  const token = tweetText.match(/\$([A-Za-z0-9]+)/);
  let raw = null;
  if (handle) {
    raw = handle[1].replace(/[_\-](io|xyz|fi|ai|app|pro|co|net|org|hq|dao|nft|labs|protocol|finance|swap|dex|network|chain|base|hub)$/i, '');
  } else if (token) {
    raw = token[1];
  }
  if (!raw) return null;
  return simplifyProjectName(raw);
}

function simplifyProjectName(name) {
  const parts = name.replace(/([a-z])([A-Z])/g, '$1 $2')
                    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
                    .replace(/[_\-]/g, ' ')
                    .trim()
                    .split(/\s+/)
                    .filter(Boolean);

  if (parts.length === 1) {
    return parts[0];
  }

  const fillers = new Set(['use','my','the','get','go','be','do','on','in','at','by','of','to','a','an','de','la','le','el','al','pro','app','fi','io','xyz','network','protocol','finance','swap','dao','nft','labs','chain','base','hub']);

  const meaningful = parts.filter(p => !fillers.has(p.toLowerCase()));
  if (meaningful.length === 0) return parts[parts.length - 1];
  if (meaningful.length === 1) return meaningful[0];

  return meaningful[meaningful.length - 1];
}

// ─── Prompt Builder (verbatim from content.js) ───────────────────────
function buildPrompt(tweetText, tone, style, useGrammar, useProjectName, prevReplies, bigReplyWords, customPrompt, customWords) {
  const toneInstructions = {
    Smart: 'Reply like you actually paused and thought about it for a second. Keep it chill, slightly insightful, not trying to sound smart.',
    Funny: 'Reply like something just popped into your head and made you laugh. Keep it effortless, not like you\'re trying to be funny.',
    Professional: 'Reply like someone experienced but lowkey. No corporate tone, just calm, clear, straight to the point.',
    Supportive: 'Reply like you\'re backing a friend. Keep it simple, warm, and real not over caring.',
    Witty: 'Reply with a quick clever line. Feels natural, a bit sharp, like you didn\'t overthink it.',
    Curious: 'Reply like you\'re actually interested. Ask something simple that a real person would genuinely ask.',
    Short: 'Reply in very few words. Feels like a quick reaction, not a constructed sentence.',
    Human: 'Reply like you\'re texting, not writing. Slightly messy, casual, maybe incomplete but natural.',
    Positive: 'Reply like you liked the vibe. Keep it light, simple, no forced motivation energy.',
    PositiveQuestion: 'Reply with a chill question that sounds interested and a bit excited, not formal.',
    Helpful: 'Reply like you\'re casually helping, not "giving advice". Keep it practical but lowkey.',
    Alpha: `Reply like you're already in the space. Mention the project naturally if it fits. Mix it up — sometimes short (4-5 words) sometimes a little bit longer (7-8 words). Feels like a real user reacting, not promoting. Avoid perfect grammar. Add slight imperfections. No AI tone.`
  };

  // ── Custom Tone Mode ──────────────────────────────────────
  if (tone === 'Custom' && customPrompt) {
    const wordRule = customWords ? `Use approximately ${customWords} words.` : 'Keep it concise and natural.';
    const styleBlock = style ? `\n\nUser's writing style (follow closely):\n${style}` : '';
    const noRepeat = prevReplies.length > 0
      ? `\n\nDo NOT repeat or be similar to:\n${prevReplies.map(r => `- "${r}"`).join('\n')}`
      : '';
    return `You are replying to this tweet on Twitter/X:\n\n"${tweetText}"\n\nFollow these custom instructions exactly:\n${customPrompt}\n\n${wordRule}${styleBlock}${noRepeat}\n\nOutput ONLY the reply text, nothing else, no quotes.`;
  }

  const styleInstructions = style ? `\n\nUser's writing style (follow closely):\n${style}` : '';

  // No-repeat block
  const noRepeatBlock = prevReplies.length > 0
    ? `\n\nPREVIOUS REPLIES ALREADY USED — DO NOT REPEAT OR BE SIMILAR TO THESE:\n${prevReplies.map(r => `- "${r}"`).join('\n')}`
    : '';

  // Project name instruction (non-Alpha tones)
  let projectNameLine = '';
  if (useProjectName && tone !== 'Alpha') {
    const hint = extractProjectNameHint(tweetText);
    if (hint) {
      projectNameLine = `\n- Find the most relevant project name from the tweet (handle or text), simplify it to how people actually say it (e.g. MyNeighborAlice → Alice, useTria → Tria, XOOBNetwork → XOOB, 3Look_io → 3look), and use it naturally in your reply. The project here appears to be "${hint}" — use this clean simplified name. Skip if it feels forced.`;
    } else {
      projectNameLine = `\n- Find the most relevant project name from the tweet (handle or text), simplify it to how people actually say it, and use it naturally in your reply. Skip if it feels forced.`;
    }
  }

  if (tone === 'Alpha') {
    const grammarLine = useGrammar ? '' : '\n- Ignore grammar rules — type casually like a real person in telegram with typos short forms abbreviations';
    const hint = extractProjectNameHint(tweetText);
    const hintNote = hint ? `The project/token appears to be "${hint}" — use this clean name (no @, no $, no _io suffix).` : '';
    return `You are a real user already in the crypto/web3 space replying to this tweet:\n\n"${tweetText}"\n\n${toneInstructions.Alpha}${styleInstructions}${noRepeatBlock}\n\nSTRICT RULES:\n- Find the most relevant project name from the tweet, simplify to how people say it (e.g. MyNeighborAlice → Alice, useTria → Tria, XOOBNetwork → XOOB, 3Look_io → 3look)${hintNote ? ` — here it's "${hint}"` : ''} — mention it naturally if it fits. Skip if forced.\n- Mix reply length: sometimes 4-5 words sometimes 7-8 words (HARD LIMIT: max 8 words total)\n- Randomly pick a style: casual reaction OR genuine question OR light joke OR low-key hype\n- Do NOT end with a period or exclamation mark\n- Do NOT use commas or dashes\n- Do NOT use @ mentions or $ signs\n- Do NOT use AI-sounding words like "robust" "leveraging" "ecosystem" "impressive"\n- Do NOT start with I\n- Do NOT say "sounds like" "looks like" "seems like"\n- Add slight imperfections — real people don't write perfectly${grammarLine}\n- Output ONLY the reply text, nothing else, no quotes`;
  }

  const grammarLine = useGrammar ? '' : '\n- Ignore grammar — write like a real person texting: no capitals, no punctuation, short forms ok, small typos ok';

  // Big reply mode: use custom word count from saved config
  const wordCountRule = bigReplyWords
    ? `- ${bigReplyWords} words — keep it natural, not too short not too long`
    : `- 4 to 5 words max — real humans reply short`;

  return `You are writing a Twitter/X reply. The original tweet is:\n\n"${tweetText}"\n\n${toneInstructions[tone]}${styleInstructions}${noRepeatBlock}\n\nSTRICT RULES:\n- ${wordCountRule}${projectNameLine}\n- Do NOT end with a period or exclamation mark\n- Do NOT use commas inside the reply\n- Do NOT use a dash or hyphen inside the reply\n- Do NOT mention any username with @ symbol\n- Do NOT use any $ symbol or token names\n- Do NOT start with excited words like wow omg amazing incredible impressive love this\n- Do NOT start with I\n- Do NOT say sounds like or looks like or seems like\n- Write like a real casual human not an AI${grammarLine}\n- Output ONLY the reply text, nothing else, no quotes`;
}

// ─── Alpha Word Filter (verbatim from content.js) ────────────────────
function filterAlphaReply(text, tone) {
  if (tone !== 'Alpha') return text;
  const words = text.trim().split(/\s+/);
  if (words.length <= 7) return text;
  const cutAt = Math.random() > 0.5 ? 6 : 5;
  return words.slice(0, cutAt).join(' ');
}

// ─── Quick-mode prompt builders ───────────────────────────────────────
// Ported verbatim from content.js's repBuildPrompt (REP engine's one-
// click comment reply) and feedBuildPrompt (FED engine's "Model 1"
// quick-reply mode). These are deliberately simpler/shorter than the
// main buildPrompt above — no tone, no style, no project-name, no
// dedup — and were previously duplicated client-side alongside their
// own full set of callGemini/callOpenAI/etc providers. That's the
// "3 duplicated AI copies" the original migration brief referred to:
// this one, feedBuildPrompt below, and the main buildPrompt() already
// ported above.
function repBuildPrompt(postText, commentText) {
  return `You are replying to a comment on your own X (Twitter) post.\n\nYOUR ORIGINAL POST:\n"${postText}"\n\nTHE COMMENT YOU ARE REPLYING TO:\n"${commentText}"\n\nWrite a short, natural reply directly addressing the comment. Use the original post only as background context — do not repeat it.\n\nSTRICT RULES:\n- 4 to 6 words max — always extremely short, like a real quick reply\n- Do NOT end with a period or exclamation mark\n- Do NOT use commas, dashes, or hyphens\n- Do NOT use @ mentions or $ symbols\n- Do NOT start with I\n- Do NOT say sounds like, looks like, or seems like\n- Write like a real casual human, not an AI\n- Output ONLY the reply text, nothing else, no quotes`;
}

function feedBuildPrompt(postText) {
  return `You are replying to this post on X (Twitter), seen while scrolling your home feed:\n\n"${postText}"\n\nWrite a short, natural reply reacting to this post.\n\nSTRICT RULES:\n- 4 to 6 words max — always extremely short, like a real quick reply\n- Do NOT end with a period or exclamation mark\n- Do NOT use commas, dashes, or hyphens\n- Do NOT use @ mentions or $ symbols\n- Do NOT start with I\n- Do NOT say sounds like, looks like, or seems like\n- Write like a real casual human, not an AI\n- Output ONLY the reply text, nothing else, no quotes`;
}

module.exports = {
  buildPrompt,
  filterAlphaReply,
  extractProjectNameHint,
  simplifyProjectName,
  repBuildPrompt,
  feedBuildPrompt,
};
