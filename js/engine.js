/* Simulation engine: state, replication, DB routing/failover, request flow.
   No DOM rendering except reading inputs and writing the post id.

   Vocabulary:
   - node:   one box in the diagram, stored in `nodes` under a string key
             (e.g. "loadBalancer", "app1", "primary").
   - group:  the database nodes that hold the same data. Index 0 of a group
             is not necessarily the primary; see state.leaderIndex.
   - step:   one line of the request log, created with addStep().
   - addStep(nodeId, text, { snippet, note, error }):
       snippet: key into ALGORITHM_SNIPPETS (links the log to the hover tooltip)
       note:    explanation of the values used, shown in the tooltip
       error:   true to highlight the step in red
   - Responses are { status, body } objects.
*/

/* ---------- Simulation settings ---------- */

const BUCKET_CAPACITY = 3;
const TOKEN_REFILL_MS = 5000; // 1 token per 5 seconds
const REPLICATION_DELAY_MS = 3500;
const REPLICATION_TICK_MS = 250;
const CACHE_TTL_MS = 10000;
const CDN_TTL_MS = 30000;
const SHARD_COUNT = 2;

/* ---------- Shared state ---------- */

let currentLevel = 0;
let nodes; // { [nodeId]: { label, isUp, data, replicationQueue } }
let state; // { roundRobinIndex, readIndex, nextPostId, leaderIndex, buckets }
let dbGroups = []; // e.g. [["primary", "replica1", "replica2"]]
let features = []; // feature flags of the current level
let lastNotes = {}; // snippet key -> { who, note } from the latest request
let isBusy = false; // true while a request is being animated

const hasFeature = (name) => features.includes(name);
const isAppServer = (nodeId) => /^app\d$/.test(nodeId);
const appServerIds = () =>
  hasFeature("loadBalancer") ? ["app1", "app2", "app3"] : ["app1"];

/* ---------- Rate limiter helper ---------- */

/* Tokens a user would have right now, including time-based refill. */
function currentTokens(username) {
  const bucket = state.buckets[username];
  if (!bucket) return BUCKET_CAPACITY;
  const refilled = (Date.now() - bucket.updatedAt) / TOKEN_REFILL_MS;
  return Math.min(BUCKET_CAPACITY, bucket.tokens + refilled);
}

/* ---------- Replication ---------- */

/* Queue a change for every non-leader node in the group. */
function queueReplication(operation, postId, post, addStep, groupIndex) {
  const group = dbGroups[groupIndex];
  if (group.length < 2) return;

  const leaderId = group[state.leaderIndex[groupIndex]];
  group.forEach((nodeId) => {
    if (nodeId === leaderId) return;
    nodes[nodeId].replicationQueue.push({
      applyAt: Date.now() + REPLICATION_DELAY_MS,
      operation,
      id: postId,
      post: { ...post },
    });
  });

  addStep(
    leaderId,
    `Replication queued to ${group.length - 1} replica(s) (async, ~3.5s)`,
  );
}

/* Background tick: apply queued changes that are due on every live node. */
setInterval(() => {
  if (!hasFeature("replicas")) return;

  let changedAnything = false;
  dbGroups.flat().forEach((nodeId) => {
    const node = nodes[nodeId];
    if (!node.isUp) return;

    while (
      node.replicationQueue.length &&
      node.replicationQueue[0].applyAt <= Date.now()
    ) {
      const change = node.replicationQueue.shift();
      if (change.operation === "set") node.data[change.id] = change.post;
      else delete node.data[change.id];
      changedAnything = true;
    }
  });

  if (changedAnything && !isBusy) renderTopology();
}, REPLICATION_TICK_MS);

/* ---------- Database routing + failover ---------- */

