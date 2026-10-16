// Isolated browser fixture: actual RevenuePanel and built tracker, no API,
// account, production site, Cloudflare resources or persistent event writes.
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const tracker = readFileSync(root + 'packages/tracker/dist/tracker.js', 'utf8');
const assetsDir = root + 'apps/platform/web/dist/assets/';
const styleName = readdirSync(assetsDir).find(name => /^index-.*\.css$/.test(name));
const style = styleName ? readFileSync(assetsDir + styleName, 'utf8') : '';
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RevenuePanel} from './apps/platform/web/src/components/analytics/RevenuePanel';
const fixture=[{name:'Purchase Confirmed',count:3,totalValue:12,revenues:[{currency:'USD',amount:49},{currency:'CNY',amount:100}]}];
function App(){const [state,setState]=useState('data');return <main className="mx-auto max-w-4xl p-4"><h1 className="mb-4 text-xl">Local synthetic attribution QA</h1><nav className="mb-4 flex flex-wrap gap-3">{['data','loading','error','empty','unavailable'].map(s=><button className="rounded border bg-white p-2" key={s} onClick={()=>setState(s)}>{s}</button>)}<button className="rounded border bg-white p-2" onClick={()=>{window.traks.event('Purchase Confirmed',{props:{plan:'pro'},revenue:{currency:'USD',amount:49}});history.pushState({},'', '/next');window.traks('Tool Completed',{tool:'demo'});document.getElementById('sent').textContent='Synthetic events sent locally';}}>Send local events</button></nav><p id="sent"/><RevenuePanel events={state==='unavailable'?undefined:state==='empty'?[]:fixture} isLoading={state==='loading'} isError={state==='error'}/></main>}
createRoot(document.getElementById('root')).render(<App/>);
window.__fixtureErrors=[];
window.addEventListener('error', e=>window.__fixtureErrors.push(String(e.message)));
window.addEventListener('unhandledrejection', e=>window.__fixtureErrors.push(String(e.reason)));
`;
const compiled = buildSync({
  stdin: { contents: entry, loader: 'tsx', resolveDir: root },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
}).outputFiles[0].text;
const captures = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:5518');
  if (url.pathname === '/api/event' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 16384) request.destroy();
    });
    request.on('end', () => {
      try {
        if (captures.length < 200) captures.push(JSON.parse(body));
      } catch {
        /* fixture only */
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
    return;
  }
  if (url.pathname === '/received') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(captures));
    return;
  }
  if (url.pathname === '/t.js' || url.pathname === '/fixture.js') {
    response
      .writeHead(200, { 'Content-Type': 'application/javascript' })
      .end(url.pathname === '/t.js' ? tracker : compiled);
    return;
  }
  if (url.pathname === '/fixture.css') {
    response.writeHead(200, { 'Content-Type': 'text/css' }).end(style);
    return;
  }
  response
    .writeHead(200, { 'Content-Type': 'text/html' })
    .end(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><title>Traks local attribution QA</title></head><body><div id="root"></div><script defer data-site="local-qa-fixture" src="/t.js"></script><script defer src="/fixture.js"></script></body></html>`
    );
});
server.listen(5518, '127.0.0.1', () =>
  console.log('Local synthetic fixture at http://127.0.0.1:5518; memory only; no forwarding')
);
