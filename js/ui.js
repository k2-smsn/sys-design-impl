/* UI layer: level switching, topology rendering, kill/restore,
   request playback, hover tooltip, event wiring. */

const STEP_DELAY_MS = 420; // pause between animated steps

/* ---------- Which algorithm snippets does a node show on hover? ---------- */

function snippetKeysForNode(nodeId) {
  if (nodeId === "loadBalancer") return ["roundRobin"];
  if (nodeId === "rateLimiter") return ["tokenBucket"];
  if (nodeId === "cdn") return ["cdn"];
  if (nodeId === "cache") return ["cacheRead", "cacheInvalidate"];

  if (isAppServer(nodeId)) {
    if (!hasFeature("loadBalancer")) return ["direct"];
    const keys = [];
    if (hasFeature("shard")) keys.push("shardRouting");
    if (hasFeature("replicas")) keys.push("readWriteSplit");
    if (hasFeature("failover")) keys.push("failover");
    return keys;
  }
  return [];
}

/* ---------- Level setup ---------- */

function createNode(label) {
  return { label, isUp: true, data: {}, replicationQueue: [] };
}

function buildNodes() {
  nodes = { client: createNode("Client") };

  if (hasFeature("cdn")) nodes.cdn = createNode("CDN edge");
  if (hasFeature("rateLimit")) nodes.rateLimiter = createNode("Rate limiter");

  if (hasFeature("loadBalancer")) {
    nodes.loadBalancer = createNode("Load balancer");
    nodes.app1 = createNode("app-1");
    nodes.app2 = createNode("app-2");
    nodes.app3 = createNode("app-3");
  } else {
    nodes.app1 = createNode("App server");
  }

  if (hasFeature("cache")) nodes.cache = createNode("Cache (Redis)");

  if (hasFeature("shard")) {
    dbGroups = hasFeature("replicas")
      ? [["shard0Primary", "shard0Replica"], ["shard1Primary", "shard1Replica"]]
      : [["shard0"], ["shard1"]];
  } else if (hasFeature("replicas")) {
    dbGroups = [["primary", "replica1", "replica2"]];
  } else {
    dbGroups = [["db"]];
  }
  dbGroups.flat().forEach((id) => (nodes[id] = createNode(DB_LABELS[id])));
}

function renderStory(level) {
  const storyBox = byId("story");
  if (level.isIntro) {
    storyBox.innerHTML = level.html;
    return;
  }
  storyBox.innerHTML = `
    <h2>L${currentLevel - 1}: ${level.title}</h2> <span class="tag">${level.concept}</span>
    <div class="sg">
      <p>${level.problem}</p>
      <p class="note"><b>Try this:</b> ${level.tryThis}</p>
    </div>`;
}

function renderLevelTabs() {
  byId("lv").innerHTML = LEVELS.map((level, index) => {
    const levelNumber = index ? `<b>${index - 1}</b>` : "";
    const activeClass = index === currentLevel ? "on" : "";
    return `<button class="${activeClass}" title="${level.title}" onclick="startLevel(${index})">${levelNumber}${TAB_LABELS[index]}</button>`;
  }).join("");
}

/* Switch to a level and reset everything. (Called from inline onclick handlers.) */
function startLevel(levelIndex) {
  currentLevel = levelIndex;
  const level = LEVELS[levelIndex];
  features = level.features;

  state = {
    roundRobinIndex: 0, // next server the load balancer tries
    readIndex: 0, // next replica for a read
    nextPostId: 1,
    leaderIndex: [0, 0], // position of the primary within each db group
    buckets: {}, // rate-limit bucket per username
  };
  lastNotes = {};

  buildNodes();

  byId("pid").value = 1;
  byId("log").innerHTML =
    '<span class="mute">Press a button to send a request.</span>';
  byId("res").innerHTML = "";
  byId("topobox").style.display = level.isIntro ? "none" : "";

  renderStory(level);
  renderLevelTabs();
  renderTopology();
}

/* ---------- Topology rendering ---------- */

