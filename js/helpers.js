/* Tiny shared helpers: DOM lookup, HTML escaping, sleep, user list, shard hash. */

const byId = (id) => document.getElementById(id);

const escapeHtml = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const USERNAMES = ["alice", "bob", "carol", "dave"];

/* Deliberately simple hash: sum of character codes.
   Same author always gives the same number, so the same shard. */
const shardHash = (username) =>
  [...username].reduce((sum, char) => sum + char.charCodeAt(0), 0);