/* Promote a live replica if the group's primary is down (needs "failover"). */
function failoverIfNeeded(groupIndex, appId, addStep) {
  const group = dbGroups[groupIndex];
  const oldLeaderId = group[state.leaderIndex[groupIndex]];
  if (!hasFeature("failover") || nodes[oldLeaderId].isUp) return;

  const newLeaderIndex = group.findIndex(
    (nodeId, i) => i !== state.leaderIndex[groupIndex] && nodes[nodeId].isUp,
  );
  if (newLeaderIndex < 0) return; // nothing to promote

  const newLeaderId = group[newLeaderIndex];
  const unreplicatedWrites = nodes[newLeaderId].replicationQueue.length;
  const dataLossNote = unreplicatedWrites
    ? ` It still had ${unreplicatedWrites} write(s) that never replicated, and those are lost.`
    : " It was fully caught up, so no writes were lost.";

  addStep(
    appId,
    `Health check failed. Promoting ${nodes[newLeaderId].label} to primary.`,
    {
      snippet: "failover",
      note: `Health check on ${nodes[oldLeaderId].label} failed, so ${nodes[newLeaderId].label} was promoted.${dataLossNote}`,
      error: true,
    },
  );

  state.leaderIndex[groupIndex] = newLeaderIndex;
  nodes[newLeaderId].replicationQueue = []; // un-replicated writes are dropped
}

/* Choose which database node handles this query. */
function pickDatabase(groupIndex, isWrite, appId, addStep) {
  failoverIfNeeded(groupIndex, appId, addStep);

  const group = dbGroups[groupIndex];
  const leaderId = group[state.leaderIndex[groupIndex]];

  if (isWrite) {
    if (group.length > 1) {
      addStep(
        appId,
        `Write goes to the primary (${nodes[leaderId].label})`,
        { snippet: "readWriteSplit", note: "query.type is WRITE, so primary." },
      );
    }
    return leaderId;
  }

  const liveReplicas = group.filter(
    (nodeId, i) => i !== state.leaderIndex[groupIndex] && nodes[nodeId].isUp,
  );
  if (liveReplicas.length) {
    const readIndex = state.readIndex++;
    const chosenId = liveReplicas[readIndex % liveReplicas.length];
    addStep(appId, `Read goes to ${nodes[chosenId].label}`, {
      snippet: "readWriteSplit",
      note: `${liveReplicas.length} live replica(s). readIdx = ${readIndex}, so live[${readIndex % liveReplicas.length}] = ${nodes[chosenId].label}.`,
    });
    return chosenId;
  }

  if (group.length > 1) {
    addStep(appId, "No replica is up. Reading from the primary.", {
      snippet: "readWriteSplit",
      note: "live.length is 0, so fall back to primary.",
      error: true,
    });
  }
  return leaderId;
}

/* ---------- Request pipeline ----------
   client -> rate limiter -> load balancer -> app server -> cache -> shard -> database
   Each stage either lets the request continue (returns null / a value)
   or ends it early with a response. */

/* Returns an error response if the request is throttled, otherwise null. */
function applyRateLimit(username, addStep) {
  if (!hasFeature("rateLimit")) return null;

  if (!nodes.rateLimiter.isUp) {
    addStep(
      "rateLimiter",
      "Rate limiter is down. Failing open: nothing is throttled.",
      { error: true },
    );
    return null;
  }

  const tokensBefore = currentTokens(username);
  const bucket = (state.buckets[username] = {
    tokens: tokensBefore,
    updatedAt: Date.now(),
  });

  if (tokensBefore < 1) {
    const secondsUntilToken = Math.ceil((1 - tokensBefore) * 5);
    addStep("rateLimiter", "429 Too Many Requests", {
      snippet: "tokenBucket",
      note: `@${username} has ${tokensBefore.toFixed(2)} tokens (needs 1), so the request is rejected. Next token in about ${secondsUntilToken}s.`,
      error: true,
    });
    return { status: 429, body: "Too many requests" };
  }

  bucket.tokens = tokensBefore - 1;
  addStep("rateLimiter", "Allowed", {
    snippet: "tokenBucket",
    note: `@${username} had ${tokensBefore.toFixed(2)} tokens, now ${bucket.tokens.toFixed(2)} (cap ${BUCKET_CAPACITY}, +1 every 5s).`,
  });
  return null;
}

