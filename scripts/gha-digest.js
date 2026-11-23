#!/usr/bin/env node
// GitHub Actions Digest — local feeds → DeepSeek → MD → Feishu
import { writeFile, mkdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(__dirname, '..');
const OUTPUT_DIR = join(__dirname, 'output');

const TOKEN = process.env.DEEPSEEK_API_KEY;
const WEBHOOK = process.env.FEISHU_WEBHOOK_URL;
const WEBHOOK_GROUP = process.env.FEISHU_WEBHOOK_URL_GROUP;
const BASE_URL = 'https://api.deepseek.com';
const MODEL = 'deepseek-chat';
const isWeekly = process.argv.includes('--weekly');

function today() {
  const now = new Date();
  const sh = new Date(now.toLocaleString('en-US', {timeZone:'Asia/Shanghai'}));
  return sh.toISOString().slice(0,10);
}
function log(e,m) { console.log(`[${new Date().toISOString()}] ${e} ${m}`); }

async function loadData() {
  log('📂','加载本地 feed...');
  let fx={},fp={},fb={},prompts={};
  try{fx=JSON.parse(await readFile(join(REPO_DIR,'feed-x.json'),'utf-8'));}catch(e){log('⚠️',`读取 feed-x.json 失败: ${e.message}`);}
  try{fp=JSON.parse(await readFile(join(REPO_DIR,'feed-podcasts.json'),'utf-8'));}catch(e){log('⚠️',`读取 feed-podcasts.json 失败: ${e.message}`);}
  try{fb=JSON.parse(await readFile(join(REPO_DIR,'feed-blogs.json'),'utf-8'));}catch(e){log('⚠️',`读取 feed-blogs.json 失败: ${e.message}`);}
  for(const k of ['digest-intro','summarize-tweets','summarize-blogs','summarize-podcast','translate']){
    try{prompts[k.replace(/-/g,'_')]=await readFile(join(REPO_DIR,'prompts',`${k}.md`),'utf-8');}catch(e){}
  }
  const xd=fx?.x||[], pods=fp?.podcasts||[], bl=fb?.blogs||[];
  return {podcasts:pods,x:xd,blogs:bl,stats:{podcastEpisodes:pods.length,xBuilders:xd.length,totalTweets:xd.reduce((s,a)=>s+(a.tweets?.length||0),0),blogPosts:bl.length},prompts};
}

function buildSystem(data){
  const p=data.prompts||{};
  let pm=`你是一位专业的 AI 行业编辑，为忙碌的中国 AI 从业者撰写每日行业摘要。`;
  if(isWeekly) pm+=`\n\n本周报模式：按主题（趋势、产品、研究、观点）组织内容，提炼本周最重要的信号。`;
  pm+=`\n\n## 格式\n${p.digest_intro||''}`;
  pm+=`\n\n## Tweets 摘要规则\n${p.summarize_tweets||''}`;
  pm+=`\n\n## 博客摘要规则\n${p.summarize_blogs||''}`;
  pm+=`\n\n## Podcast 摘要规则\n${p.summarize_podcast||''}`;
  pm+=`\n\n## 语言规则\n${p.translate||''}`;
  pm+=`\n\n## 输出语言（最高优先级）
- 只使用简体中文
- 英文内容翻译为自然流畅的中文
- 人名、公司名、产品名和 URL 可以保留原文
- 不要附带英文原文或英文译文`;
  pm+=`\n\n## 核心规则\n- 只使用真实数据，绝不编造\n- 每条内容必须带原文链接\n- 适合手机阅读\n- 语气专业但轻松\n- 安静的 builder 直接跳过\n- 末尾加: "Generated through Follow Builders: https://github.com/zarazhangrui/follow-builders"`;
  return pm;
}

function buildUser(data){
  const s=data.stats||{};
  let m=`请生成 ${today()} 的 AI Builders ${isWeekly?'Weekly(周报)':'Digest(日报)'}。\n\n`;
  if(isWeekly) m+=`本周内容汇总，做周报风格——按主题组织。\n\n`;
  m+=`统计: ${s.totalTweets||0}推文 ${s.blogPosts||0}博客 ${s.podcastEpisodes||0}播客\n\n`;
  if(data.x?.length){m+='## X/Twitter\n\n';for(const b of data.x){m+=`### ${b.name} (@${b.handle})\nBio: ${b.bio||''}\n\n`;for(const t of b.tweets){m+=`- ${t.text}\n  URL: ${t.url}\n  Time: ${t.time||''}\n`;}m+='\n';}}
  if(data.blogs?.length){m+='## 博客\n\n';for(const b of data.blogs){m+=`### ${b.name}: ${b.title}\nURL: ${b.url}\nAuthor: ${b.author||''}\n\n${(b.content||b.summary||'').slice(0,4000)}\n\n`;}}
  if(data.podcasts?.length){m+='## Podcast\n\n';for(const p of data.podcasts){m+=`### ${p.name}: ${p.title}\nURL: ${p.url}\n\nTranscript(前8000字): ${(p.transcript||'').slice(0,8000)}\n\n`;}}
  return m;
}

async function remix(data){
  if(!TOKEN) throw new Error('未配置 DEEPSEEK_API_KEY');

  const maxAttempts=3;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    log('🧠',`调用 DeepSeek (${isWeekly?'周报':'日报'}模式，第 ${attempt}/${maxAttempts} 次)...`);
    try{
      const res=await fetch(`${BASE_URL}/chat/completions`,{
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          'Authorization':`Bearer ${TOKEN}`,
        },
        body:JSON.stringify({
          model:MODEL,
          stream:false,
          max_tokens:8192,
          temperature:0.3,
          messages:[
            {role:'system',content:buildSystem(data)},
            {role:'user',content:buildUser(data)},
          ],
        }),
      });

      const raw=await res.text();
      if(!res.ok){
        const error=new Error(`API ${res.status}: ${raw.slice(0,500)}`);
        error.retryable=res.status===429||res.status>=500;
        throw error;
      }

      let result;
      try{result=JSON.parse(raw);}catch{
        const error=new Error(`API 返回的不是有效 JSON: ${raw.slice(0,500)}`);
        error.retryable=true;
        throw error;
      }

      const text=result?.choices?.[0]?.message?.content
        ?? result?.content?.find(c=>c.type==='text')?.text
        ?? result?.output_text;
      if(text?.trim()) return text.trim();

      const finishReason=result?.choices?.[0]?.finish_reason??result?.stop_reason??'unknown';
      const error=new Error(`API 无文本输出 (finish_reason=${finishReason}): ${raw.slice(0,500)}`);
      error.retryable=true;
      throw error;
    }catch(e){
      if(attempt===maxAttempts||e.retryable===false) throw e;
      log('⚠️',`DeepSeek 第 ${attempt} 次失败: ${e.message.slice(0,180)}，准备重试`);
      await new Promise(resolve=>setTimeout(resolve,attempt*1500));
    }
  }

  throw new Error('DeepSeek 多次调用均失败');
}

