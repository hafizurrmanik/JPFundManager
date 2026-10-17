'use strict';
/* ---------- helpers ---------- */
const $=s=>document.querySelector(s);
const pad=n=>String(n).padStart(2,'0');
const today=()=>{const d=new Date();return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`};
const yen=n=>`${n<0?'-':''}¥${Math.abs(Math.round(n)).toLocaleString('ja-JP')}`;
const sgn=n=>`${n<0?'-':'+'}${yen(Math.abs(n))}`;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const sum=a=>a.reduce((s,x)=>s+x.amount,0);
const byDate=(a,b)=>b.date.localeCompare(a.date)||String(b.id).localeCompare(String(a.id));
const shiftMonth=(m,n)=>{const[y,mo]=m.split('-').map(Number),d=new Date(y,mo-1+n,1);return `${d.getFullYear()}-${pad(d.getMonth()+1)}`};
const monthShort=m=>new Date(+m.slice(0,4),+m.slice(5)-1,1).toLocaleString('en',{month:'short'});

const state={month:today().slice(0,7),deposits:[],expenses:[],settlements:[],cashTo:{}};
const names={a:'Person A',b:'Person B'};
const nm=k=>esc(names[k]);
const app=$('#app');
let page='dashboard',db=null;
const mem={deposits:[],expenses:[],settlements:[],meta:[]};

function notify(text){const t=$('#toast');t.textContent=text;t.classList.add('show');clearTimeout(notify.t);notify.t=setTimeout(()=>t.classList.remove('show'),2200)}

/* ---------- storage (IndexedDB, memory fallback) ---------- */
const keyOf=s=>({settlements:'month',meta:'key'}[s]||'id');
function openDB(){return new Promise(res=>{try{const r=indexedDB.open('shared-fund-manager',1);
  r.onupgradeneeded=()=>{const d=r.result;d.createObjectStore('deposits',{keyPath:'id'});d.createObjectStore('expenses',{keyPath:'id'});d.createObjectStore('settlements',{keyPath:'month'});d.createObjectStore('meta',{keyPath:'key'})};
  r.onsuccess=()=>{db=r.result;res()};r.onerror=r.onblocked=()=>res()}catch{res()}})}
const tx=(s,mode,f)=>new Promise((res,rej)=>{const t=db.transaction(s,mode),q=f(t.objectStore(s));t.oncomplete=()=>res(q&&q.result);t.onerror=t.onabort=()=>rej(t.error)});
async function put(s,v){if(!db){const a=mem[s],i=a.findIndex(x=>x[keyOf(s)]===v[keyOf(s)]);i<0?a.push(v):a[i]=v;return}return tx(s,'readwrite',o=>o.put(v))}
async function del(s,k){if(!db){mem[s]=mem[s].filter(x=>x[keyOf(s)]!==k);return}return tx(s,'readwrite',o=>o.delete(k))}
async function all(s){return db?tx(s,'readonly',o=>o.getAll()):[...mem[s]]}
async function clear(s){if(!db){mem[s]=[];return}return tx(s,'readwrite',o=>o.clear())}
async function load(){
  state.deposits=await all('deposits');state.expenses=await all('expenses');state.settlements=await all('settlements');
  const meta=await all('meta'),m=meta.find(x=>x.key==='names');if(m)Object.assign(names,m.value);
  const c=meta.find(x=>x.key==='cashTo');state.cashTo=c&&c.value&&typeof c.value==='object'?{...c.value}:{}}
async function save(store,v,msg){await put(store,v);await load();show();notify(msg)}

/* ---------- calculations ---------- */
const depIn=m=>state.deposits.filter(x=>x.date.startsWith(m));
const expIn=m=>state.expenses.filter(x=>x.date.startsWith(m));
const jointOf=m=>sum(expIn(m).filter(x=>x.scope==='joint'));
const fundBalance=()=>sum(state.deposits)-sum(state.expenses.filter(x=>x.source==='fund'));
const setl=m=>state.settlements.find(s=>s.month===m);
const carryIn=m=>{const s=setl(shiftMonth(m,-1));return s&&s.mode==='carry'?s.total:0};
/* Settlement model (per month, integers only):
   bal[k]  = deposits + own-pocket joint payments - personal(fund) - fair share
   cash    = this month's deposits - this month's fund-paid spending (= bal.a + bal.b)
   The remaining cash is a shared ASSET: whoever receives it has it deducted from their balance,
   so adjusted balances always sum to 0 and the settlement is exactly adj.a (>0: b pays a).
   Odd yen: a bears floor(J/2), b bears the extra yen (unchanged from before).
   Months settled before this change (no cashTo stored) keep the old equal-split-cash result. */
const cashAdj=(bal,cash,to)=>({a:bal.a-(to==='a'?cash:0),b:bal.b-(to==='b'?cash:0)});
function calc(m){
  const D={a:0,b:0},O={a:0,b:0},P={a:0,b:0};let J=0;
  depIn(m).forEach(x=>D[x.member]+=x.amount);
  expIn(m).forEach(x=>{
    if(x.scope==='joint'){J+=x.amount;if(x.source!=='fund')O[x.source]+=x.amount}
    else if(x.source==='fund')P[x.owner]+=x.amount});
  const share=Math.floor(J/2);
  const bal={a:D.a+O.a-P.a-share,b:D.b+O.b-P.b-(J-share)};
  const fundOut=(J-O.a-O.b)+P.a+P.b,cash=D.a+D.b-fundOut;
  const s=setl(m),legacy=!!s&&!s.cashTo;
  const auto=Math.abs(cashAdj(bal,cash,'a').a)<=Math.abs(cashAdj(bal,cash,'b').a)?'a':'b';
  const pick=v=>v==='a'||v==='b'?v:null;
  const cashTo=legacy?null:(s&&pick(s.cashTo))||pick(state.cashTo[m])||auto;
  const carry=carryIn(m);
  let adj=null,net=null,base;
  if(legacy)base=Math.trunc((bal.a-bal.b)/2);
  else{adj=cashAdj(bal,cash,cashTo);base=adj.a;
    net={a:D.a+O.a-(cashTo==='a'?cash:0)-base,b:D.b+O.b-(cashTo==='b'?cash:0)+base}}
  return{D,O,P,J,share,bal,cash,cashTo,auto,legacy,adj,net,base,carry,diff:base+carry};
}
const oweText=d=>d===0?'হিসাব সমান — কারো কিছু দেওয়ার নেই':d>0?`${nm('b')} → ${nm('a')} কে দিতে হবে ${yen(d)}`:`${nm('a')} → ${nm('b')} কে দিতে হবে ${yen(-d)}`;

/* ---------- ui helpers ---------- */
const card=(a,b,c,d,e)=>`<div class="stat-card"><div class="stat-icon ${d}">${e}</div><div><span>${a}</span><strong>${b}</strong><small>${c}</small></div></div>`;
const head=(eye,title,sub,extra='')=>`<div class="page-heading"><div><div class="eyebrow">${eye}</div><h1>${title}</h1><p>${sub}</p></div><div class="heading-actions">${extra}</div></div>`;
const monthIn=()=>`<input id="month" type="month" value="${state.month}" aria-label="মাস">`;
const empty=t=>`<p class="empty">${t}</p>`;
const table=(heads,rows)=>`<div class="table-wrap"><table><thead><tr>${heads.map(h=>`<th${h==='পরিমাণ'?' class="num"':''}>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
const acts=(kind,id)=>`<td class="row-actions"><button class="icon-btn" data-act="edit" data-kind="${kind}" data-id="${id}" title="সম্পাদনা" aria-label="সম্পাদনা">✎</button><button class="icon-btn danger" data-act="del" data-kind="${kind}" data-id="${id}" title="মুছুন" aria-label="মুছুন">✕</button></td>`;
const withKind=(a,k)=>a.map(x=>({...x,kind:k}));
const txRow=x=>{const d=x.kind==='deposits';
  return `<tr><td>${x.date}</td><td><span class="badge ${d?'green':x.scope==='joint'?'gold':'purple'}">${d?'জমা':x.scope==='joint'?'যৌথ':'ব্যক্তিগত'}</span></td><td>${esc(d?(x.note||'ফান্ডে জমা'):x.shop)}${!d&&x.note?`<small class="sub">${esc(x.note)}</small>`:''}</td><td>${d?nm(x.member):x.source==='fund'?'ফান্ড'+(x.owner?` (${nm(x.owner)})`:''):nm(x.source)}</td><td class="num ${d?'positive':'expense-number'}">${d?'+':'-'}${yen(x.amount)}</td>${acts(x.kind,x.id)}</tr>`};
const txTable=l=>l.length?table(['তারিখ','ধরন','বিবরণ','কে','পরিমাণ',''],l.sort(byDate).map(txRow).join('')):empty('কোনো রেকর্ড নেই।');
const defDate=()=>state.month===today().slice(0,7)?today():state.month+'-01';

/* ---------- modal forms ---------- */
const fld=(l,n,t,v,ex='')=>`<label class="field"><span>${l}</span><input name="${n}" type="${t}" value="${esc(v)}" ${ex}></label>`;
const sel=(l,n,opts,v)=>`<label class="field"><span>${l}</span><select name="${n}">${opts.map(([k,t])=>`<option value="${k}"${k===v?' selected':''}>${t}</option>`).join('')}</select></label>`;
function modal(title,body,onsave){
  const m=document.createElement('div');m.className='modal-back';
  m.innerHTML=`<form class="modal"><h2>${title}</h2>${body}<div class="modal-actions"><button type="button" class="button outline" data-x>বাতিল</button><button class="button primary">সংরক্ষণ করুন</button></div></form>`;
  document.body.append(m);const f=m.querySelector('form'),close=()=>m.remove();
  m.querySelector('[data-x]').onclick=close;m.onclick=e=>{if(e.target===m)close()};
  f.onsubmit=async e=>{e.preventDefault();if(await onsave(Object.fromEntries(new FormData(f))) !== false)close()};
  f.querySelector('input,select').focus();return f}
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('.modal-back')?.remove()});

function depositForm(x={}){
  modal(x.id?'জমা সম্পাদনা':'নতুন জমা',
    fld('তারিখ','date','date',x.date||defDate(),'required')+sel('কে জমা দিয়েছে','member',[['a',nm('a')],['b',nm('b')]],x.member)+fld('পরিমাণ (¥)','amount','number',x.amount||'','min="1" step="1" required inputmode="numeric"')+fld('নোট','note','text',x.note||'','maxlength="80"'),
    async d=>{const amount=parseInt(d.amount,10);if(!(amount>0)){notify('সঠিক পরিমাণ দিন');return false}
      await save('deposits',{id:x.id||uid(),date:d.date,member:d.member,amount,note:d.note.trim()},'জমা সংরক্ষিত হয়েছে')})}

function expenseForm(x={}){
  const f=modal(x.id?'খরচ সম্পাদনা':'নতুন খরচ',
    fld('তারিখ','date','date',x.date||defDate(),'required')+fld('দোকান / বিবরণ','shop','text',x.shop||'','maxlength="60" required placeholder="যেমন: Gyomu Super"')+fld('পরিমাণ (¥)','amount','number',x.amount||'','min="1" step="1" required inputmode="numeric"')
    +sel('ধরন','scope',[['joint','যৌথ (৫০/৫০ ভাগ)'],['personal','ব্যক্তিগত (ভাগ হবে না)']],x.scope)
    +sel('কে পরিশোধ করেছে','source',[['fund','ফান্ড থেকে'],['a',`${nm('a')} (নিজের পকেট)`],['b',`${nm('b')} (নিজের পকেট)`]],x.source||'fund')
    +`<div id="ownerbox">${sel('ব্যক্তিগত খরচটি কার','owner',[['a',nm('a')],['b',nm('b')]],x.owner)}</div>`+fld('নোট','note','text',x.note||'','maxlength="80"'),
    async d=>{const amount=parseInt(d.amount,10);if(!(amount>0)){notify('সঠিক পরিমাণ দিন');return false}
      const owner=d.scope==='personal'?(d.source==='fund'?d.owner:d.source):'';
      await save('expenses',{id:x.id||uid(),date:d.date,shop:d.shop.trim(),amount,scope:d.scope,source:d.source,owner,note:d.note.trim()},'খরচ সংরক্ষিত হয়েছে')});
  const sync=()=>{f.querySelector('#ownerbox').hidden=!(f.elements.scope.value==='personal'&&f.elements.source.value==='fund')};
  f.onchange=sync;sync()}

/* ---------- pages ---------- */
const pages={};
const tf={type:'all',scope:'month',q:''};

pages.dashboard=()=>{
  const D=depIn(state.month),E=expIn(state.month),joint=sum(E.filter(x=>x.scope==='joint')),personal=sum(E.filter(x=>x.scope==='personal')),r=calc(state.month);
  const ms=[...Array(6)].map((_,i)=>shiftMonth(state.month,i-5)),vals=ms.map(jointOf),top=Math.max(10000,Math.ceil(Math.max(...vals)/10000)*10000);
  const h=new Date().getHours(),greet=h<12?'GOOD MORNING':h<18?'GOOD AFTERNOON':'GOOD EVENING';
  const recent=[...withKind(state.deposits,'deposits'),...withKind(state.expenses,'expenses')].sort(byDate).slice(0,5);
  const person=k=>`<div class="member-row"><div class="person"><span class="person-avatar ${k==='b'?'teal':''}">${esc(names[k].charAt(0))}</span>${nm(k)}</div><strong class="${r.bal[k]<0?'negative':'positive'}">${sgn(r.bal[k])}</strong></div>`;
  app.innerHTML=head(`${greet} · ${new Date().toLocaleDateString('en-US',{weekday:'long'}).toUpperCase()}`,'Fund overview','Your shared household finances, at a glance.',`${monthIn()}<button class="button primary" data-act="addExpense">＋ Add expense</button>`)
  +`<section class="stats-grid">${card('Current fund balance',yen(fundBalance()),'Across all time','gold','◉')}${card('Deposits this month',yen(sum(D)),`${D.length} contributions`,'green','↓')}${card('Joint groceries',yen(joint),'50 / 50 split','blue','¥')}${card('Personal spending',yen(personal),'Excluded from split','purple','◌')}</section>
  <section class="dashboard-grid"><div class="panel"><div class="panel-head"><div><h2>Monthly spending</h2><span>Joint grocery expenses</span></div><button class="ghost-button" data-act="go" data-arg="reports">View report ↗</button></div>
  <div class="chart"><div class="y-axis"><span>¥${top/1000}k</span><span>¥${top/2000}k</span><span>¥0</span></div><div class="bars">${ms.map((m,i)=>`<div class="bar-group"><div class="bar ${i===5?'selected':''}" style="height:${vals[i]?Math.max(3,vals[i]/top*100):1}%" title="${yen(vals[i])}"></div><span>${monthShort(m)}</span></div>`).join('')}</div></div></div>
  <div class="panel"><div class="panel-head"><div><h2>Monthly balance</h2><span>Fair share calculation</span></div></div>${person('a')}${person('b')}<div class="split-line"><span>Each person's fair share</span><b>${yen(r.share)}</b></div><p class="owe">${oweText(r.diff)}</p><button class="button outline full" data-act="go" data-arg="settlement">Review settlement ↗</button></div></section>
  <section class="bottom-grid"><div class="panel"><div class="panel-head"><div><h2>Recent activity</h2><span>Latest fund movements</span></div></div>${recent.length?recent.map(x=>{const d=x.kind==='deposits';return `<div class="activity-row"><span class="activity-icon ${d?'deposit-icon':'expense-icon'}">${d?'↓':'▤'}</span><div class="activity-copy"><strong>${esc(d?'Fund deposit · '+names[x.member]:x.shop||'Grocery expense')}</strong><span>${x.date}</span></div><b class="${d?'positive':'expense-number'}">${d?'+':'-'}${yen(x.amount)}</b></div>`}).join(''):empty('এখনো কোনো রেকর্ড নেই। প্রথম জমা বা খরচ যোগ করুন।')}</div>
  <div class="panel"><div class="panel-head"><div><h2>Quick actions</h2><span>Keep your records current</span></div></div>
  <button class="quick-action" data-act="addDeposit"><span class="quick-icon green">↓</span><span><b>Add a deposit</b><small>Record fund contribution</small></span>＋</button>
  <button class="quick-action" data-act="addExpense"><span class="quick-icon gold">▤</span><span><b>Log an expense</b><small>Split or personal spending</small></span>＋</button>
  <button class="quick-action" data-act="go" data-arg="backup"><span class="quick-icon blue">▧</span><span><b>Back up data</b><small>Export a local copy</small></span>↗</button></div></section>`};

pages.deposits=()=>{
  const D=depIn(state.month);
  app.innerHTML=head('DEPOSITS','টাকা জমা','ফান্ডে জমা দেওয়ার হিসাব',`${monthIn()}<button class="button primary" data-act="addDeposit">＋ জমা যোগ করুন</button>`)
  +`<section class="stats-grid">${card('এই মাসের মোট জমা',yen(sum(D)),`${D.length}টি জমা`,'green','↓')}${card(nm('a'),yen(sum(D.filter(x=>x.member==='a'))),'এই মাসে','gold','A')}${card(nm('b'),yen(sum(D.filter(x=>x.member==='b'))),'এই মাসে','blue','B')}${card('ফান্ডের ব্যালান্স',yen(fundBalance()),'সব সময়ের','purple','◉')}</section>
  <div class="panel spaced">${txTable(withKind(D,'deposits'))}</div>`};

pages.expenses=()=>{
  const E=expIn(state.month);
  app.innerHTML=head('EXPENSES','বাজারের খরচ','যৌথ ও ব্যক্তিগত খরচের তালিকা',`${monthIn()}<button class="button primary" data-act="addExpense">＋ খরচ যোগ করুন</button>`)
  +`<section class="stats-grid">${card('যৌথ খরচ',yen(sum(E.filter(x=>x.scope==='joint'))),'৫০/৫০ ভাগ হবে','blue','¥')}${card('ব্যক্তিগত খরচ',yen(sum(E.filter(x=>x.scope==='personal'))),'ভাগ হবে না','purple','◌')}${card('ফান্ড থেকে',yen(sum(E.filter(x=>x.source==='fund'))),'এই মাসে','gold','◉')}${card('মোট এন্ট্রি',E.length,'এই মাসে','green','▤')}</section>
  <div class="panel spaced">${txTable(withKind(E,'expenses'))}</div>`};

function txList(){
  let l=[...withKind(state.deposits,'deposits'),...withKind(state.expenses,'expenses')];
  if(tf.type!=='all')l=l.filter(x=>x.kind===tf.type);
  if(tf.scope==='month')l=l.filter(x=>x.date.startsWith(state.month));
  const q=tf.q.trim().toLowerCase();
  if(q)l=l.filter(x=>[x.shop,x.note,names[x.member],names[x.source]].join(' ').toLowerCase().includes(q));
  $('#txlist').innerHTML=txTable(l)+`<p class="sub total-line">${l.length}টি রেকর্ড</p>`}
pages.transactions=()=>{
  app.innerHTML=head('HISTORY','লেনদেনের ইতিহাস','সব জমা ও খরচ এক জায়গায়',monthIn())
  +`<div class="panel"><div class="filters"><select id="ftype" aria-label="ধরন"><option value="all">সব ধরন</option><option value="deposits">শুধু জমা</option><option value="expenses">শুধু খরচ</option></select><select id="fscope" aria-label="সময়"><option value="month">এই মাস</option><option value="all">সব সময়</option></select><input id="q" type="search" placeholder="দোকান বা নোট খুঁজুন…" aria-label="খুঁজুন"></div><div id="txlist"></div></div>`;
  $('#ftype').value=tf.type;$('#fscope').value=tf.scope;$('#q').value=tf.q;txList()};

pages.reports=()=>{
  const months=[...new Set([...state.deposits,...state.expenses].map(x=>x.date.slice(0,7)))].sort().reverse();
  const totalJoint=sum(state.expenses.filter(x=>x.scope==='joint')),avg=months.length?Math.round(totalJoint/months.length):0;
  const shops={};expIn(state.month).forEach(x=>{const k=(x.shop||'অন্যান্য').trim();shops[k]=(shops[k]||0)+x.amount});
  const list=Object.entries(shops).sort((a,b)=>b[1]-a[1]).slice(0,8),mx=list.length?list[0][1]:1;
  const badge=m=>{const s=setl(m);return s?`<span class="badge ${s.mode==='closed'?'green':'blue'}">${s.mode==='closed'?'বন্ধ':'ক্যারি'}</span>`:'<span class="badge gold">চলমান</span>'};
  app.innerHTML=head('REPORTS','মাসিক হিসাব','মাস অনুযায়ী সারসংক্ষেপ',monthIn())
  +`<section class="stats-grid">${card('মোট জমা',yen(sum(state.deposits)),'সব সময়ের','green','↓')}${card('মোট যৌথ খরচ',yen(totalJoint),'সব সময়ের','blue','¥')}${card('মাসিক গড় যৌথ খরচ',yen(avg),`${months.length} মাসে`,'gold','≈')}${card('ফান্ডের ব্যালান্স',yen(fundBalance()),'এখন','purple','◉')}</section>
  <section class="dashboard-grid"><div class="panel"><div class="panel-head"><div><h2>মাস অনুযায়ী</h2><span>জমা, খরচ ও প্রত্যেকের অংশ</span></div></div>${months.length?table(['মাস','জমা','যৌথ','ব্যক্তিগত','প্রত্যেকের অংশ','অবস্থা'],months.map(m=>`<tr><td>${m}</td><td class="num">${yen(sum(depIn(m)))}</td><td class="num">${yen(jointOf(m))}</td><td class="num">${yen(sum(expIn(m).filter(x=>x.scope==='personal')))}</td><td class="num">${yen(Math.floor(jointOf(m)/2))}</td><td>${badge(m)}</td></tr>`).join('')):empty('রিপোর্ট দেখাতে কিছু রেকর্ড যোগ করুন।')}</div>
  <div class="panel"><div class="panel-head"><div><h2>${state.month} — দোকান অনুযায়ী</h2><span>সবচেয়ে বেশি খরচ</span></div></div>${list.length?list.map(([k,v])=>`<div class="shop-row"><div class="member-row compact"><span>${esc(k)}</span><b>${yen(v)}</b></div><div class="bar-line"><i style="width:${v/mx*100}%"></i></div></div>`).join(''):empty('এই মাসে কোনো খরচ নেই।')}</div></section>`};

pages.settlement=()=>{
  const m=state.month,r=calc(m),s=setl(m);
  const row=k=>`<div class="member-row"><div class="person"><span class="person-avatar ${k==='b'?'teal':''}">${esc(names[k].charAt(0))}</span><div>${nm(k)}<small class="sub">জমা ${yen(r.D[k])} · নিজে কিনেছে ${yen(r.O[k])} · ব্যক্তিগত (ফান্ড) ${yen(r.P[k])}</small></div></div><strong class="${r.bal[k]<0?'negative':'positive'}">${sgn(r.bal[k])}</strong></div>`;
  const hist=[...state.settlements].sort((a,b)=>b.month.localeCompare(a.month));
  const cashBtn=k=>`<button class="button ${r.cashTo===k?'primary':'outline'}" data-act="setCash" data-id="${k}" ${s?'disabled':''}>${nm(k)}</button>`;
  const whole=fundBalance();
  const cashBlock=r.legacy
    ?`<p class="sub">এই মাসটি আগের পদ্ধতিতে (অবশিষ্ট নগদ সমান ভাগে) মেটানো হয়েছিল, তাই ফলাফল অপরিবর্তিত রাখা হয়েছে। নতুন পদ্ধতিতে দেখতে "মাস আবার খুলুন" চাপুন।</p>`
    :`<div class="split-line nopad"><span>অবশিষ্ট নগদ (শেয়ার্ড ফান্ড)</span><b>${yen(r.cash)}</b></div><div class="split-line nopad"><span>নগদ পাবেন</span><b>${nm(r.cashTo)}</b></div><div class="btn-row spaced">${cashBtn('a')}${cashBtn('b')}</div>${state.cashTo[m]||s?'':`<p class="sub">স্বয়ংক্রিয়ভাবে নির্বাচিত (কম লেনদেনের জন্য)। বদলাতে অন্যজনকে চাপুন।</p>`}${whole!==r.cash?`<p class="sub">ফান্ডের মোট ব্যালান্স (সব মাস) ${yen(whole)} — এই সেটেলমেন্টে শুধু ${m} মাসের নগদ ধরা হয়েছে।</p>`:''}${r.net?`<div class="split-line nopad"><span>চূড়ান্ত নিট খরচ — ${nm('a')}</span><b>${yen(r.net.a)}</b></div><div class="split-line nopad"><span>চূড়ান্ত নিট খরচ — ${nm('b')}</span><b>${yen(r.net.b)}</b></div>`:''}`;
  app.innerHTML=head('SETTLEMENT','সেটেলমেন্ট','মাসের হিসাব মিটিয়ে নিন',monthIn())
  +`<section class="dashboard-grid"><div class="panel"><div class="panel-head"><div><h2>${m} এর হিসাব</h2><span>ব্যালান্স = জমা + নিজের পকেটের যৌথ খরচ − ব্যক্তিগত (ফান্ড) − ন্যায্য অংশ</span></div></div>${row('a')}${row('b')}
  <div class="split-line"><span>মোট যৌথ খরচ</span><b>${yen(r.J)}</b></div><div class="split-line nopad"><span>প্রত্যেকের ন্যায্য অংশ</span><b>${yen(r.share)}</b></div>${r.J%2?`<div class="split-line nopad"><span>বিজোড় ¥1 বহন করেন</span><b>${nm('b')}</b></div>`:''}${cashBlock}${r.carry?`<div class="split-line nopad"><span>আগের মাস থেকে আসা</span><b>${sgn(r.carry)}</b></div>`:''}</div>
  <div class="panel"><div class="panel-head"><div><h2>ফলাফল</h2></div>${s?`<span class="badge ${s.mode==='closed'?'green':'blue'}">${s.mode==='closed'?'মাস বন্ধ':'পরের মাসে নেওয়া হয়েছে'}</span>`:'<span class="badge gold">চলমান</span>'}</div>
  <p class="big-result">${oweText(r.diff)}</p><div class="btn-row">${s?`<button class="button outline full" data-act="reopen">মাস আবার খুলুন</button>`:`<button class="button primary full" data-act="close">মিটিয়ে মাস বন্ধ করুন</button><button class="button outline full" data-act="carry">পরের মাসে নিয়ে যান</button>`}</div>
  <p class="sub">বন্ধ করলে এই পরিমাণ মিটিয়ে ফেলা ধরা হবে। নিয়ে গেলে পরের মাসের হিসাবে যোগ হবে।</p></div></section>
  <div class="panel spaced"><div class="panel-head"><div><h2>সেটেলমেন্টের ইতিহাস</h2></div></div>${hist.length?table(['মাস','ধরন','ফলাফল','তারিখ'],hist.map(h=>`<tr><td>${h.month}</td><td><span class="badge ${h.mode==='closed'?'green':'blue'}">${h.mode==='closed'?'বন্ধ':'ক্যারি'}</span></td><td>${oweText(h.total)}</td><td>${esc((h.at||'').slice(0,10))}</td></tr>`).join('')):empty('এখনো কোনো সেটেলমেন্ট হয়নি।')}</div>`};

pages.backup=()=>{
  app.innerHTML=head('BACKUP','ডেটা ব্যাকআপ','ডেটা শুধু এই ব্রাউজারে থাকে — নিয়মিত ব্যাকআপ রাখুন')
  +`<section class="stats-grid">${card('জমা',state.deposits.length,'রেকর্ড','green','↓')}${card('খরচ',state.expenses.length,'রেকর্ড','blue','▤')}${card('সেটেলমেন্ট',state.settlements.length,'রেকর্ড','gold','◎')}${card('সংরক্ষণ',db?'IndexedDB':'অস্থায়ী','ব্রাউজার স্টোরেজ','purple','▣')}</section>
  <section class="dashboard-grid"><div class="panel"><div class="panel-head"><div><h2>এক্সপোর্ট</h2><span>নিজের কম্পিউটারে কপি সংরক্ষণ</span></div></div><div class="btn-row spaced"><button class="button primary" data-act="exportJson">ব্যাকআপ ফাইল (JSON) ডাউনলোড</button><button class="button outline" data-act="exportCsv">লেনদেন CSV ডাউনলোড</button></div></div>
  <div class="panel"><div class="panel-head"><div><h2>রিস্টোর</h2><span>JSON ব্যাকআপ থেকে ডেটা ফিরিয়ে আনুন (বর্তমান ডেটা মুছে যাবে)</span></div></div><label class="field spaced"><span>ব্যাকআপ ফাইল বাছুন</span><input id="import" type="file" accept="application/json,.json"></label></div></section>`};

pages.settings=()=>{
  app.innerHTML=head('SETTINGS','Settings','নাম ও ডেটা ব্যবস্থাপনা')
  +`<section class="dashboard-grid"><div class="panel"><div class="panel-head"><div><h2>সদস্যদের নাম</h2><span>সব পেজে এই নাম দেখাবে</span></div></div><form id="names-form" class="spaced"><label class="field"><span>প্রথম সদস্য</span><input name="a" value="${esc(names.a)}" maxlength="30" required></label><label class="field"><span>দ্বিতীয় সদস্য</span><input name="b" value="${esc(names.b)}" maxlength="30" required></label><button type="button" class="button outline" data-act="addMember">＋ সদস্য যোগ করুন</button><button class="button primary">নাম সংরক্ষণ করুন</button></form></div>
  <div class="panel"><div class="panel-head"><div><h2>ডেটা মুছুন</h2><span>সব জমা, খরচ ও সেটেলমেন্ট স্থায়ীভাবে মুছে যাবে। আগে ব্যাকআপ নিন।</span></div></div><button class="button danger-btn spaced" data-act="wipe">সব ডেটা মুছে ফেলুন</button><p class="sub">মুদ্রা: জাপানি ইয়েন (¥), পূর্ণসংখ্যা হিসাব।</p></div></section>`};

function show(){$('#top-month').textContent=state.month;pages[page]()}

/* ---------- backup helpers ---------- */
function download(name,text,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
async function wipeAll(){for(const s of ['deposits','expenses','settlements'])await clear(s);state.cashTo={};await del('meta','cashTo')}
async function importData(file){
  if(!file)return;
  try{const d=JSON.parse(await file.text());if(d.app!=='shared-fund-manager'||!Array.isArray(d.deposits)||!Array.isArray(d.expenses))throw 0;
    const ok=x=>x&&typeof x.id==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x.date)&&Number.isInteger(x.amount);
    const dep=d.deposits.filter(ok),exp=d.expenses.filter(ok),st=(d.settlements||[]).filter(x=>x&&/^\d{4}-\d{2}$/.test(x.month));
    if(!confirm(`বর্তমান ডেটা মুছে ${dep.length}টি জমা ও ${exp.length}টি খরচ ইমপোর্ট করবেন?`)){$('#import').value='';return}
    await wipeAll();for(const x of dep)await put('deposits',x);for(const x of exp)await put('expenses',x);for(const x of st)await put('settlements',x);
    if(d.names&&d.names.a&&d.names.b){Object.assign(names,{a:String(d.names.a),b:String(d.names.b)});await put('meta',{key:'names',value:{...names}})}
    if(d.cashTo&&typeof d.cashTo==='object'){const c={};for(const[k,v]of Object.entries(d.cashTo))if(/^\d{4}-\d{2}$/.test(k)&&(v==='a'||v==='b'))c[k]=v;await put('meta',{key:'cashTo',value:c})}
    await load();show();notify('ডেটা ইমপোর্ট হয়েছে')}
  catch{notify('ফাইলটি সঠিক ব্যাকআপ নয়')}}
async function settle(mode){const r=calc(state.month);if(mode==='closed'){const amount=Math.abs(r.diff);const direction=r.diff>0?nm('b')+' → '+nm('a'):r.diff<0?nm('a')+' → '+nm('b'):'কারো';const f=modal('মাস বন্ধ করার নিশ্চিতকরণ',`<div class="confirm-step"><span class="step-kicker">শেষ ধাপ</span><h3>${direction} কে টাকা দেওয়া হয়েছে?</h3><p class="sub">পরিশোধ করা সঠিক amount লিখে Next চাপুন। সঠিক amount না মিললেও আপনার দেওয়া অঙ্কই সংরক্ষণ হবে।</p>${fld('পরিশোধিত সঠিক পরিমাণ (¥)','paid', 'number', amount,'min="0" step="1" required inputmode="numeric"')}</div>`,async d=>{const paid=Number(d.paid);if(!Number.isInteger(paid)||paid<0){notify('সঠিক পরিমাণ দিন');return false}await save('settlements',{month:state.month,mode,total:r.diff,cashTo:r.cashTo,cash:r.cash,paid,at:new Date().toISOString()},'মাস বন্ধ করা হয়েছে')});const submit=f.querySelector('button.primary');if(submit)submit.textContent='Next';return f}await save('settlements',{month:state.month,mode,total:r.diff,cashTo:r.cashTo,cash:r.cash,at:new Date().toISOString()},'পরের মাসে নিয়ে যাওয়া হয়েছে')}

/* ---------- events ---------- */
const actions={
  addExpense:()=>expenseForm(),addDeposit:()=>depositForm(),
  addMember:()=>{modal('সদস্য যোগ করুন',`<p class="sub">নতুন সদস্যের নাম লিখুন। সদস্যটি জমা দেওয়ার তালিকায় যোগ হবে।</p>${fld('সদস্যের নাম','name','text','','maxlength="30" required')}`,async d=>{const name=d.name.trim();if(!name){notify('নাম লিখুন');return false}const key=Object.keys(names).find(k=>!names[k]||names[k].startsWith('নতুন সদস্য'));if(key){names[key]=name;await put('meta',{key:'names',value:{...names}});show();notify('সদস্য যোগ হয়েছে')}else notify('বর্তমানে দুই সদস্যের হিসাব চালু আছে');})},
  go:(_,b)=>document.querySelector(`[data-page="${b.dataset.arg}"]`).click(),
  edit:(id,b)=>{const x=state[b.dataset.kind].find(v=>v.id===id);if(x)b.dataset.kind==='deposits'?depositForm(x):expenseForm(x)},
  del:async(id,b)=>{if(!confirm('এই রেকর্ডটি মুছে ফেলবেন?'))return;await del(b.dataset.kind,id);await load();show();notify('মুছে ফেলা হয়েছে')},
  setCash:async k=>{if(k!=='a'&&k!=='b'||setl(state.month))return;state.cashTo[state.month]=k;await put('meta',{key:'cashTo',value:{...state.cashTo}});show();notify('নগদ প্রাপক: '+names[k])},
  close:()=>settle('closed'),carry:()=>settle('carry'),
  reopen:async()=>{await del('settlements',state.month);await load();show();notify('মাস আবার খোলা হয়েছে')},
  exportJson:()=>{download(`shared-fund-backup-${today()}.json`,JSON.stringify({app:'shared-fund-manager',version:1,exported:new Date().toISOString(),names,cashTo:state.cashTo,deposits:state.deposits,expenses:state.expenses,settlements:state.settlements},null,2),'application/json');notify('ব্যাকআপ ডাউনলোড হয়েছে')},
  exportCsv:()=>{const q=v=>`"${String(v??'').replace(/"/g,'""')}"`;
    const rows=[...withKind(state.deposits,'deposits'),...withKind(state.expenses,'expenses')].sort(byDate).map(x=>{const d=x.kind==='deposits';return [x.date,d?'deposit':'expense',d?x.note:x.shop,d?names[x.member]:x.source==='fund'?'fund':names[x.source],d?'':x.scope,x.amount,d?'':x.note].map(q).join(',')});
    download(`shared-fund-transactions-${today()}.csv`,'\ufeff'+['date,type,detail,paid_by,scope,amount_jpy,note',...rows].join('\n'),'text/csv');notify('CSV ডাউনলোড হয়েছে')},
  wipe:async()=>{if(!confirm('সব ডেটা স্থায়ীভাবে মুছে যাবে। নিশ্চিত?'))return;await wipeAll();await load();show();notify('সব ডেটা মুছে ফেলা হয়েছে')}
};
app.onclick=e=>{const b=e.target.closest('[data-act]');if(b)actions[b.dataset.act]?.(b.dataset.id,b)};
app.onchange=e=>{const t=e.target;
  if(t.id==='month'&&t.value){state.month=t.value;show()}
  else if(t.id==='ftype'){tf.type=t.value;txList()}
  else if(t.id==='fscope'){tf.scope=t.value;txList()}
  else if(t.id==='import')importData(t.files[0])};
