/* Simulation engine: state, replication, DB routing/failover, request flow. No DOM rendering except reading inputs and writing the post id. */
let lv=0,N,S,G=[],F=[],LAST={},busy=false;
const has=f=>F.includes(f);
const CAP=3,REFILL=5000;
const tokens=u=>{const b=S.bk[u];return b?Math.min(CAP,b.t+(Date.now()-b.at)/REFILL):CAP};
const apps=()=>has('lb')?['a1','a2','a3']:['a1'];
function repl(op,id,post,P,gi){
 const g=G[gi];if(g.length<2)return;const lead=g[S.lead[gi]];
 g.forEach(k=>{if(k!=lead)N[k].q.push({at:Date.now()+3500,op,id,post:{...post}})});
 P(lead,'Replication queued to '+(g.length-1)+' replica(s) (async, ~3.5s)');
}
setInterval(()=>{
 if(!has('rep'))return;let ch=false;
 G.flat().forEach(k=>{const x=N[k];if(!x.up)return;
  while(x.q.length&&x.q[0].at<=Date.now()){const e=x.q.shift();e.op=='set'?x.data[e.id]=e.post:delete x.data[e.id];ch=true}});
 if(ch&&!busy)render();
},250);

function dbPick(gi,w,app,P){
 const g=G[gi];let lead=g[S.lead[gi]];
 if(has('fo')&&!N[lead].up){
  const ni=g.findIndex((k,i)=>i!=S.lead[gi]&&N[k].up);
  if(ni>=0){const nk=g[ni],lost=N[nk].q.length;
   P(app,'Health check failed. Promoting '+N[nk].label+' to primary.','failover','Health check on '+N[lead].label+' failed, so '+N[nk].label+' was promoted.'+(lost?' It still had '+lost+' write(s) that never replicated, and those are lost.':' It was fully caught up, so no writes were lost.'),1);
   S.lead[gi]=ni;N[nk].q=[];lead=nk}
 }
 if(w){if(g.length>1)P(app,'Write goes to the primary ('+N[lead].label+')','rw','query.type is WRITE, so primary.');return lead}
 const reps=g.filter((k,i)=>i!=S.lead[gi]&&N[k].up);
 if(reps.length){const i=S.ri++,k=reps[i%reps.length];P(app,'Read goes to '+N[k].label,'rw',reps.length+' live replica(s). readIdx = '+i+', so live['+i%reps.length+'] = '+N[k].label+'.');return k}
 if(g.length>1)P(app,'No replica is up. Reading from the primary.','rw','live.length is 0, so fall back to primary.',1);
 return lead;
}