async function saveMd(digest){
  await mkdir(OUTPUT_DIR,{recursive:true});
  const fp=join(OUTPUT_DIR,`${isWeekly?'WEEKLY-':''}${today()}.md`);
  await writeFile(fp,digest,'utf-8');
  log('✅',`已保存: ${fp}`);
  return fp;
}

function parseDigestSections(digest) {
  const EMOJI_MAP = [
    {re: /X|TWITTER|推文/i, emoji: '🐦'},
    {re: /博客|BLOG/i, emoji: '📝'},
    {re: /PODCAST|播客/i, emoji: '🎙️'},
    {re: /趋势|TREND/i, emoji: '📈'},
    {re: /产品|PRODUCT/i, emoji: '🚀'},
    {re: /研究|RESEARCH/i, emoji: '🔬'},
    {re: /观点|OPINION|视角/i, emoji: '💡'},
  ];
  const lines = digest.split('\n');
  const sections = [];
  let intro = [];
  let cur = null;
  for (const line of lines) {
    if (/^##\s+\S/.test(line)) {
      if (cur) sections.push(cur);
      const raw = line.replace(/^##\s*/, '').trim();
      const match = EMOJI_MAP.find(m => m.re.test(raw));
      cur = {title: match ? `${match.emoji} ${raw}` : raw, lines: []};
    } else {
      if (cur) cur.lines.push(line);
      else intro.push(line);
    }
  }
  if (cur) sections.push(cur);
  return {
    intro: intro.join('\n').trim(),
    sections: sections.map(s => ({title: s.title, content: s.lines.join('\n').trim()})),
  };
}

async function postToFeishu(url, card) {
  const res = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({msg_type: 'interactive', card})});
  const raw = await res.text();
  if (!res.ok) throw new Error(`Webhook HTTP ${res.status}: ${raw.slice(0, 500)}`);

  let result;
  try { result = JSON.parse(raw); }
  catch { throw new Error(`飞书返回的不是有效 JSON: ${raw.slice(0, 500)}`); }

  const code = result?.code ?? result?.StatusCode;
  if (code !== undefined && String(code) !== '0') {
    throw new Error(`飞书拒绝消息: ${raw.slice(0, 500)}`);
  }
  return result;
}

