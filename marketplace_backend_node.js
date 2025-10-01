# Marketplace Backend (Node/Express)

This repository contains a minimal, ready-to-push Node/Express backend for the digital-goods marketplace. It's intended as a starter you can deploy quickly and extend. It uses SQLite for easy local testing and includes:
- Auth with bcrypt + JWT
- Product CRUD (protected for admin role)
- S3 presign endpoint (AWS SDK v3)
- Stripe Checkout session creation and webhook handler
- Simple orders table and secure order fulfillment flow outline

---

## Project file tree

```
marketplace-backend/
├─ server.js
├─ package.json
├─ README.md
├─ .env.example
└─ db.sqlite (created automatically)
```

---

## How to use (quick)
1. Create a new GitHub repo and push this project.
2. Create a `.env` file from `.env.example` and fill values.
3. `npm install`
4. `node server.js` (or use `nodemon` in dev)
5. Visit `http://localhost:4000` (API endpoints start with `/api`)

---

### === package.json ===

```json
{
  "name": "marketplace-backend",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.0.0",
    "@aws-sdk/s3-request-presigner": "^3.0.0",
    "bcrypt": "^5.1.0",
    "cors": "^2.8.5",
    "dotenv": "^16.0.0",
    "express": "^4.18.2",
    "jsonwebtoken": "^9.0.0",
    "stripe": "^11.0.0",
    "uuid": "^9.0.0",
    "better-sqlite3": "^8.0.0"
  },
  "devDependencies": {
    "nodemon": "^2.0.22"
  }
}
```

---

### === .env.example ===

```
PORT=4000
JWT_SECRET=change_this_to_a_strong_random_value
STRIPE_SECRET=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
S3_BUCKET=your-bucket-name
BASE_URL=http://localhost:4000
```

---

### === server.js ===

```js
// server.js - minimal marketplace backend
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const stripeLib = require('stripe');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const Database = require('better-sqlite3');

const app = express();
app.use(cors({ origin: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret';
const stripe = stripeLib(process.env.STRIPE_SECRET || '');

// Initialize S3 client (used for presigned URLs)
const s3 = new S3Client({ region: process.env.AWS_REGION });
const S3_BUCKET = process.env.S3_BUCKET;

// SQLite DB (file created automatically)
const db = new Database('db.sqlite');
// create tables if not exist
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE,
  password_hash TEXT,
  role TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  title TEXT,
  price_cents INTEGER,
  description TEXT,
  author TEXT,
  asset_key TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  customer_email TEXT,
  status TEXT,
  metadata TEXT,
  created_at INTEGER
);
`);

// helper queries
const insertUser = db.prepare('INSERT INTO users (id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)');
const getUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const getUserById = db.prepare('SELECT id,name,email,role,created_at FROM users WHERE id = ?');

const insertProduct = db.prepare('INSERT INTO products (id,title,price_cents,description,author,asset_key,created_at) VALUES (?,?,?,?,?,?,?)');
const updateProduct = db.prepare('UPDATE products SET title=?, price_cents=?, description=?, author=?, asset_key=? WHERE id=?');
const deleteProduct = db.prepare('DELETE FROM products WHERE id=?');
const getAllProducts = db.prepare('SELECT id,title,price_cents,description,author,asset_key,created_at FROM products ORDER BY created_at DESC');
const getProductById = db.prepare('SELECT * FROM products WHERE id = ?');

const insertOrder = db.prepare('INSERT INTO orders (id, session_id, customer_email, status, metadata, created_at) VALUES (?,?,?,?,?,?)');
const updateOrderStatus = db.prepare('UPDATE orders SET status = ? WHERE session_id = ?');

// --- Auth utilities ---
async function hashPassword(plain){ return await bcrypt.hash(plain, 10); }
async function verifyPassword(plain, hash){ return await bcrypt.compare(plain, hash); }