app.oninput=e=>{if(e.target.id==='q'){tf.q=e.target.value;txList()}};
app.onsubmit=async e=>{if(e.target.id!=='names-form')return;e.preventDefault();
  const d=Object.fromEntries(new FormData(e.target));names.a=d.a.trim()||'Person A';names.b=d.b.trim()||'Person B';
  await put('meta',{key:'names',value:{...names}});show();notify('নাম সংরক্ষিত হয়েছে')};

document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('[data-page]').forEach(x=>x.classList.remove('active'));b.classList.add('active');
  page=b.dataset.page;$('#breadcrumb').textContent=b.querySelector('span').textContent.trim();
  $('.sidebar').classList.remove('open');show()});
$('.mobile-menu').onclick=()=>$('.sidebar').classList.toggle('open');
const savedTheme=localStorage.getItem('fund-theme');if(savedTheme==='light')document.body.classList.add('light-theme');$('#theme-toggle').textContent=document.body.classList.contains('light-theme')?'☾':'☼';$('#theme-toggle').onclick=()=>{const light=document.body.classList.toggle('light-theme');localStorage.setItem('fund-theme',light?'light':'dark');$('#theme-toggle').textContent=light?'☾':'☼'};
$('#date-toggle').onclick=()=>{const i=document.querySelector('#month')||$('#top-month-picker');i.value=state.month;i.focus();try{i.showPicker()}catch{}};$('#top-month-picker').onchange=e=>{if(e.target.value){state.month=e.target.value;show()}};

(async()=>{await openDB();await load();show();if(!db)notify('সতর্কতা: ব্রাউজার স্টোরেজ চালু নেই, ডেটা সেভ হবে না')})();