/* Returns { appId } on success or { failure: response } if nobody can serve. */
function chooseAppServer(addStep) {
  const unavailable = { status: 503, body: "Service unavailable" };

  // Level 0: a single server, no load balancer.
  if (!hasFeature("loadBalancer")) {
    if (!nodes.app1.isUp) {
      addStep("app1", "App server is down. Nobody can be served.", {
        error: true,
      });
      return { failure: unavailable };
    }
    addStep("app1", "Handling request", {
      snippet: "direct",
      note: "Only one server exists, so there was no choice to make.",
    });
    return { appId: "app1" };
  }

  if (!nodes.loadBalancer.isUp) {
    addStep(
      "loadBalancer",
      "Load balancer is down. The app servers are healthy but unreachable.",
      { error: true },
    );
    return { failure: unavailable };
  }

  // Round robin, skipping servers that fail the health check.
  const serverIds = ["app1", "app2", "app3"];
  const startIndex = state.roundRobinIndex;
  const skippedLabels = [];
  let chosenId = null;

  for (let offset = 0; offset < serverIds.length; offset++) {
    const index = (startIndex + offset) % serverIds.length;
    if (nodes[serverIds[index]].isUp) {
      chosenId = serverIds[index];
      state.roundRobinIndex = (index + 1) % serverIds.length;
      break;
    }
    skippedLabels.push(nodes[serverIds[index]].label);
  }

  if (!chosenId) {
    addStep("loadBalancer", "Health check failed on all servers", {
      error: true,
    });
    return { failure: unavailable };
  }

  const skippedNote = skippedLabels.length
    ? `; ${skippedLabels.join(", ")} failed the health check and was skipped`
    : "";
  addStep("loadBalancer", `Routed to ${nodes[chosenId].label}`, {
    snippet: "roundRobin",
    note: `rrIndex was ${startIndex}${skippedNote}. Picked servers[${serverIds.indexOf(chosenId)}] = ${nodes[chosenId].label}. rrIndex is now ${state.roundRobinIndex}.`,
  });
  addStep(chosenId, "Handling request (stateless, so any server can do this)");
  return { appId: chosenId };
}

/* Cache-aside lookup. Returns a response on a hit, otherwise null. */
function readFromCache(postId, addStep) {
  if (!hasFeature("cache")) return null;

  if (!nodes.cache.isUp) {
    addStep("cache", "Cache is down. Falling back to the database.", {
      snippet: "cacheRead",
      note: "The cache is unreachable, so it counts as a miss. The database now serves every read.",
      error: true,
    });
    return null;
  }

  const entry = nodes.cache.data[postId];
  if (entry && entry.expiresAt > Date.now()) {
    const secondsLeft = Math.ceil((entry.expiresAt - Date.now()) / 1000);
    addStep("cache", `HIT post:${postId}. Database not touched.`, {
      snippet: "cacheRead",
      note: `cache.get("post:${postId}") returned the entry with ${secondsLeft}s of TTL left.`,
    });
    return { status: 200, body: entry.post };
  }

  addStep("cache", `MISS post:${postId}`, {
    snippet: "cacheRead",
    note: `cache.get("post:${postId}") returned null${entry ? " (the entry had expired)" : ""}, so we go to the database.`,
  });
  return null;
}

/* Which group of DB nodes owns this user's data? */
function chooseShard(username, appId, addStep) {
  if (!hasFeature("shard")) return 0;

  const hashValue = shardHash(username);
  const shardIndex = hashValue % SHARD_COUNT;
  addStep(appId, `Shard lookup for @${username}`, {
    snippet: "shardRouting",
    note: `hash("${username}") = ${hashValue}. ${hashValue} % ${SHARD_COUNT} = ${shardIndex}, so Shard ${shardIndex}.`,
  });
  return shardIndex;
}

