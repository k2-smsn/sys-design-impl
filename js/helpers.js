/* Tiny shared helpers: DOM lookup, escaping, sleep, user list, shard hash. */
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const USERS=['alice','bob','carol','dave'];
const hash=u=>[...u].reduce((a,c)=>a+c.charCodeAt(0),0);
