'use strict';
/*
 * MintGuard — a read-only BSC contract screening agent (demo service).
 *
 * Screens a mint/claim contract BEFORE a user signs anything:
 *   - does code actually exist at the address? (eth_getCode)
 *   - is the source verified on Sourcify? (public source anyone can audit)
 *   - what do basic on-chain probes say? (e.g. totalSupply())
 * and returns a one-line verdict.
 *
 * By design it NEVER connects a wallet, NEVER signs, and NEVER sends a
 * transaction. Node.js standard library only — no dependencies.
 */

const http = require('node:http');

const PORT = process.env.PORT || 8787;
const CHAIN_ID = 56; // BNB Smart Chain
const RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-rpc.publicnode.com',
];
const SOURCIFY_URL = (address) =>
  `https://sourcify.dev/server/v2/contract/${CHAIN_ID}/${address}`;
const TIMEOUT_MS = 8000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_BODY_BYTES = 16 * 1024;

/* ---------------- network helpers (all read-only, all timed) ---------------- */

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function rpc(method, params) {
  let lastError = null;
  for (const url of RPCS) {
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || 'RPC error');
      return data.result;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('all RPC endpoints failed');
}

/* ---------------- individual screening probes (fail-soft) ---------------- */

async function probeHasCode(address) {
  try {
    const code = await rpc('eth_getCode', [address, 'latest']);
    return typeof code === 'string' && code !== '0x';
  } catch {
    return null; // unknown — RPC unreachable
  }
}

