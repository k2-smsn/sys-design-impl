/* Content only: level definitions (feature flags + text), node labels,
   and the algorithm snippets shown when hovering a node.

   Feature flags a level can turn on:
     loadBalancer, rateLimit, replicas, failover, cache, shard, cdn
*/

const LEVELS = [
  {
    isIntro: true,
    title: "Welcome",
    concept: "About this site",
    features: [],
    html: `
      <h2>Welcome</h2> <span class="tag">About this site</span>
      <div class="sg">
        <div>
          <h4>Why this exists</h4>
          <p>I mostly build small self projects, and system design concepts like load balancers, replicas and sharding only really matter on big enterprise systems. I can't practice them on a real project, so I made this to apply them in the one way I can.</p>
          <p>It follows a single mini Blog site where users create, read, update and delete posts. Each level pretends the app got more popular, shows the problem that creates, and adds the concept that fixes it. It's a reviewer for quick revision, not a full course.</p>
        </div>
        <div>
          <h4>How to use it</h4>
          <p><b>Pick a level</b> from the tabs above. Each one builds on a growing app.</p>
          <p><b>Send requests</b> with the Create, Read, Update and Delete buttons and follow the path in the Output.</p>
          <p><b>Break things</b> by clicking any box to take it down, then send another request.</p>
          <p><b>See the algorithm</b> by hovering a box with a { } badge.</p>
        </div>
      </div>
      <p style="text-align:center;margin-top:12px"><button class="op" onclick="startLevel(1)">Start at Level 0</button></p>`,
  },
  {
    title: "One server, one database",
    concept: "Single point of failure",
    features: [],
    problem:
      "Day one: 50 users. The app server talks straight to the database. Simple and cheap, but if either box dies, the whole site is gone.",
    tryThis:
      "Create a post, then read it. Now click the app server to take it down and try again.",
  },
  {
    title: "Load balancer + app servers",
    concept: "Horizontal scaling, health checks",
    features: ["loadBalancer"],
    problem:
      "A viral blog post pushes one server to its CPU limit. Run 3 identical stateless app servers behind a load balancer that spreads requests and skips dead servers.",
    tryThis:
      "Press Read six times and watch the round-robin index move. Take down app-2: the health check skips it. Then take down the load balancer to see that you only moved the single point of failure.",
  },
  {
    title: "Rate limiting",
    concept: "Token bucket, 429 Too Many Requests",
    features: ["loadBalancer", "rateLimit"],
    problem:
      "A bot hammers the API and starves real users. A rate limiter gives each user a bucket of 3 tokens that refills 1 token every 5 seconds. Every request costs one token.",
    tryThis:
      "Press Read several times quickly: the bucket drains and you get a 429. Wait a few seconds and a token returns. Switch author: each user has their own bucket. Take the limiter down: it fails open and nothing is throttled.",
  },
  {
    title: "Read replicas",
    concept: "Primary/replica replication, replication lag",
    features: ["loadBalancer", "replicas"],
    problem:
      "People read the feed about 100 times for every post they write, and the one database is now the bottleneck. Writes go to a primary; reads are spread across replicas that copy the primary asynchronously.",
    tryThis:
      "Create a post and read it right away: the replicas have not caught up yet (about 3.5s lag). Wait and read again. Then take down the primary: reads keep working, writes fail.",
  },
  {
    title: "Database failover",
    concept: "Health checks, promotion, data loss window",
    features: ["loadBalancer", "replicas", "failover"],
    problem:
      "The primary is still a single point of failure for writes. Now a failed health check on the primary is caught on the next request and a live replica is promoted to take over.",
    tryThis:
      "Create a post, then right away take the primary down and Create again: a replica is promoted and writes resume. The post made in the last ~3.5s may be gone, because it never replicated. Restore the old primary: it rejoins as a replica.",
  },
  {
    title: "Caching",
    concept: "Cache-aside, TTL, invalidation",
    features: ["loadBalancer", "cache"],
    problem:
      "A few viral posts are read thousands of times and the database repeats the same query every time. Keep hot posts in an in-memory cache and only go to the database on a miss.",
    tryThis:
      "Read the same id twice: miss, then hit. Update it and read again: the entry was invalidated. Wait 10s for the TTL to expire. Take the cache down: the database takes the full load.",
  },
  {
    title: "Sharding",
    concept: "Horizontal partitioning, shard keys",
    features: ["loadBalancer", "cache", "shard"],
    problem:
      "The data no longer fits on one machine and write volume has hit its limit. Split posts across two database shards using the author as the shard key. (Each shard would normally have its own replicas.)",
    tryThis:
      "Create posts as alice, bob, carol, dave and see which shard each one lands on. Take down Shard 1: only users routed to it fail. Reading as the wrong author gives a 404, because routing is by author. Real systems put the shard id inside the post id.",
  },
  {
    title: "CDN",
    concept: "Edge caching, origin offload",
    features: ["loadBalancer", "cdn"],
    problem:
      "Posts now carry images, and serving them from your own servers is slow and expensive. A CDN keeps copies at edge locations close to users and only goes to the origin on a miss.",
    tryThis:
      "Read a post twice: the first image request misses and goes to the origin, the second is served by the edge. Wait 30s for the copy to expire. Take the CDN down: images fall back to the origin.",
  },
  {
    title: "Combined: everything together",
    concept: "The full architecture",
    features: ["cdn", "rateLimit", "loadBalancer", "cache", "shard", "replicas", "failover"],
    problem:
      "All the pieces at once: CDN for images, rate limiter, load balancer, stateless apps, cache, and two shards that each have a primary and a replica with automatic failover.",
    tryThis:
      "Create as alice and bob (different shards), then read each twice. Kill a shard primary and Create again to see failover on just that shard. Kill the cache, a server and the CDN, and see which requests still succeed.",
  },
];

