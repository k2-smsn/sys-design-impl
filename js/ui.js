/* UI layer: level switching, topology rendering, kill/restore, request playback, hover tooltip, event wiring. */
const tipKeys=k=>k=='lb'?['rr']:k=='rl'?['bucket']:k=='cdn'?['cdn']:k=='cache'?['cacheRead','inval']:/^a\d$/.test(k)?(!has('lb')?['direct']:[has('shard')&&'shard',has('rep')&&'rw',has('fo')&&'failover'].filter(Boolean)):[];

function init(l){
 lv=l;F=LEVELS[l].f;S={rr:0,ri:0,next:1,lead:[0,0],bk:{}};LAST={};
 const n=label=>({label,up:true,data:{},q:[]});
 N={client:n('Client')};
 if(has('cdn'))N.cdn=n('CDN edge');
 if(has('rl'))N.rl=n('Rate limiter');
 if(has('lb')){N.lb=n('Load balancer');N.a1=n('app-1');N.a2=n('app-2');N.a3=n('app-3')}else N.a1=n('App server');
 if(has('cache'))N.cache=n('Cache (Redis)');
 G=has('shard')?(has('rep')?[['s0p','s0r'],['s1p','s1r']]:[['s0'],['s1']]):has('rep')?[['p','r1','r2']]:[['db']];
 G.flat().forEach(k=>N[k]=n(D[k]));
 $('pid').value=1;
 $('log').innerHTML='<span class="mute">Press a button to send a request.</span>';$('res').innerHTML='';
 const L=LEVELS[l];
 $('topobox').style.display=L.intro?'none':'';
 $('story').innerHTML=L.intro?L.html:'<h2>L'+(l-1)+': '+L.t+'</h2> <span class="tag">'+L.c+'</span><div class="sg"><p>'+L.p+'</p><p class="note"><b>Try this:</b> '+L.try+'</p></div>';
 $('lv').innerHTML=LEVELS.map((x,i)=>'<button class="'+(i==l?'on':'')+'" title="'+x.t+'" onclick="init('+i+')">'+(i?'<b>'+(i-1)+'</b>':'')+SHORT[i]+'</button>').join('');
 render();
}

function sub(k){
 const x=N[k];if(!x.up)return 'down, click to restore';
 if(k=='client')return 'browser';
 if(k=='lb')return 'up, rrIndex '+S.rr;
 if(k=='rl'){const u=$('user').value;return 'up, @'+u+': '+tokens(u).toFixed(1)+' tokens'}
 if(k=='cdn')return 'up, '+Object.keys(x.data).length+' images';
 if(k=='cache')return 'up, '+Object.keys(x.data).length+' keys';
 if(/^a\d$/.test(k))return 'up, stateless';
 const gi=G.findIndex(g=>g.includes(k)),role=G[gi].length>1?(G[gi][S.lead[gi]]==k?'primary, ':'replica, '):'';
 return 'up, '+role+Object.keys(x.data).length+' posts'+(x.q.length?', '+x.q.length+' pending':'');
}
function render(){
 hideTip();
 const tiers=[['client'],has('cdn')?['cdn']:0,has('rl')?['rl']:0,has('lb')?['lb']:0,apps(),has('cache')?['cache']:0,G.flat()].filter(Boolean);
 $('topo').innerHTML=tiers.map(t=>'<div class="tier">'+t.map(k=>'<button class="node '+(tipKeys(k).length?'has ':'')+(k=='client'?'client ':'')+(N[k].up?'':'down')+'" id="n-'+k+'" '+(k=='client'?'tabindex="-1"':'onclick="tog(\''+k+'\')"')+'><b>'+N[k].label+'</b><span>'+sub(k)+'</span></button>').join('')+'</div>').join('<span class="arr">&rsaquo;</span>');
}
function tog(k){
 const x=N[k];x.up=!x.up;
 if((k=='cache'||k=='cdn')&&!x.up)x.data={};
 if(x.up&&has('fo')){const gi=G.findIndex(g=>g.includes(k));
  if(gi>=0&&G[gi][S.lead[gi]]!=k){x.data={...N[G[gi][S.lead[gi]]].data};x.q=[]}}
 render();
 $('log').innerHTML='<div class="ln sys"><i>'+x.label+'</i>'+(x.up?'restored':'taken down')+'</div>';
}

$('user').onchange=()=>render();

async function op(kind){
 if(busy)return;busy=true;
 document.querySelectorAll('.op').forEach(b=>b.disabled=true);
 const user=$('user').value,text=$('txt').value.trim()||'hello world',pid=+$('pid').value||1,st=[];
 const P=(n,t,s,note,bad)=>st.push({n,t,s,note,bad});
 const path={create:'POST /posts',read:'GET /posts/'+pid,update:'PUT /posts/'+pid,delete:'DELETE /posts/'+pid}[kind];
 P('client',path+' as @'+user);
 const [code,body]=flow(kind,user,text,pid,P);
 $('log').innerHTML='';$('res').innerHTML='';
 for(const s of st){
  const el=$('n-'+s.n);if(el){el.classList.add(s.bad?'bad':'hot')}
  $('log').insertAdjacentHTML('beforeend','<div class="ln '+(s.bad?'bad':'')+'"><i>'+N[s.n].label+'</i>'+esc(s.t)+'</div>');
  await sleep(420);
  if(el)el.classList.remove('hot','bad');
  if(s.s)LAST[s.s]={who:N[s.n].label,note:s.note};
 }
 $('res').innerHTML='<div class="res '+(code<400?'ok':'bad')+'">'+code+' '+esc(typeof body=='string'?body:JSON.stringify(body))+'</div>';
 busy=false;document.querySelectorAll('.op').forEach(b=>b.disabled=false);render();
}
document.querySelectorAll('.op[data-o]').forEach(b=>b.onclick=()=>op(b.dataset.o));
$('reset').onclick=()=>{if(!busy)init(lv)};
$('user').innerHTML=USERS.map(u=>'<option>'+u+'</option>').join('');
const tip=document.createElement('div');tip.id='tip';tip.setAttribute('role','tooltip');document.body.appendChild(tip);
let hideT;
function hideTip(){clearTimeout(hideT);tip.style.display='none'}
function leaveTip(){clearTimeout(hideT);hideT=setTimeout(hideTip,250)}
tip.addEventListener('mouseenter',()=>clearTimeout(hideT));tip.addEventListener('mouseleave',leaveTip);
function showTip(e){
 clearTimeout(hideT);
 const b=e.target.closest&&e.target.closest('.node');if(!b)return;
 const ks=tipKeys(b.id.slice(2));if(!ks.length)return hideTip();
 tip.innerHTML=ks.map(k=>{const x=SN[k],l=LAST[k];return '<h4>'+x[0]+'</h4><pre>'+esc(x[1])+'</pre>'+(l?'<p class="note"><b>Last request ('+esc(l.who)+'):</b> '+esc(l.note)+'</p>':'<p class="mute">Send a request to see the values it used.</p>')}).join('');
 tip.style.display='block';
 const r=b.getBoundingClientRect(),w=tip.offsetWidth,h=tip.offsetHeight;
 let x=Math.max(8,Math.min(r.left,innerWidth-w-8)),y=r.bottom+10;
 if(y+h>innerHeight-8)y=Math.max(8,r.top-h-10);
 tip.style.left=x+'px';tip.style.top=y+'px';
}
const TP=$('topo');['mouseover','focusin'].forEach(v=>TP.addEventListener(v,showTip));['mouseout','focusout'].forEach(v=>TP.addEventListener(v,leaveTip));
init(0);
