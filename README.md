# Scaling a Mini Twitter

A small interactive reviewer for system design concepts. It follows one mini Twitter clone (create, read, update, delete posts) through hypothetical growth. Each level adds the concept that fixes the next problem, and you can send requests, kill components, and hover boxes to see the algorithm behind each decision.

## Run it

No build step and no dependencies. Open `index.html` in a browser. (Google Fonts load from the web; the page still works offline with fallback fonts.)

## Structure

```
index.html        page markup and script loading order
css/styles.css    all styling (ivory doodle theme)
js/helpers.js     tiny helpers: $, esc, sleep, user list, shard hash
js/data.js        content: LEVELS, SHORT tab names, D node labels, SN code snippets
js/engine.js      simulation: state, replication, dbPick (routing + failover), flow0/flow
js/ui.js          UI: init, render, tog, op (request playback), hover tooltip, listeners
```

Scripts are plain classic scripts sharing globals, so the project also works when opened straight from disk. Load order matters: helpers, data, engine, ui.

## Levels

Intro, then Level 0 to 8: single server, load balancer, rate limiting, read replicas, database failover, caching, sharding, CDN, and Combined (everything together).

## How levels work

Each level in `LEVELS` (js/data.js) has an `f` array of feature flags. The engine and UI check them with `has('name')`:

`lb` load balancer and 3 app servers, `rl` rate limiter, `rep` replicas, `fo` failover, `cache` cache, `shard` two shards, `cdn` CDN edge.

## Adding a level

1. Add an entry to `LEVELS` in `js/data.js` with title, concept, problem text, a "try this" hint, and its flags. Add a short tab name to `SHORT` in the same position.
2. If it needs a new component, create the node in `init()` (js/ui.js), add its tier in `render()`, and handle it in `flow0()` (js/engine.js).
3. For a hover snippet, add the code to `SN` in js/data.js, return its key from `tipKeys()` in js/ui.js, and pass the key to `P(node, text, snippetKey, note)` in the engine.

## Simplifications

Failover checks the primary when a request arrives instead of running background health checks. Levels are standalone except Combined, which turns everything on.