function buildCardV2(label, digest, isWeekly) {
  const {intro, sections} = parseDigestSections(digest);
  const elements = [];
  if (intro) elements.push({tag: 'markdown', content: intro.slice(0, 2000)});
  if (sections.length > 0) {
    if (intro) elements.push({tag: 'hr'});
    for (const s of sections) {
      const content = s.content.length > 9000 ? s.content.slice(0, 9000) + '\n\n...(内容过长已截断)' : s.content;
      elements.push({
        tag: 'collapsible_panel',
        header: {title: {tag: 'plain_text', content: s.title}, color: isWeekly ? 'purple' : 'blue'},
        expand_btn_position: 'right',
        expanded: false,
        elements: [{tag: 'markdown', content}],
      });
    }
  } else {
    const text = digest.length > 28000 ? digest.slice(0, 28000) + '\n\n...(过长已截断)' : digest;
    if (!intro) elements.push({tag: 'markdown', content: text});
  }
  return {
    schema: '2.0',
    header: {title: {tag: 'plain_text', content: label}, template: isWeekly ? 'purple' : 'blue'},
    body: {elements},
  };
}

async function sendFeishu(digest, url){
  if(!url){log('⚠️','未配置 webhook');return false;}
  const label=isWeekly?`📊 AI Builders Weekly — ${today()}`:`🤖 AI Builders Digest — ${today()}`;
  // Try Card 2.0 with collapsible panels
  try {
    await postToFeishu(url, buildCardV2(label, digest, isWeekly));
    return true;
  } catch(e) {
    log('⚠️', `Card 2.0 失败 (${e.message.slice(0,80)})，降级为普通卡片`);
  }
  // Fallback: Card 1.0 single block
  const text = digest.length > 28000 ? digest.slice(0, 28000) + '\n\n...(过长已截断)' : digest;
  await postToFeishu(url, {
    header: {title: {tag: 'plain_text', content: label}, template: isWeekly ? 'purple' : 'blue'},
    elements: [{tag: 'markdown', content: text}],
  });
  return true;
}

async function main(){
  const label=isWeekly?'Week in Review':today();
  console.log('═══════════════════════════════════════════');
  console.log(`  🤖 AI Builders ${isWeekly?'Weekly':'Digest'} — ${label}`);
  console.log('  Chinese Only (仅中文)');
  console.log('═══════════════════════════════════════════\n');
  const data=await loadData();
  const s=data.stats||{};
  log('📊',`加载: ${s.totalTweets||0}推文 ${s.blogPosts||0}博客 ${s.podcastEpisodes||0}播客`);
  if(!s.totalTweets&&!s.blogPosts&&!s.podcastEpisodes){log('😴','无内容');const ed=`# AI Builders ${isWeekly?'Weekly':'Digest'} — ${label}\n\n今天没有新的 AI Builder 内容。`;await saveMd(ed);if(WEBHOOK)await sendFeishu(ed,WEBHOOK);if(WEBHOOK_GROUP)await sendFeishu(ed,WEBHOOK_GROUP);return;}
  let digest;
  try{digest=await remix(data);log('✅',`摘要完成 (${digest.length}字)`);}catch(e){log('❌',`DeepSeek 失败: ${e.message}`);digest=`# AI Builders ${isWeekly?'Weekly':'Digest'} — ${label}\n\n> ⚠️ 摘要生成失败: ${e.message}\n\n推文${s.totalTweets||0}|博客${s.blogPosts||0}|播客${s.podcastEpisodes||0}`;}
  const mdPath=await saveMd(digest);
  try{
    if(WEBHOOK){await sendFeishu(digest,WEBHOOK);log('✅','飞书个人推送成功');}
    if(WEBHOOK_GROUP){await sendFeishu(digest,WEBHOOK_GROUP);log('✅','飞书群推送成功');}
  }catch(e){log('❌',`飞书推送失败: ${e.message}`);}
  console.log(`\n✨ 完成! ${mdPath}`);
}
main().catch(e=>{console.error('Fatal:',e);process.exit(1);});