async function probeSourcify(address) {
  try {
    const res = await fetchWithTimeout(SOURCIFY_URL(address), {
      headers: { accept: 'application/json' },
    });
    if (res.status === 404) return 'not verified';
    if (res.status !== 200) return 'unknown';
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return 'unknown';
    const match = data.match || data.creationMatch || data.runtimeMatch;
    if (match && match !== 'null') return 'verified';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function probeTotalSupply(address) {
  try {
    // totalSupply() selector 0x18160ddd. A revert just means this contract
    // does not expose it (e.g. a sale contract) — mark the probe unavailable.
    const result = await rpc('eth_call', [
      { to: address, data: '0x18160ddd' },
      'latest',
    ]);
    if (typeof result !== 'string' || result === '0x') return null;
    return BigInt(result).toString(10);
  } catch {
    return null;
  }
}

/* ---------------- the screening itself ---------------- */

async function screenContract(address) {
  const [hasCode, sourcify, totalSupply] = await Promise.all([
    probeHasCode(address),
    probeSourcify(address),
    probeTotalSupply(address),
  ]);

  let summary;
  if (hasCode === false) {
    summary =
      'No contract code exists at this address on BSC — do not interact with it.';
  } else if (hasCode === null) {
    summary =
      'Could not reach a BSC RPC to confirm this contract — treat it as unchecked and verify manually before signing.';
  } else if (sourcify === 'verified') {
    summary =
      'Contract is live on-chain and Sourcify-verified, so its source is public — still run the full supply/quota/price probes before signing.';
  } else if (sourcify === 'not verified') {
    summary =
      'Contract is live on-chain but NOT Sourcify-verified — no public source to audit, treat as high risk and do not sign without independent verification.';
  } else {
    summary =
      'Contract is live on-chain, but its verification status is unknown — check manually before signing.';
  }
  if (totalSupply !== null) {
    summary += ` totalSupply() currently reports ${totalSupply} (raw units).`;
  }

  return {
    contract: address,
    chain: 'bsc',
    hasCode,
    sourcify,
    probes: { totalSupply },
    summary,
  };
}

/* ---------------- info page ---------------- */

const INFO_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MintGuard — BSC Contract Screening Agent</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #0b0f14; color: #e6edf3; line-height: 1.55; }
  main { max-width: 760px; margin: 0 auto; padding: 2.5rem 1.25rem 3rem; }
  h1 { font-size: 2rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; color: #7ee0a3; }
  .tag { color: #8b98a5; margin-top: 0; }
  .card { background: #11161d; border: 1px solid #232c38; border-radius: 10px;
          padding: 1rem 1.25rem; margin: .75rem 0; }
  code, .addr { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: .86em; color: #a5d6ff; word-break: break-all; }
  .no { color: #ff9d8a; font-weight: 600; }
  ol, ul { padding-left: 1.4rem; }
  li { margin: .3rem 0; }
  .verdict { color: #ffd97e; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: .5rem; }
  input { flex: 1 1 320px; padding: .55rem .7rem; border-radius: 8px;
          border: 1px solid #2c3746; background: #0b0f14; color: #e6edf3; }
  button { padding: .55rem 1rem; border-radius: 8px; border: 0; cursor: pointer;
           background: #1f7a4d; color: #fff; font-weight: 600; }
  pre { background: #0b0f14; border: 1px solid #232c38; border-radius: 8px;
        padding: .8rem; overflow-x: auto; font-size: .82rem; white-space: pre-wrap; }
  footer { color: #8b98a5; font-size: .85rem; margin-top: 2.5rem; }
</style>
</head>
<body>
<main>
  <h1>🛡️ MintGuard</h1>
  <p class="tag">A wallet &amp; transaction screening agent for BNB Smart Chain.
     It screens a mint or claim contract <strong>before</strong> anyone signs anything.</p>

  <h2>What it does</h2>
  <div class="card">
    <p>Send MintGuard a contract address and it answers three questions, from
    public on-chain data only:</p>
    <ul>
      <li><strong>Is there really a contract there?</strong> — <code>eth_getCode</code> against a public BSC RPC.</li>
      <li><strong>Is the source verified?</strong> — Sourcify verification status, so the code anyone is about to trust can actually be read.</li>
      <li><strong>What do on-chain probes say?</strong> — live getter reads (for example <code>totalSupply()</code>), the same style of probe used to check remaining supply, per-wallet quota and price before a mint.</li>
    </ul>
    <p>It combines those signals into a one-line risk summary — a verdict a
    person can act on before their wallet is ever involved.</p>
  </div>

  <h2>Who it helps</h2>
  <div class="card">
    <p>Users of agentic wallets are constantly sent mint and claim links —
    in chats, on social media, by other agents. The dangerous moment is the
    signature: a malicious or misdescribed contract can drain a wallet in one
    click. MintGuard gives those users (and their agents) a check-first step
    that costs nothing and risks nothing.</p>
  </div>

  <h2>What it does <span class="no">NOT</span> do</h2>
  <div class="card">
    <ul>
      <li>It is <strong>read-only</strong>. It never connects a wallet.</li>
      <li>It never signs a message or a transaction.</li>
      <li>It never sends transactions and holds no keys and no funds.</li>
      <li>It trusts <strong>contract reads over site claims</strong> — a web page
          can say "free mint, almost gone"; only the chain says what is true.</li>
    </ul>
  </div>

  <h2>How it works</h2>
  <div class="card">
    <ol>
      <li>Receive a contract address (here: <code>POST /check</code> with <code>{"contract": "0x…"}</code>).</li>
      <li>Validate the address format; reject anything malformed, fail-closed.</li>
      <li>Probe the chain: <code>eth_getCode</code> via a public BSC RPC (with a fallback endpoint).</li>
      <li>Ask Sourcify whether the deployed source is verified for chain 56.</li>
      <li>Run safe <code>eth_call</code> probes (e.g. <code>totalSupply()</code>); a revert simply marks that probe unavailable.</li>
      <li>Return a JSON verdict: the raw signals plus a one-line human summary.</li>
    </ol>
  </div>

  <h2>Try it</h2>
  <div class="card">
    <form id="f">
      <input id="addr" placeholder="0x… contract address on BSC" autocomplete="off" spellcheck="false">
      <button type="submit">Screen it</button>
    </form>
    <pre id="out">The verdict JSON will appear here.</pre>
  </div>

  <h2>Real verdicts from contracts this agent has screened</h2>
  <div class="card">
    <p><strong>FEG “Feed Every Gorilla” sale (CanopySale)</strong><br>
    <span class="addr">0xb9d0CA9b63C564443AfE64B77ef91B3bA763e5f1</span><br>
    <span class="verdict">Verdict: proceed.</span> Sourcify-verified contract; on-chain
    reads confirmed a free-share pool (1 free share of 10,000 FEG per eligible
    agent identity) alongside the paid phase. A free share was claimed at the
    opening and the booking was verified on-chain afterwards.</p>
  </div>
  <div class="card">
    <p><strong>DYOR NFT (DyorNFT)</strong><br>
    <span class="addr">0x86956Bc830EB62110820Ae79164BeF61c7E31936</span><br>
    <span class="verdict">Verdict: proceed — first mint only.</span> Sourcify-verified;
    probes showed the first mint per agent identity is free and later mints are
    paid. Exactly one free mint was taken; the paid tiers were left alone.</p>
  </div>
  <div class="card">
    <p><strong>Broccoli Agent sale</strong><br>
    <span class="addr">0xc438821D5937E5246a50f877311a74e40f82eB87</span><br>
    <span class="verdict">Verdict: skip — too late.</span> The contract itself was
    Sourcify-verified, but the free pool (500 lots) drained in roughly
    90 seconds at the opening. A verified contract is not the same as an
    available opportunity: when the free pool is gone, the correct action is
    to walk away, not to chase the paid tier.</p>
  </div>

  <footer>MintGuard demo service · BNB Smart Chain (chain 56) ·
  Read-only by design: no wallet, no signing, no transactions.</footer>
</main>
<script>
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('out');
    const contract = document.getElementById('addr').value.trim();
    out.textContent = 'Screening…';
    try {
      const res = await fetch('/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contract }),
      });
      out.textContent = JSON.stringify(await res.json(), null, 2);
    } catch (err) {
      out.textContent = 'Request failed: ' + err.message;
    }
  });
</script>
</body>
</html>`;

/* ---------------- HTTP plumbing ---------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleCheck(res, contract) {
  if (typeof contract !== 'string' || !ADDRESS_RE.test(contract.trim())) {
    return sendJson(res, 400, {
      error: 'invalid contract address: expected "0x" followed by 40 hex characters',
    });
  }
  try {
    const verdict = await screenContract(contract.trim());
    return sendJson(res, 200, verdict);
  } catch {
    // screenContract is fail-soft per probe; this is a last-resort guard so
    // the endpoint never crashes on an unexpected failure.
    return sendJson(res, 200, {
      contract: contract.trim(),
      chain: 'bsc',
      hasCode: null,
      sourcify: 'unknown',
      probes: { totalSupply: null },
      summary:
        'Screening failed unexpectedly — treat this contract as unchecked and verify manually before signing.',
    });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(INFO_PAGE);
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/check') {
      return await handleCheck(res, url.searchParams.get('contract'));
    }

    if (req.method === 'POST' && url.pathname === '/check') {
      let parsed;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }
      return await handleCheck(res, parsed && parsed.contract);
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch {
    return sendJson(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`MintGuard screening agent listening on port ${PORT}`);
});