function flow0(kind,user,text,pid,P){
 const w=kind!='read';let app;
 if(has('rl')){
  if(!N.rl.up)P('rl','Rate limiter is down. Failing open: nothing is throttled.',0,0,1);
  else{const t0=tokens(user),b=S.bk[user]={t:t0,at:Date.now()};
   if(t0<1){P('rl','429 Too Many Requests','bucket','@'+user+' has '+t0.toFixed(2)+' tokens (needs 1), so the request is rejected. Next token in about '+Math.ceil((1-t0)*5)+'s.',1);return[429,'Too many requests']}
   b.t=t0-1;P('rl','Allowed','bucket','@'+user+' had '+t0.toFixed(2)+' tokens, now '+b.t.toFixed(2)+' (cap '+CAP+', +1 every 5s).')}
 }
 if(!has('lb')){
  if(!N.a1.up){P('a1','App server is down. Nobody can be served.',0,0,1);return[503,'Service unavailable']}
  app='a1';P('a1','Handling request','direct','Only one server exists, so there was no choice to make.');
 }else{
  if(!N.lb.up){P('lb','Load balancer is down. The app servers are healthy but unreachable.',0,0,1);return[503,'Service unavailable']}
  const ids=['a1','a2','a3'],skip=[],start=S.rr;
  for(let i=0;i<3;i++){const x=(start+i)%3;if(N[ids[x]].up){app=ids[x];S.rr=(x+1)%3;break}skip.push(N[ids[x]].label)}
  if(!app){P('lb','Health check failed on all servers',0,0,1);return[503,'Service unavailable']}
  P('lb','Routed to '+N[app].label,'rr','rrIndex was '+start+(skip.length?'; '+skip.join(', ')+' failed the health check and was skipped':'')+'. Picked servers['+ids.indexOf(app)+'] = '+N[app].label+'. rrIndex is now '+S.rr+'.');
  P(app,'Handling request (stateless, so any server can do this)');
 }
 if(has('cache')&&kind=='read'){
  if(N.cache.up){
   const e=N.cache.data[pid];
   if(e&&e.exp>Date.now()){P('cache','HIT post:'+pid+'. Database not touched.','cacheRead','cache.get("post:'+pid+'") returned the entry with '+Math.ceil((e.exp-Date.now())/1000)+'s of TTL left.');return[200,e.post]}
   P('cache','MISS post:'+pid,'cacheRead','cache.get("post:'+pid+'") returned null'+(e?' (the entry had expired)':'')+', so we go to the database.');
  }else P('cache','Cache is down. Falling back to the database.','cacheRead','The cache is unreachable, so it counts as a miss. The database now serves every read.',1);
 }
 let gi=0;
 if(has('shard')){const h=hash(user);gi=h%2;P(app,'Shard lookup for @'+user,'shard','hash("'+user+'") = '+h+'. '+h+' % 2 = '+gi+', so Shard '+gi+'.')}
 const k=dbPick(gi,w,app,P);
 if(!N[k].up){P(k,N[k].label+' is down',0,0,1);return[500,'Database unavailable']}
 const d=N[k].data;
 if(kind=='create'){
  const id=S.next++,post={id,user,text,v:1};d[id]=post;$('pid').value=id;
  P(k,'INSERT post #'+id);repl('set',id,post,P,gi);return[201,post];
 }
 if(!d[pid]){P(k,'No post #'+pid+' here'+(G[gi].length>1&&G[gi][S.lead[gi]]!=k?'. The replica may not have received it yet.':has('shard')?'. Routed by author, so it may live on the other shard.':''),0,0,1);return[404,'Not found']}
 if(kind=='read'){
  P(k,'SELECT post #'+pid+' (v'+d[pid].v+')');
  if(has('cache')&&N.cache.up){N.cache.data[pid]={post:d[pid],exp:Date.now()+10000};P('cache','SET post:'+pid+' (TTL 10s)')}
  return[200,d[pid]];
 }
 if(kind=='update'){d[pid]={...d[pid],text,v:d[pid].v+1};P(k,'UPDATE post #'+pid+' to v'+d[pid].v);repl('set',pid,d[pid],P,gi)}
 else{const post=d[pid];delete d[pid];P(k,'DELETE post #'+pid);repl('del',pid,post,P,gi)}
 if(has('cache')&&N.cache.up){delete N.cache.data[pid];P('cache','DEL post:'+pid,'inval','The row changed, so post:'+pid+' was deleted from the cache. The next read refills it with fresh data.')}
 return[kind=='update'?200:204,kind=='update'?d[pid]:'deleted'];
}
function flow(kind,user,text,pid,P){
 const r=flow0(kind,user,text,pid,P);
 if(kind=='read'&&r[0]==200&&has('cdn')){
  const c=N.cdn,e=c.data[pid],f='/media/post-'+pid+'.jpg';
  if(!c.up)P('cdn','CDN is down. Image comes straight from the origin.','cdn','The edge is unreachable, so every image request lands on your own servers.',1);
  else if(e&&e.exp>Date.now())P('cdn','HIT '+f+' served from the edge','cdn','The edge had the file with '+Math.ceil((e.exp-Date.now())/1000)+'s left. The origin was never contacted.');
  else{P('cdn','MISS '+f+'. Fetching from the origin.','cdn','Not at the edge'+(e?' (expired)':'')+', so it was fetched from the origin and kept for 30s.');c.data[pid]={exp:Date.now()+30000}}
 }
 return r;
}
