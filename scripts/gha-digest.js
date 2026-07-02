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
const BASE_URL = 'https://api.deepseek.com/anthropic';
const MODEL = 'deepseek-v4-pro';
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
  try{fx=JSON.parse(await readFile(join(REPO_DIR,'feed-x.json'),'utf-8'));}catch(e){}
  try{fp=JSON.parse(await readFile(join(REPO_DIR,'feed-podcasts.json'),'utf-8'));}catch(e){}
  try{fb=JSON.parse(await readFile(join(REPO_DIR,'feed-blogs.json'),'utf-8'));}catch(e){}
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
  pm+=`\n\n## 双语输出（中文优先）\n- 每条内容先中文后英文，中间空一行，严格交替`;
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
  log('🧠',`调用 DeepSeek (${isWeekly?'周报':'日报'}模式)...`);
  const res=await fetch(`${BASE_URL}/v1/messages`,{method:'POST',headers:{'Content-Type':'application/json','x-api-key':TOKEN,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:MODEL,max_tokens:isWeekly?16384:8192,system:buildSystem(data),messages:[{role:'user',content:buildUser(data)}]})});
  if(!res.ok){const e=await res.text();throw new Error(`API ${res.status}: ${e.slice(0,500)}`);}
  const r=await res.json();
  const tb=r?.content?.find(c=>c.type==='text');
  if(!tb?.text) throw new Error('API 返回空内容');
  return tb.text;
}

async function saveMd(digest){
  await mkdir(OUTPUT_DIR,{recursive:true});
  const fp=join(OUTPUT_DIR,`${isWeekly?'WEEKLY-':''}${today()}.md`);
  await writeFile(fp,digest,'utf-8');
  log('✅',`已保存: ${fp}`);
  return fp;
}

function parseDigestSections(digest) {
  const SECTION_PATTERNS = [
    {re: /^##\s*(X\s*[\/\/]\s*TWITTER|X\/TWITTER|TWITTER|推文)/im, title: '🐦 X / Twitter'},
    {re: /^##\s*(官方博客|OFFICIAL BLOGS?|BLOGS?|博客)/im, title: '📝 官方博客'},
    {re: /^##\s*(PODCASTS?|播客)/im, title: '🎙️ Podcast 播客'},
  ];
  const lines = digest.split('\n');
  const sections = [];
  let intro = [];
  let cur = null;
  for (const line of lines) {
    let matched = false;
    for (const {re, title} of SECTION_PATTERNS) {
      if (re.test(line)) {
        if (cur) sections.push(cur);
        cur = {title, lines: []};
        matched = true;
        break;
      }
    }
    if (!matched) {
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

function buildTocCard(label, digest, isWeekly) {
  const {sections} = parseDigestSections(digest);
  if (sections.length === 0) return null;
  const parts = [];
  for (const s of sections) {
    if (!s.content.trim()) continue;
    // Split into individual author/entry blocks by ### headers
    const blocks = s.content.split(/(?=^###\s)/m).filter(b => b.trim());
    parts.push(`**${s.title}** (${blocks.length})`);
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      const header = lines[0].replace(/^###\s*/, '').trim();
      // First non-empty line that isn't a header or a bare URL
      const preview = lines.slice(1).find(l => {
        const t = l.trim();
        return t && !t.startsWith('#') && !/^https?:\/\/\S+$/.test(t) && t.length > 5;
      });
      const previewClean = preview
        ? preview.trim().replace(/\*\*/g, '').slice(0, 50) + (preview.trim().length > 50 ? '…' : '')
        : '';
      parts.push(`• ${header}${previewClean ? ' — ' + previewClean : ''}`);
    }
    parts.push('');
  }
  parts.push('👇 全文见下条消息');
  return {
    header: {title: {tag: 'plain_text', content: label + ' · 概览'}, template: isWeekly ? 'purple' : 'blue'},
    elements: [{tag: 'markdown', content: parts.join('\n')}],
  };
}

async function postToFeishu(url, card) {
  const res = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({msg_type: 'interactive', card})});
  if (!res.ok) throw new Error(`Webhook ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function sendFeishu(digest, url){
  if(!url){log('⚠️','未配置 webhook');return false;}
  const label=isWeekly?`📊 AI Builders Weekly — ${today()}`:`🤖 AI Builders Digest — ${today()}`;
  // Message 1: compact overview card (who/what is covered today)
  const tocCard = buildTocCard(label, digest, isWeekly);
  if (tocCard) {
    await postToFeishu(url, tocCard);
    await new Promise(r => setTimeout(r, 600));
  }
  // Message 2: full digest
  const text = digest.length > 28000 ? digest.slice(0, 28000) + '\n\n...(过长已截断)' : digest;
  const fullCard = {
    header: {title: {tag: 'plain_text', content: label + ' · 全文'}, template: isWeekly ? 'purple' : 'blue'},
    elements: [{tag: 'markdown', content: text}],
  };
  await postToFeishu(url, fullCard);
  return true;
}

async function main(){
  const label=isWeekly?'Week in Review':today();
  console.log('═══════════════════════════════════════════');
  console.log(`  🤖 AI Builders ${isWeekly?'Weekly':'Digest'} — ${label}`);
  console.log('  Bilingual (中文 → English)');
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