/* Run the actual CRUD operation against one database node. */
function runDatabaseOperation(kind, request, dbId, groupIndex, addStep) {
  const { username, text, postId } = request;
  const db = nodes[dbId];
  const posts = db.data;

  if (kind === "create") {
    const id = state.nextPostId++;
    const post = { id, user: username, text, version: 1 };
    posts[id] = post;
    byId("pid").value = id;
    addStep(dbId, `INSERT post #${id}`);
    queueReplication("set", id, post, addStep, groupIndex);
    return { status: 201, body: post };
  }

  if (!posts[postId]) {
    const isReplica =
      dbGroups[groupIndex].length > 1 &&
      dbGroups[groupIndex][state.leaderIndex[groupIndex]] !== dbId;
    let hint = "";
    if (isReplica) hint = ". The replica may not have received it yet.";
    else if (hasFeature("shard"))
      hint = ". Routed by author, so it may live on the other shard.";

    addStep(dbId, `No post #${postId} here${hint}`, { error: true });
    return { status: 404, body: "Not found" };
  }

  if (kind === "read") {
    addStep(dbId, `SELECT post #${postId} (v${posts[postId].version})`);
    if (hasFeature("cache") && nodes.cache.isUp) {
      nodes.cache.data[postId] = {
        post: posts[postId],
        expiresAt: Date.now() + CACHE_TTL_MS,
      };
      addStep("cache", `SET post:${postId} (TTL 10s)`);
    }
    return { status: 200, body: posts[postId] };
  }

  // update or delete
  if (kind === "update") {
    posts[postId] = {
      ...posts[postId],
      text,
      version: posts[postId].version + 1,
    };
    addStep(dbId, `UPDATE post #${postId} to v${posts[postId].version}`);
    queueReplication("set", postId, posts[postId], addStep, groupIndex);
  } else {
    const deletedPost = posts[postId];
    delete posts[postId];
    addStep(dbId, `DELETE post #${postId}`);
    queueReplication("del", postId, deletedPost, addStep, groupIndex);
  }

  // Invalidate the cached copy so the next read refills it.
  if (hasFeature("cache") && nodes.cache.isUp) {
    delete nodes.cache.data[postId];
    addStep("cache", `DEL post:${postId}`, {
      snippet: "cacheInvalidate",
      note: `The row changed, so post:${postId} was deleted from the cache. The next read refills it with fresh data.`,
    });
  }

  return kind === "update"
    ? { status: 200, body: posts[postId] }
    : { status: 204, body: "deleted" };
}

/* Everything except the CDN. */
function serveRequest(kind, username, text, postId, addStep) {
  const isWrite = kind !== "read";

  const throttled = applyRateLimit(username, addStep);
  if (throttled) return throttled;

  const { appId, failure } = chooseAppServer(addStep);
  if (failure) return failure;

  if (kind === "read") {
    const cached = readFromCache(postId, addStep);
    if (cached) return cached;
  }

  const groupIndex = chooseShard(username, appId, addStep);
  const dbId = pickDatabase(groupIndex, isWrite, appId, addStep);
  if (!nodes[dbId].isUp) {
    addStep(dbId, `${nodes[dbId].label} is down`, { error: true });
    return { status: 500, body: "Database unavailable" };
  }

  return runDatabaseOperation(
    kind,
    { username, text, postId },
    dbId,
    groupIndex,
    addStep,
  );
}

/* Entry point: a request, plus the CDN image fetch that follows a successful read. */
function handleRequest(kind, username, text, postId, addStep) {
  const response = serveRequest(kind, username, text, postId, addStep);

  if (kind === "read" && response.status === 200 && hasFeature("cdn")) {
    const cdn = nodes.cdn;
    const entry = cdn.data[postId];
    const imagePath = `/media/post-${postId}.jpg`;

    if (!cdn.isUp) {
      addStep("cdn", "CDN is down. Image comes straight from the origin.", {
        snippet: "cdn",
        note: "The edge is unreachable, so every image request lands on your own servers.",
        error: true,
      });
    } else if (entry && entry.expiresAt > Date.now()) {
      const secondsLeft = Math.ceil((entry.expiresAt - Date.now()) / 1000);
      addStep("cdn", `HIT ${imagePath} served from the edge`, {
        snippet: "cdn",
        note: `The edge had the file with ${secondsLeft}s left. The origin was never contacted.`,
      });
    } else {
      addStep("cdn", `MISS ${imagePath}. Fetching from the origin.`, {
        snippet: "cdn",
        note: `Not at the edge${entry ? " (expired)" : ""}, so it was fetched from the origin and kept for 30s.`,
      });
      cdn.data[postId] = { expiresAt: Date.now() + CDN_TTL_MS };
    }
  }

  return response;
}