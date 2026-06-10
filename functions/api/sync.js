// Cloudflare Pages Function: /api/sync
// Backed by a D1 database bound as "DB" in the Pages project settings.
//
// Auth model: the client sends its sync code as a bearer token. The code is
// SHA-256 hashed and the hash is the row key — the raw code is never stored,
// so rows can only be read or written by someone who knows the code.

const MAX_BYTES = 2_000_000; // ~2 MB of JSON is years of workouts

async function codeToId(code) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function onRequest({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 binding "DB" is not configured on this Pages project' }, 500);

  const auth = request.headers.get('Authorization') || '';
  const code = auth.replace(/^Bearer\s+/i, '').trim();
  if (code.length < 8) return json({ error: 'sync code must be at least 8 characters' }, 401);
  const id = await codeToId(code);

  await db.prepare(
    'CREATE TABLE IF NOT EXISTS sync_data (id TEXT PRIMARY KEY, data TEXT NOT NULL, saved_at INTEGER NOT NULL)'
  ).run();

  if (request.method === 'GET') {
    const row = await db.prepare('SELECT data FROM sync_data WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'no data for this sync code yet' }, 404);
    return new Response(row.data, {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > MAX_BYTES) return json({ error: 'payload too large' }, 413);
    let savedAt = 0;
    try {
      const parsed = JSON.parse(body);
      savedAt = Number(parsed.savedAt) || 0;
      if (!Array.isArray(parsed.sessions)) throw new Error('bad shape');
    } catch {
      return json({ error: 'body must be valid app-state JSON' }, 400);
    }
    // last-write-wins: never overwrite a newer copy with an older one
    await db.prepare(
      `INSERT INTO sync_data (id, data, saved_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, saved_at = excluded.saved_at
       WHERE excluded.saved_at >= sync_data.saved_at`
    ).bind(id, body, savedAt).run();
    return json({ ok: true });
  }

  if (request.method === 'DELETE') {
    await db.prepare('DELETE FROM sync_data WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  return json({ error: 'method not allowed' }, 405);
}
