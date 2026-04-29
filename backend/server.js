import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

// ─── PostgreSQL ──────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS registrations (
      id SERIAL PRIMARY KEY,
      reg_id VARCHAR(36) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(30) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Mavjud jadvalga reg_id ustunini qo'shish (agar oldin yaratilgan bo'lsa)
  await pool.query(`
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS reg_id VARCHAR(36) UNIQUE
  `).catch(() => {});
}

// ─── Middleware ───────────────────────────────────────────
app.use(cors({
  origin: true,                    // Bu istalgan origin ga ruxsat beradi (*)
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,               // agar cookie yoki auth kerak bo'lsa
  optionsSuccessStatus: 204
}));

app.use(express.json());
// ─── POST /api/register ─────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { name, phone } = req.body;

  if (!name || name.trim().length < 3) {
    return res.status(400).json({ error: "Ism kamida 3 belgi bo'lishi kerak" });
  }
  if (!phone) {
    return res.status(400).json({ error: 'Telefon raqami kiritilmagan' });
  }

  try {
    const regId = crypto.randomUUID();

    await pool.query(
      'INSERT INTO registrations (reg_id, name, phone) VALUES ($1, $2, $3)',
      [regId, name.trim(), phone]
    );

    // Fire-and-forget to Google Sheets
    if (GOOGLE_SCRIPT_URL) {
      fetch(GOOGLE_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reg_id: regId,
          name: name.trim(),
          phone,
          date: new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        }),
      }).catch(() => {});
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Registration error:', err.message);
    res.status(500).json({ error: 'Server xatosi' });
  }
});

// ─── GET /admin ──────────────────────────────────────────
app.get('/admin', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 15;
  const offset = (page - 1) * limit;

  try {
    const [countRes, dataRes] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM registrations'),
      pool.query(
        'SELECT id, name, phone, created_at FROM registrations ORDER BY created_at DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      ),
    ]);

    const total = parseInt(countRes.rows[0].count);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    res.send(renderAdmin(dataRes.rows, page, totalPages, total));
  } catch (err) {
    console.error('Admin error:', err.message);
    res.status(500).send('Server xatosi');
  }
});

// ─── Sheets → PG sync (every 15 min) ────────────────────
async function syncFromSheets() {
  if (!GOOGLE_SCRIPT_URL) return;

  try {
    const resp = await fetch(GOOGLE_SCRIPT_URL);
    if (!resp.ok) return;

    const rows = await resp.json();
    if (!Array.isArray(rows)) return;

    for (const row of rows) {
      if (!row.reg_id || !row.phone) continue;

      const exists = await pool.query(
        'SELECT 1 FROM registrations WHERE reg_id = $1',
        [row.reg_id]
      );

      if (exists.rowCount === 0) {
        await pool.query(
          'INSERT INTO registrations (reg_id, name, phone, created_at) VALUES ($1, $2, $3, $4)',
          [row.reg_id, row.name || '', row.phone, row.date ? new Date(row.date) : new Date()]
        );
      }
    }
    console.log(`[sync] Sheets → PG: ${rows.length} tekshirildi`);
  } catch (err) {
    console.error('[sync] Xato:', err.message);
  }
}

setInterval(syncFromSheets, 15 * 60 * 1000);

// ─── Admin HTML renderer ─────────────────────────────────
function renderAdmin(rows, page, totalPages, total) {
  const formatDate = (d) => {
    const dt = new Date(d);
    return dt.toLocaleDateString('uz-UZ', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  const paginationLinks = [];
  for (let i = 1; i <= totalPages; i++) {
    paginationLinks.push(
      `<a href="/admin?page=${i}" class="pg-btn${i === page ? ' active' : ''}">${i}</a>`
    );
  }

  const tableRows = rows.length === 0
    ? '<tr><td colspan="4" style="text-align:center;color:#888;padding:40px">Hali ro\'yxatdan o\'tgan yo\'q</td></tr>'
    : rows.map((r, i) => `
        <tr>
          <td>${(page - 1) * 15 + i + 1}</td>
          <td>${esc(r.name)}</td>
          <td>${esc(r.phone)}</td>
          <td>${formatDate(r.created_at)}</td>
        </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="uz">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Admin — Qimmat Tikuvchi</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;min-height:100vh}
.wrap{max-width:900px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;color:#E1B085;margin-bottom:4px}
.stat{font-size:13px;color:#888;margin-bottom:20px}
table{width:100%;border-collapse:collapse;background:#111;border-radius:10px;overflow:hidden}
th{background:#1a1a1a;color:#E1B085;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding:12px 14px;text-align:left}
td{padding:11px 14px;font-size:14px;border-top:1px solid #1e1e1e}
tr:hover td{background:#1a1a1a}
.pg{display:flex;gap:6px;justify-content:center;margin-top:20px;flex-wrap:wrap}
.pg-btn{display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:36px;border-radius:8px;background:#1a1a1a;color:#ccc;text-decoration:none;font-size:13px;border:1px solid #222;transition:all .15s}
.pg-btn:hover{border-color:#E1B085;color:#E1B085}
.pg-btn.active{background:#E1B085;color:#000;border-color:#E1B085;font-weight:700}
</style>
</head>
<body>
<div class="wrap">
  <h1>Ro'yxatdan o'tganlar</h1>
  <p class="stat">Jami: ${total} ta &nbsp;|&nbsp; Sahifa: ${page} / ${totalPages}</p>
  <table>
    <thead><tr><th>#</th><th>Ism</th><th>Telefon</th><th>Sana</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  ${totalPages > 1 ? `<div class="pg">${paginationLinks.join('')}</div>` : ''}
</div>
</body>
</html>`;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Start ───────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Admin:  http://localhost:${PORT}/admin`);
    syncFromSheets();
  });
});
