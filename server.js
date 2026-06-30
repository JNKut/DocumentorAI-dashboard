import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(join(__dirname, 'dist')));

// Proxy Railway's GraphQL API server-side to avoid CORS restrictions.
// Token is supplied per-request and never persisted on this server.
app.post('/api/railway-proxy', async (req, res) => {
  const { token, query, variables } = req.body;
  if (!token || !query) {
    return res.status(400).json({ error: 'token and query are required' });
  }
  try {
    const r = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    const json = await r.json();
    res.status(r.status).json(json);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Railway API' });
  }
});

// Serve the SPA for all other routes (Express 5 compatible)
app.use((_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Dashboard server running on port ${port}`));
