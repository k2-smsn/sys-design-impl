/* Content only: level definitions (feature flags + text), node labels, algorithm snippets shown on hover. */
const LEVELS=[
 {intro:true,t:'Welcome',c:'About this site',f:[],html:`<h2>Welcome</h2> <span class="tag">About this site</span><div class="sg"><div><h4>Why this exists</h4><p>I mostly build small self projects, and system design concepts like load balancers, replicas and sharding only really matter on big enterprise systems. I can't practice them on a real project, so I made this to apply them in the one way I can.</p><p>It follows a single mini Twitter clone where users create, read, update and delete posts. Each level pretends the app got more popular, shows the problem that creates, and adds the concept that fixes it. It's a reviewer for quick revision, not a full course.</p></div><div><h4>How to use it</h4><p><b>Pick a level</b> from the tabs above. Each one builds on a growing app.</p><p><b>Send requests</b> with the Create, Read, Update and Delete buttons and follow the path in the Output.</p><p><b>Break things</b> by clicking any box to take it down, then send another request.</p><p><b>See the algorithm</b> by hovering a box with a { } badge.</p></div></div><p style="text-align:center;margin-top:12px"><button class="op" onclick="init(1)">Start at Level 0</button></p>`},
 {t:'One server, one database',c:'Single point of failure',f:[],
  p:'Day one: 50 users. The app server talks straight to the database. Simple and cheap, but if either box dies, the whole site is gone.',
  try:'Create a post, then read it. Now click the app server to take it down and try again.'},
 {t:'Load balancer + app servers',c:'Horizontal scaling, health checks',f:['lb'],
  p:'A viral tweet pushes one server to its CPU limit. Run 3 identical stateless app servers behind a load balancer that spreads requests and skips dead servers.',
  try:'Press Read six times and watch the round-robin index move. Take down app-2: the health check skips it. Then take down the load balancer to see that you only moved the single point of failure.'},
 {t:'Rate limiting',c:'Token bucket, 429 Too Many Requests',f:['lb','rl'],
  p:'A bot hammers the API and starves real users. A rate limiter gives each user a bucket of 3 tokens that refills 1 token every 5 seconds. Every request costs one token.',
  try:'Press Read several times quickly: the bucket drains and you get a 429. Wait a few seconds and a token returns. Switch author: each user has their own bucket. Take the limiter down: it fails open and nothing is throttled.'},
 {t:'Read replicas',c:'Primary/replica replication, replication lag',f:['lb','rep'],
  p:'People read the feed about 100 times for every post they write, and the one database is now the bottleneck. Writes go to a primary; reads are spread across replicas that copy the primary asynchronously.',
  try:'Create a post and read it right away: the replicas have not caught up yet (about 3.5s lag). Wait and read again. Then take down the primary: reads keep working, writes fail.'},
 {t:'Database failover',c:'Health checks, promotion, data loss window',f:['lb','rep','fo'],
  p:'The primary is still a single point of failure for writes. Now a failed health check on the primary is caught on the next request and a live replica is promoted to take over.',
  try:'Create a post, then right away take the primary down and Create again: a replica is promoted and writes resume. The post made in the last ~3.5s may be gone, because it never replicated. Restore the old primary: it rejoins as a replica.'},
 {t:'Caching',c:'Cache-aside, TTL, invalidation',f:['lb','cache'],
  p:'A few viral posts are read thousands of times and the database repeats the same query every time. Keep hot posts in an in-memory cache and only go to the database on a miss.',
  try:'Read the same id twice: miss, then hit. Update it and read again: the entry was invalidated. Wait 10s for the TTL to expire. Take the cache down: the database takes the full load.'},
 {t:'Sharding',c:'Horizontal partitioning, shard keys',f:['lb','cache','shard'],
  p:'The data no longer fits on one machine and write volume has hit its limit. Split posts across two database shards using the author as the shard key. (Each shard would normally have its own replicas.)',
  try:'Create posts as alice, bob, carol, dave and see which shard each one lands on. Take down Shard 1: only users routed to it fail. Reading as the wrong author gives a 404, because routing is by author. Real systems put the shard id inside the post id.'},
 {t:'CDN',c:'Edge caching, origin offload',f:['lb','cdn'],
  p:'Posts now carry images, and serving them from your own servers is slow and expensive. A CDN keeps copies at edge locations close to users and only goes to the origin on a miss.',
  try:'Read a post twice: the first image request misses and goes to the origin, the second is served by the edge. Wait 30s for the copy to expire. Take the CDN down: images fall back to the origin.'},
 {t:'Combined: everything together',c:'The full architecture',f:['cdn','rl','lb','cache','shard','rep','fo'],
  p:'All the pieces at once: CDN for images, rate limiter, load balancer, stateless apps, cache, and two shards that each have a primary and a replica with automatic failover.',
  try:'Create as alice and bob (different shards), then read each twice. Kill a shard primary and Create again to see failover on just that shard. Kill the cache, a server and the CDN, and see which requests still succeed.'}
];
const SHORT=['Intro','Single server','Load balancer','Rate limit','Replicas','Failover','Cache','Sharding','CDN','Combined'];
const D={db:'Database',p:'Primary DB',r1:'Replica 1',r2:'Replica 2',s0:'Shard 0',s1:'Shard 1',s0p:'S0 primary',s0r:'S0 replica',s1p:'S1 primary',s1r:'S1 replica'};
const SN={
 direct:['One server, no routing decision',
`app.listen(3000);
// Every client talks to this one process.
// Nothing to choose, and nothing to fall back on.`],
 rr:['Load balancer: round robin + health check',
`function pickServer(servers) {
  for (let i = 0; i < servers.length; i++) {
    const idx = (rrIndex + i) % servers.length;
    if (servers[idx].healthy) {       // health check
      rrIndex = (idx + 1) % servers.length;
      return servers[idx];
    }
  }
  return null; // all down -> 503
}`],
 bucket:['Rate limiter: token bucket',
`function allow(userId) {
  const b = buckets[userId] ?? { tokens: 3, last: now() };
  b.tokens = Math.min(3, b.tokens + (now() - b.last) / 5000); // +1 per 5s
  b.last = now();
  if (b.tokens < 1) return false;   // respond 429
  b.tokens -= 1;                    // each request costs one token
  return true;
}`],
 rw:['Read/write splitting',
`function route(query) {
  if (query.type === 'WRITE') return primary;  // one source of truth
  const live = replicas.filter(r => r.healthy);
  if (live.length === 0) return primary;       // fallback
  return live[readIdx++ % live.length];        // spread reads
}`],
 failover:['Failover: promote a replica',
`function failover(group) {
  if (group.primary.healthy) return;               // health check ok
  const next = group.replicas.find(r => r.healthy);
  if (!next) throw new Error('nothing to promote');
  group.replicas = group.replicas.filter(r => r !== next);
  group.replicas.push(group.primary);              // old primary rejoins later
  group.primary = next;                            // promote
}`],
 cacheRead:['Cache-aside read',
`async function getPost(id) {
  const hit = await cache.get('post:' + id);
  if (hit) return hit;                // fast path
  const row = await db.find(id);      // slow path
  if (row) await cache.set('post:' + id, row, { ttl: 10 });
  return row;
}`],
 inval:['Cache invalidation on write',
`async function updatePost(id, text) {
  await db.update(id, text);
  await cache.del('post:' + id);  // next read refills it
}`],
 shard:['Shard routing by author',
`function pickShard(userId) {
  let h = 0;
  for (const ch of userId) h += ch.charCodeAt(0);
  return shards[h % shards.length];  // same author, same shard
}`],
 cdn:['CDN edge lookup',
`async function getImage(path) {
  const hit = edge.get(path);
  if (hit && hit.expires > now()) return hit.body;  // served at the edge
  const body = await origin.fetch(path);            // slow path
  edge.set(path, { body, expires: now() + 30000 }); // keep for 30s
  return body;
}`]
};