/* Tab labels, one per level (same order as LEVELS). */
const TAB_LABELS = [
  "Intro",
  "Single server",
  "Load balancer",
  "Rate limit",
  "Replicas",
  "Failover",
  "Cache",
  "Sharding",
  "CDN",
  "Combined",
];

/* Display names for the database nodes. */
const DB_LABELS = {
  db: "Database",
  primary: "Primary DB",
  replica1: "Replica 1",
  replica2: "Replica 2",
  shard0: "Shard 0",
  shard1: "Shard 1",
  shard0Primary: "S0 primary",
  shard0Replica: "S0 replica",
  shard1Primary: "S1 primary",
  shard1Replica: "S1 replica",
};

/* Code shown in the hover tooltip. Keys are referenced by the engine
   (as a step's `snippet`) and by snippetKeysForNode() in ui.js. */
const ALGORITHM_SNIPPETS = {
  direct: {
    title: "One server, no routing decision",
    code: `app.listen(3000);
// Every client talks to this one process.
// Nothing to choose, and nothing to fall back on.`,
  },
  roundRobin: {
    title: "Load balancer: round robin + health check",
    code: `function pickServer(servers) {
  for (let i = 0; i < servers.length; i++) {
    const idx = (rrIndex + i) % servers.length;
    if (servers[idx].healthy) {       // health check
      rrIndex = (idx + 1) % servers.length;
      return servers[idx];
    }
  }
  return null; // all down -> 503
}`,
  },
  tokenBucket: {
    title: "Rate limiter: token bucket",
    code: `function allow(userId) {
  const b = buckets[userId] ?? { tokens: 3, last: now() };
  b.tokens = Math.min(3, b.tokens + (now() - b.last) / 5000); // +1 per 5s
  b.last = now();
  if (b.tokens < 1) return false;   // respond 429
  b.tokens -= 1;                    // each request costs one token
  return true;
}`,
  },
  readWriteSplit: {
    title: "Read/write splitting",
    code: `function route(query) {
  if (query.type === 'WRITE') return primary;  // one source of truth
  const live = replicas.filter(r => r.healthy);
  if (live.length === 0) return primary;       // fallback
  return live[readIdx++ % live.length];        // spread reads
}`,
  },
  failover: {
    title: "Failover: promote a replica",
    code: `function failover(group) {
  if (group.primary.healthy) return;               // health check ok
  const next = group.replicas.find(r => r.healthy);
  if (!next) throw new Error('nothing to promote');
  group.replicas = group.replicas.filter(r => r !== next);
  group.replicas.push(group.primary);              // old primary rejoins later
  group.primary = next;                            // promote
}`,
  },
  cacheRead: {
    title: "Cache-aside read",
    code: `async function getPost(id) {
  const hit = await cache.get('post:' + id);
  if (hit) return hit;                // fast path
  const row = await db.find(id);      // slow path
  if (row) await cache.set('post:' + id, row, { ttl: 10 });
  return row;
}`,
  },
  cacheInvalidate: {
    title: "Cache invalidation on write",
    code: `async function updatePost(id, text) {
  await db.update(id, text);
  await cache.del('post:' + id);  // next read refills it
}`,
  },
  shardRouting: {
    title: "Shard routing by author",
    code: `function pickShard(userId) {
  let h = 0;
  for (const ch of userId) h += ch.charCodeAt(0);
  return shards[h % shards.length];  // same author, same shard
}`,
  },
  cdn: {
    title: "CDN edge lookup",
    code: `async function getImage(path) {
  const hit = edge.get(path);
  if (hit && hit.expires > now()) return hit.body;  // served at the edge
  const body = await origin.fetch(path);            // slow path
  edge.set(path, { body, expires: now() + 30000 }); // keep for 30s
  return body;
}`,
  },
};