/* Small grey text under each node's name. */
function nodeSubtitle(nodeId) {
  const node = nodes[nodeId];
  if (!node.isUp) return "down, click to restore";

  if (nodeId === "client") return "browser";
  if (nodeId === "loadBalancer") return `up, rrIndex ${state.roundRobinIndex}`;
  if (nodeId === "rateLimiter") {
    const username = byId("user").value;
    return `up, @${username}: ${currentTokens(username).toFixed(1)} tokens`;
  }
  if (nodeId === "cdn") return `up, ${Object.keys(node.data).length} images`;
  if (nodeId === "cache") return `up, ${Object.keys(node.data).length} keys`;
  if (isAppServer(nodeId)) return "up, stateless";

  // Database node
  const groupIndex = dbGroups.findIndex((group) => group.includes(nodeId));
  const group = dbGroups[groupIndex];
  let role = "";
  if (group.length > 1) {
    role = group[state.leaderIndex[groupIndex]] === nodeId ? "primary, " : "replica, ";
  }
  const pending = node.replicationQueue.length
    ? `, ${node.replicationQueue.length} pending`
    : "";
  return `up, ${role}${Object.keys(node.data).length} posts${pending}`;
}

function nodeButtonHtml(nodeId) {
  const node = nodes[nodeId];
  const isClient = nodeId === "client";

  const classes = ["node"];
  if (snippetKeysForNode(nodeId).length) classes.push("has"); // shows { } badge
  if (isClient) classes.push("client");
  if (!node.isUp) classes.push("down");

  // The client box is decorative; every other box can be clicked to kill/restore it.
  const clickAttribute = isClient
    ? 'tabindex="-1"'
    : `onclick="toggleNode('${nodeId}')"`;

  return `<button class="${classes.join(" ")}" id="n-${nodeId}" ${clickAttribute}><b>${node.label}</b><span>${nodeSubtitle(nodeId)}</span></button>`;
}

/* Draw the diagram: one row ("tier") per layer, arrows between rows. */
function renderTopology() {
  hideTip();

  const tiers = [["client"]];
  if (hasFeature("cdn")) tiers.push(["cdn"]);
  if (hasFeature("rateLimit")) tiers.push(["rateLimiter"]);
  if (hasFeature("loadBalancer")) tiers.push(["loadBalancer"]);
  tiers.push(appServerIds());
  if (hasFeature("cache")) tiers.push(["cache"]);
  tiers.push(dbGroups.flat());

  byId("topo").innerHTML = tiers
    .map((tier) => `<div class="tier">${tier.map(nodeButtonHtml).join("")}</div>`)
    .join('<span class="arr">&rsaquo;</span>');
}

/* Take a node down or bring it back. (Called from inline onclick handlers.) */
function toggleNode(nodeId) {
  const node = nodes[nodeId];
  node.isUp = !node.isUp;

  // Cache and CDN lose their contents when they go down.
  if ((nodeId === "cache" || nodeId === "cdn") && !node.isUp) node.data = {};

  // With failover, a restored old primary rejoins as a replica
  // and copies the current primary's data.
  if (node.isUp && hasFeature("failover")) {
    const groupIndex = dbGroups.findIndex((group) => group.includes(nodeId));
    if (groupIndex >= 0) {
      const currentPrimaryId = dbGroups[groupIndex][state.leaderIndex[groupIndex]];
      if (currentPrimaryId !== nodeId) {
        node.data = { ...nodes[currentPrimaryId].data };
        node.replicationQueue = [];
      }
    }
  }

  renderTopology();
  byId("log").innerHTML = `<div class="ln sys"><i>${node.label}</i>${node.isUp ? "restored" : "taken down"}</div>`;
}

/* ---------- Sending a request ---------- */

function setButtonsDisabled(disabled) {
  document.querySelectorAll(".op").forEach((button) => (button.disabled = disabled));
}

function describeRequest(kind, postId) {
  return {
    create: "POST /posts",
    read: `GET /posts/${postId}`,
    update: `PUT /posts/${postId}`,
    delete: `DELETE /posts/${postId}`,
  }[kind];
}

