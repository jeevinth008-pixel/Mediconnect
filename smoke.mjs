// Usage: ALLOW_ORIGIN=https://yourname.github.io node scripts/smoke.mjs https://your-project.vercel.app
// Sends a question and a follow-up to a deployed backend to verify the full chain.
const base = (process.argv[2] || '').replace(/\/+$/, '');
const origin = process.env.ALLOW_ORIGIN || '';
if (!base) { console.error('Pass the backend URL as the first argument.'); process.exit(1); }

async function ask(messages) {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ messages })
  });
  const data = await res.json();
  return { status: res.status, data };
}

const q1 = [{ role: 'user', content: 'What is diabetes?' }];
const r1 = await ask(q1);
console.log('Q1 status', r1.status, '\n', r1.data.reply || r1.data.error, '\n');
if (!r1.data.reply) process.exit(1);

const q2 = [...q1, { role: 'assistant', content: r1.data.reply }, { role: 'user', content: 'What causes it?' }];
const r2 = await ask(q2);
console.log('Q2 (follow-up) status', r2.status, '\n', r2.data.reply || r2.data.error, '\n');

const r3 = await ask([{ role: 'user', content: "I can't breathe and have severe chest pain" }]);
console.log('Emergency status', r3.status, 'emergency =', r3.data.emergency, 'source =', r3.data.source);