function generateToken(user){ return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' }); }

function authMiddleware(req, res, next){
  const auth = req.headers.authorization;
  if(!auth) return res.status(401).json({ error: 'No auth' });
  const parts = auth.split(' ');
  if(parts.length !== 2) return res.status(401).json({ error: 'Bad auth' });
  try{
    const payload = jwt.verify(parts[1], JWT_SECRET);
    req.user = payload; next();
  }catch(e){ return res.status(401).json({ error: 'Invalid token' }); }
}

// --- Routes ---
app.get('/', (req,res)=> res.json({ ok: true, message: 'Marketplace API' }));

// Signup (creates admin by default for demo)
app.post('/api/signup', async (req,res)=>{
  const { name, email, password } = req.body;
  if(!email || !password) return res.status(400).json({ error: 'Missing fields' });
  if(getUserByEmail.get(email)) return res.status(409).json({ error: 'Email exists' });
  const id = uuidv4();
  const hash = await hashPassword(password);
  const role = 'admin'; // in production decide roles via DB or verification
  insertUser.run(id, name||'', email, hash, role, Date.now());
  const user = getUserById.get(id);
  const token = generateToken(user);
  res.json({ token, user });
});

// Login
app.post('/api/login', async (req,res)=>{
  const { email, password } = req.body;
  const row = getUserByEmail.get(email);
  if(!row) return res.status(401).json({ error: 'Invalid' });
  const ok = await verifyPassword(password, row.password_hash);
  if(!ok) return res.status(401).json({ error: 'Invalid' });
  const user = getUserById.get(row.id);
  const token = generateToken(user);
  res.json({ token, user });
});

// Public products
app.get('/api/products', (req,res)=>{
  const rows = getAllProducts.all();
  const mapped = rows.map(r=> ({ id:r.id, title:r.title, price: (r.price_cents/100).toFixed(2), description:r.description, author:r.author, asset_key:r.asset_key }));
  res.json(mapped);
});

// Admin product CRUD
app.post('/api/products', authMiddleware, (req,res)=>{
  if(req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { title, price, description, author, asset_key } = req.body;
  if(!title || !price) return res.status(400).json({ error: 'Missing' });
  const id = uuidv4();
  const price_cents = Math.round(Number(price) * 100);
  insertProduct.run(id, title, price_cents, description||'', author||'', asset_key||'', Date.now());
  res.json({ id, title, price: (price_cents/100).toFixed(2), description, author, asset_key });
});

app.put('/api/products/:id', authMiddleware, (req,res)=>{
  if(req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const id = req.params.id; const { title, price, description, author, asset_key } = req.body;
  const row = getProductById.get(id); if(!row) return res.status(404).json({ error: 'Not found' });
  const price_cents = Math.round(Number(price) * 100);
  updateProduct.run(title||row.title, price_cents||row.price_cents, description||row.description, author||row.author, asset_key||row.asset_key, id);
  res.json({ ok: true });
});

app.delete('/api/products/:id', authMiddleware, (req,res)=>{
  if(req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  deleteProduct.run(req.params.id); res.json({ ok: true });
});

// S3 presign endpoint - returns PUT URL and object key
app.post('/api/uploads/presign', authMiddleware, async (req,res)=>{
  if(req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { filename, contentType } = req.body;
  if(!filename || !contentType) return res.status(400).json({ error: 'Missing' });
  const key = `uploads/${Date.now()}_${filename.replace(/[^a-zA-Z0-9.-]/g,'_')}`;
  const command = new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: contentType });
  try{
    const url = await getSignedUrl(s3, command, { expiresIn: 900 }); // 15min
    const publicUrl = `https://${S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    res.json({ uploadUrl: url, key, publicUrl });
  }catch(err){ console.error('presign', err); res.status(500).json({ error: 'presign failed' }); }
});

// Create Stripe Checkout session
app.post('/api/create-checkout-session', async (req,res)=>{
  try{
    const { items, successUrl, cancelUrl, customerEmail } = req.body;
    // validate items server-side
    const line_items = items.map(i => ({
      price_data: {
        currency: 'usd',
        product_data: { name: i.title },
        unit_amount: Math.round(Number(i.price) * 100),
      },
      quantity: i.quantity || 1,
    }));
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items,
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: customerEmail,
    });
    // store order record
    insertOrder.run(uuidv4(), session.id, customerEmail||'', 'pending', JSON.stringify(items||[]), Date.now());
    res.json({ url: session.url });
  }catch(err){ console.error(err); res.status(500).json({ error: 'stripe error' }); }
});

// Stripe webhook (use raw body in production); if using express.json earlier, stripe recommends using raw body parsing only on this route
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
app.post('/api/webhooks/stripe', bodyParser.raw({ type: '*/*' }), (req,res)=>{
  const sig = req.headers['stripe-signature'];
  let event;
  try{
    if(stripeWebhookSecret){
      event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    } else {
      event = JSON.parse(req.body.toString()); // only for dev/testing
    }
  }catch(err){ console.error('webhook signature', err.message); return res.status(400).send(`Webhook Error: ${err.message}`); }

  if(event.type === 'checkout.session.completed'){
    const session = event.data.object;
    console.log('checkout completed', session.id);
    updateOrderStatus.run('paid', session.id);
    // TODO: generate presigned GET links for purchased assets and email to customer
  }

  res.json({ received: true });
});

app.listen(PORT, ()=> console.log(`API listening on ${PORT}`));
```

---

## README.md (short)

```md
# Marketplace Backend

Minimal Node/Express starter for a digital goods marketplace.

## Install
1. Copy `.env.example` to `.env` and fill values
2. `npm install`
3. `npm run dev` (requires nodemon) or `npm start`

## Notes
- This uses SQLite for quick testing. For production, switch to Postgres and a proper ORM.
- Replace "admin by default" signup behavior with proper seller onboarding and verification.
- Ensure `STRIPE_WEBHOOK_SECRET` and webhook endpoint are configured in Stripe dashboard.
- Use HTTPS and secure cookie/JWT practices in production.
```

---

## Next steps I can help with right away
- Convert this to a full Git repo with multiple files and a `Dockerfile` and provide commands to push to GitHub.  
- Replace SQLite with Postgres + migration scripts (Knex/Prisma).  
- Create a CI/CD example for Render or Vercel and a sample `Procfile` / `Dockerfile`.

---

If you want the repo as multiple separate files (so you can `git clone` them), tell me and I'll output each file separately in the canvas so you can copy/paste them into your repo. Otherwise, copy the provided files into your project and push to GitHub.