/* Run the simulation instantly, then replay the recorded steps one by one. */
async function sendRequest(kind) {
  if (isBusy) return;
  isBusy = true;
  setButtonsDisabled(true);

  const username = byId("user").value;
  const text = byId("txt").value.trim() || "hello world";
  const postId = +byId("pid").value || 1;

  const steps = [];
  const addStep = (nodeId, message, options = {}) =>
    steps.push({ nodeId, text: message, ...options });

  addStep("client", `${describeRequest(kind, postId)} as @${username}`);
  const response = handleRequest(kind, username, text, postId, addStep);

  const log = byId("log");
  log.innerHTML = "";
  byId("res").innerHTML = "";

  for (const step of steps) {
    const nodeElement = byId("n-" + step.nodeId);
    const highlightClass = step.error ? "bad" : "hot";

    if (nodeElement) nodeElement.classList.add(highlightClass);
    log.insertAdjacentHTML(
      "beforeend",
      `<div class="ln ${step.error ? "bad" : ""}"><i>${nodes[step.nodeId].label}</i>${escapeHtml(step.text)}</div>`,
    );

    await sleep(STEP_DELAY_MS);

    if (nodeElement) nodeElement.classList.remove("hot", "bad");
    if (step.snippet) {
      lastNotes[step.snippet] = { who: nodes[step.nodeId].label, note: step.note };
    }
  }

  const bodyText =
    typeof response.body === "string" ? response.body : JSON.stringify(response.body);
  const resultClass = response.status < 400 ? "ok" : "bad";
  byId("res").innerHTML = `<div class="res ${resultClass}">${response.status} ${escapeHtml(bodyText)}</div>`;

  isBusy = false;
  setButtonsDisabled(false);
  renderTopology();
}

/* ---------- Hover tooltip ---------- */

const tooltip = document.createElement("div");
tooltip.id = "tip";
tooltip.setAttribute("role", "tooltip");
document.body.appendChild(tooltip);

let hideTooltipTimer;

function hideTip() {
  clearTimeout(hideTooltipTimer);
  tooltip.style.display = "none";
}

/* Hide after a short delay so the mouse can travel from the node to the tooltip. */
function scheduleHideTip() {
  clearTimeout(hideTooltipTimer);
  hideTooltipTimer = setTimeout(hideTip, 250);
}

function tooltipHtml(snippetKeys) {
  return snippetKeys
    .map((key) => {
      const snippet = ALGORITHM_SNIPPETS[key];
      const last = lastNotes[key];
      const lastRequestHtml = last
        ? `<p class="note"><b>Last request (${escapeHtml(last.who)}):</b> ${escapeHtml(last.note)}</p>`
        : '<p class="mute">Send a request to see the values it used.</p>';
      return `<h4>${snippet.title}</h4><pre>${escapeHtml(snippet.code)}</pre>${lastRequestHtml}`;
    })
    .join("");
}

function positionTooltip(nodeElement) {
  const nodeBox = nodeElement.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;

  const left = Math.max(8, Math.min(nodeBox.left, innerWidth - width - 8));
  let top = nodeBox.bottom + 10; // prefer below the node
  if (top + height > innerHeight - 8) {
    top = Math.max(8, nodeBox.top - height - 10); // otherwise above it
  }
  tooltip.style.left = left + "px";
  tooltip.style.top = top + "px";
}

function showTip(event) {
  clearTimeout(hideTooltipTimer);
  const nodeElement = event.target.closest && event.target.closest(".node");
  if (!nodeElement) return;

  const snippetKeys = snippetKeysForNode(nodeElement.id.slice(2)); // strip "n-"
  if (!snippetKeys.length) return hideTip();

  tooltip.innerHTML = tooltipHtml(snippetKeys);
  tooltip.style.display = "block";
  positionTooltip(nodeElement);
}

tooltip.addEventListener("mouseenter", () => clearTimeout(hideTooltipTimer));
tooltip.addEventListener("mouseleave", scheduleHideTip);

const topologyElement = byId("topo");
["mouseover", "focusin"].forEach((type) =>
  topologyElement.addEventListener(type, showTip),
);
["mouseout", "focusout"].forEach((type) =>
  topologyElement.addEventListener(type, scheduleHideTip),
);

/* ---------- Event wiring + startup ---------- */

byId("user").innerHTML = USERNAMES.map((name) => `<option>${name}</option>`).join("");
byId("user").onchange = () => renderTopology();

document
  .querySelectorAll(".op[data-o]")
  .forEach((button) => (button.onclick = () => sendRequest(button.dataset.o)));

byId("reset").onclick = () => {
  if (!isBusy) startLevel(currentLevel);
};

startLevel(0);