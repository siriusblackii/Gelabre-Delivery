import { createHash, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const projectDir = fileURLToPath(new URL('.', import.meta.url));
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const orderStatuses = new Set(['RECEBIDO', 'CONFIRMADO', 'EM_PREPARO', 'SAIU_PARA_ENTREGA', 'CONCLUIDO', 'CANCELADO']);
const openingHoursTimezone = 'America/Sao_Paulo';
const openingHoursDays = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const defaultOpeningHours = openingHoursDays.map(() => ({ enabled: false, open: '09:00', close: '18:00' }));
const weekdayNumbers = new Map(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => [day, index]));
const exampleProducts = [
  { id: 101, name: 'Geladinho de morango', description: 'Geladinho cremoso com sabor de morango.', price: 12, category: 'Geladinho', image: '', quantity: 10, visible: true },
  { id: 102, name: 'Geladinho de chocolate', description: 'Geladinho cremoso para quem ama chocolate.', price: 19.9, category: 'Geladinho', image: '', quantity: 10, visible: true },
  { id: 103, name: 'Geladinho de coco', description: 'Geladinho suave e saboroso de coco.', price: 10, category: 'Geladinho', image: '', quantity: 10, visible: true },
  { id: 104, name: 'Geladinho de maracujá', description: 'Um sabor refrescante de maracujá.', price: 6, category: 'Geladinho', image: '', quantity: 10, visible: true },
  { id: 105, name: 'Geladinho gourmet de leite em pó', description: 'Geladinho cremoso com sabor de leite em pó.', price: 15, category: 'Geladinho', image: '', quantity: 10, visible: true },
  { id: 106, name: 'Geladinho gourmet de chocolate', description: 'Uma versão ainda mais cremosa de chocolate.', price: 2.5, category: 'Geladinho', image: '', quantity: 10, visible: true }
];
const publicFiles = new Map([
  ['/', ['gelabre_delivery_v2.html', 'text/html; charset=utf-8']],
  ['/gelabre_delivery_v2.html', ['gelabre_delivery_v2.html', 'text/html; charset=utf-8']],
  ['/gelabre-foto.png', ['gelabre-foto.png', 'image/png']],
  ['/admin', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin.html', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']]
]);

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    const value = part.slice(index + 1).trim();
    try {
      return [part.slice(0, index).trim(), decodeURIComponent(value)];
    } catch {
      return [part.slice(0, index).trim(), ''];
    }
  }).filter(([key]) => key));
}

async function readJson(request, limit = 32 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('O conteúdo enviado excede o limite permitido.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Envie um JSON válido.');
    error.statusCode = 400;
    throw error;
  }
}

function requiredText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw Object.assign(new Error(`${label} é obrigatório e deve ter no máximo ${maxLength} caracteres.`), { statusCode: 400 });
  }
  return value.trim();
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > maxLength) {
    throw Object.assign(new Error(`${label} deve ter no máximo ${maxLength} caracteres.`), { statusCode: 400 });
  }
  return value.trim();
}

function normalizeProduct(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Dados do produto inválidos.'), { statusCode: 400 });
  }
  const name = requiredText(input.name, 'Nome do produto', 150);
  const description = optionalText(input.description, 'Descrição', 500);
  const price = input.price;
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 100000) {
    throw Object.assign(new Error('Informe um preço válido para o produto.'), { statusCode: 400 });
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 0 || input.quantity > 1000000) {
    throw Object.assign(new Error('A quantidade deve ser um número inteiro entre 0 e 1.000.000.'), { statusCode: 400 });
  }
  if (input.visible !== undefined && typeof input.visible !== 'boolean') {
    throw Object.assign(new Error('A visibilidade do produto é inválida.'), { statusCode: 400 });
  }
  const image = optionalText(input.image, 'Foto', 3_000_000);
  if (image && !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) {
    throw Object.assign(new Error('A foto precisa ser uma imagem PNG, JPG, WEBP ou GIF válida.'), { statusCode: 400 });
  }
  return {
    name,
    description,
    price,
    category: 'Geladinho',
    image,
    quantity: input.quantity,
    visible: input.visible !== false
  };
}

function normalizeSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Dados da loja inválidos.'), { statusCode: 400 });
  }
  const whatsapp = optionalText(input.whatsapp, 'WhatsApp', 30).replace(/\D/g, '');
  if (whatsapp && !/^[1-9]\d{7,14}$/.test(whatsapp)) {
    throw Object.assign(new Error('Informe o WhatsApp com código do país, DDD e número, entre 8 e 15 dígitos.'), { statusCode: 400 });
  }
  return {
    pixKey: optionalText(input.pixKey, 'Chave Pix', 200),
    merchant: optionalText(input.merchant, 'Recebedor Pix', 100),
    city: optionalText(input.city, 'Cidade', 50),
    pixdesc: optionalText(input.pixdesc, 'Descrição Pix', 72),
    whatsapp
  };
}

function normalizeDeliverySettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Dados da entrega inválidos.'), { statusCode: 400 });
  }
  const deliveryFee = input.deliveryFee;
  if (typeof deliveryFee !== 'number' || !Number.isFinite(deliveryFee) || deliveryFee < 0 || deliveryFee > 100000) {
    throw Object.assign(new Error('Informe uma taxa de entrega válida entre R$ 0,00 e R$ 100.000,00.'), { statusCode: 400 });
  }
  if (typeof input.freeDelivery !== 'boolean') {
    throw Object.assign(new Error('Selecione se a entrega será grátis.'), { statusCode: 400 });
  }
  return { deliveryFeeCents: Math.round(deliveryFee * 100), freeDelivery: input.freeDelivery };
}

function normalizeOpeningHours(input) {
  if (!Array.isArray(input) || input.length !== 7) {
    throw Object.assign(new Error('Configure os horários de todos os dias da semana.'), { statusCode: 400 });
  }
  return input.map((day, index) => {
    if (!day || typeof day !== 'object' || typeof day.enabled !== 'boolean'
      || typeof day.open !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(day.open)
      || typeof day.close !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(day.close)) {
      throw Object.assign(new Error(`O horário de ${openingHoursDays[index]} é inválido.`), { statusCode: 400 });
    }
    if (day.enabled && day.open === day.close) {
      throw Object.assign(new Error(`Defina horários diferentes para abertura e fechamento em ${openingHoursDays[index]}.`), { statusCode: 400 });
    }
    return { enabled: day.enabled, open: day.open, close: day.close };
  });
}

function storeTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: openingHoursTimezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    weekday: weekdayNumbers.get(values.weekday),
    minute: Number(values.hour) * 60 + Number(values.minute)
  };
}

export function isStoreOpen(openingHours, date = new Date()) {
  const { weekday, minute } = storeTimeParts(date);
  const today = openingHours[weekday];
  const yesterday = openingHours[(weekday + 6) % 7];
  const toMinutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  if (today.enabled) {
    const open = toMinutes(today.open);
    const close = toMinutes(today.close);
    if (close > open && minute >= open && minute < close) return true;
    if (close < open && minute >= open) return true;
  }
  if (yesterday.enabled && toMinutes(yesterday.close) < toMinutes(yesterday.open)
    && minute < toMinutes(yesterday.close)) return true;
  return false;
}

function normalizeOrder(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Dados do pedido inválidos.'), { statusCode: 400 });
  }
  const customer = requiredText(input.customer, 'Nome', 120);
  const phone = requiredText(input.phone, 'Telefone', 40);
  const address = requiredText(input.address, 'Endereço', 500);
  const notes = optionalText(input.notes, 'Observações', 1500);
  const location = optionalText(input.location, 'Localização', 500);
  if (location) {
    let mapUrl;
    try {
      mapUrl = new URL(location);
    } catch {
      throw Object.assign(new Error('O link da localização é inválido.'), { statusCode: 400 });
    }
    if (mapUrl.protocol !== 'https:' || mapUrl.hostname !== 'www.google.com' || !mapUrl.pathname.startsWith('/maps')) {
      throw Object.assign(new Error('O link da localização deve ser um endereço seguro do Google Maps.'), { statusCode: 400 });
    }
  }
  const change = optionalText(input.change, 'Troco', 80);
  const allowedPayments = new Set(['Pix', 'Dinheiro na entrega']);
  if (!allowedPayments.has(input.payment)) {
    throw Object.assign(new Error('Forma de pagamento inválida.'), { statusCode: 400 });
  }
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 30) {
    throw Object.assign(new Error('O pedido deve conter de 1 a 30 produtos.'), { statusCode: 400 });
  }
  const quantities = new Map();
  for (const item of input.items) {
    if (!item || !Number.isSafeInteger(item.id) || item.id < 1
      || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) {
      throw Object.assign(new Error('Um dos produtos do pedido possui dados inválidos.'), { statusCode: 400 });
    }
    quantities.set(item.id, (quantities.get(item.id) || 0) + item.quantity);
  }
  return { customer, phone, address, notes, location, change, payment: input.payment, quantities };
}

function publicProduct(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price_cents / 100,
    category: row.category,
    image: row.image,
    quantity: row.quantity,
    visible: Boolean(row.visible),
    updatedAt: row.updated_at
  };
}

function publicSettings(row) {
  const openingHours = normalizeOpeningHours(JSON.parse(row.opening_hours_json));
  return {
    pixKey: row.pix_key,
    merchant: row.merchant,
    city: row.city,
    pixdesc: row.pixdesc,
    whatsapp: row.whatsapp,
    deliveryFeeCents: row.delivery_fee_cents,
    freeDelivery: Boolean(row.free_delivery),
    openingHours,
    isOpen: isStoreOpen(openingHours)
  };
}

function publicOrder(row) {
  return {
    id: row.id,
    customer: row.customer,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    location: row.location,
    change: row.change,
    payment: row.payment,
    items: JSON.parse(row.items),
    subtotalCents: row.subtotal_cents,
    deliveryFeeCents: row.delivery_fee_cents,
    totalCents: row.total_cents,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function createRateLimiter({ limit, windowMs }) {
  const attempts = new Map();
  return key => {
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter(timestamp => now - timestamp < windowMs);
    if (recent.length >= limit) {
      attempts.set(key, recent);
      return false;
    }
    recent.push(now);
    attempts.set(key, recent);
    return true;
  };
}

export async function createApplication({ databasePath = join(projectDir, 'data', 'orders.sqlite'), adminPassword } = {}) {
  if (typeof adminPassword !== 'string' || adminPassword.length < 12) {
    throw new Error('Defina GELABRE_ADMIN_PASSWORD com pelo menos 12 caracteres antes de iniciar.');
  }
  await mkdir(dirname(resolve(databasePath)), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      notes TEXT NOT NULL,
      location TEXT NOT NULL,
      change_amount TEXT NOT NULL,
      payment TEXT NOT NULL,
      items TEXT NOT NULL,
      total_cents INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('RECEBIDO','CONFIRMADO','EM_PREPARO','SAIU_PARA_ENTREGA','CONCLUIDO','CANCELADO')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_created_at ON orders(created_at DESC);
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      category TEXT NOT NULL,
      image TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS store_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pix_key TEXT NOT NULL DEFAULT '',
      merchant TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      pixdesc TEXT NOT NULL DEFAULT '',
      whatsapp TEXT NOT NULL DEFAULT '',
      delivery_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee_cents >= 0),
      free_delivery INTEGER NOT NULL DEFAULT 0 CHECK (free_delivery IN (0, 1)),
      opening_hours_json TEXT NOT NULL DEFAULT '[]'
    );
  `);
  const orderColumns = new Set(database.prepare('PRAGMA table_info(orders)').all().map(column => column.name));
  if (!orderColumns.has('subtotal_cents')) {
    database.exec('ALTER TABLE orders ADD COLUMN subtotal_cents INTEGER NOT NULL DEFAULT 0');
    database.exec('UPDATE orders SET subtotal_cents = total_cents');
  }
  if (!orderColumns.has('delivery_fee_cents')) {
    database.exec('ALTER TABLE orders ADD COLUMN delivery_fee_cents INTEGER NOT NULL DEFAULT 0');
  }
  const settingsColumns = new Set(database.prepare('PRAGMA table_info(store_settings)').all().map(column => column.name));
  if (!settingsColumns.has('delivery_fee_cents')) {
    database.exec('ALTER TABLE store_settings ADD COLUMN delivery_fee_cents INTEGER NOT NULL DEFAULT 0');
  }
  if (!settingsColumns.has('free_delivery')) {
    database.exec('ALTER TABLE store_settings ADD COLUMN free_delivery INTEGER NOT NULL DEFAULT 0');
  }
  if (!settingsColumns.has('opening_hours_json')) {
    database.exec("ALTER TABLE store_settings ADD COLUMN opening_hours_json TEXT NOT NULL DEFAULT '[]'");
  }

  const productCount = database.prepare('SELECT COUNT(*) AS count FROM products').get().count;
  if (productCount === 0) {
    const now = new Date().toISOString();
    const insertProduct = database.prepare(`
      INSERT INTO products (id, name, description, price_cents, category, image, quantity, visible, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const product of exampleProducts) {
        insertProduct.run(product.id, product.name, product.description, Math.round(product.price * 100), product.category, product.image, product.quantity, 1, now, now);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  database.prepare('INSERT OR IGNORE INTO store_settings (id) VALUES (1)').run();
  database.prepare("UPDATE store_settings SET opening_hours_json = ? WHERE id = 1 AND opening_hours_json = '[]'")
    .run(JSON.stringify(defaultOpeningHours));

  const sessions = new Map();
  const loginLimiter = createRateLimiter({ limit: 8, windowMs: 15 * 60 * 1000 });
  const orderLimiter = createRateLimiter({ limit: 20, windowMs: 60 * 1000 });
  const passwordHash = createHash('sha256').update(adminPassword).digest();
  const findOrder = database.prepare('SELECT * FROM orders WHERE id = ?');

  function activeSession(request) {
    const token = parseCookies(request.headers.cookie).gelabre_session;
    const session = token ? sessions.get(token) : null;
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    session.expiresAt = Date.now() + sessionLifetimeMs;
    return session;
  }

  async function serveStatic(response, pathname) {
    const file = publicFiles.get(pathname);
    if (!file) return false;
    const path = join(projectDir, file[0]);
    try {
      const fileStat = await stat(path);
      if (!fileStat.isFile()) return false;
      const contents = await readFile(path);
      response.writeHead(200, {
        'Content-Type': file[1],
        'Content-Length': contents.length,
        'Cache-Control': pathname === '/gelabre-foto.png' ? 'public, max-age=86400' : 'no-cache'
      });
      response.end(contents);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  const server = createHttpServer(async (request, response) => {
    setSecurityHeaders(response);
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const ip = request.socket.remoteAddress || 'unknown';
    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'GET' && url.pathname === '/api/products') {
        const rows = database.prepare('SELECT * FROM products WHERE visible = 1 AND quantity > 0 ORDER BY id').all();
        return sendJson(response, 200, { products: rows.map(publicProduct) });
      }
      if (request.method === 'GET' && url.pathname === '/api/settings') {
        return sendJson(response, 200, { settings: publicSettings(database.prepare('SELECT * FROM store_settings WHERE id = 1').get()) });
      }
      if (['POST', 'PATCH', 'DELETE'].includes(request.method) && !isSameOrigin(request)) {
        return sendJson(response, 403, { error: 'Origem da solicitação não permitida.' });
      }
      if (request.method === 'POST' && url.pathname === '/api/orders') {
        if (!orderLimiter(ip)) return sendJson(response, 429, { error: 'Muitos pedidos em pouco tempo. Tente novamente em breve.' });
        const order = normalizeOrder(await readJson(request));
        const id = randomUUID();
        const now = new Date().toISOString();
        let subtotalCents = 0;
        let deliveryFeeCents = 0;
        let totalCents = 0;
        const items = [];
        database.exec('BEGIN IMMEDIATE');
        try {
          const settings = database.prepare('SELECT delivery_fee_cents, free_delivery, opening_hours_json FROM store_settings WHERE id = 1').get();
          const openingHours = normalizeOpeningHours(JSON.parse(settings.opening_hours_json));
          if (!isStoreOpen(openingHours)) {
            throw Object.assign(new Error('A loja está fechada no momento e não está aceitando pedidos.'), { statusCode: 409 });
          }
          for (const [productId, quantity] of order.quantities) {
            const product = database.prepare('SELECT * FROM products WHERE id = ?').get(productId);
            if (!product || !product.visible) {
              throw Object.assign(new Error('Um produto do pedido não está mais disponível.'), { statusCode: 409 });
            }
            if (product.quantity < quantity) {
              throw Object.assign(new Error(`Estoque insuficiente para "${product.name}". Restam ${product.quantity} unidade(s).`), { statusCode: 409 });
            }
            const unitPriceCents = product.price_cents;
            subtotalCents += unitPriceCents * quantity;
            items.push({ id: product.id, name: product.name, quantity, unitPriceCents });
            database.prepare('UPDATE products SET quantity = quantity - ?, updated_at = ? WHERE id = ?').run(quantity, now, product.id);
          }
          deliveryFeeCents = settings.free_delivery ? 0 : settings.delivery_fee_cents;
          totalCents = subtotalCents + deliveryFeeCents;
          if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(totalCents)) {
            throw Object.assign(new Error('O total do pedido é inválido.'), { statusCode: 400 });
          }
          database.prepare(`
            INSERT INTO orders (id, customer, phone, address, notes, location, change_amount, payment, items, subtotal_cents, delivery_fee_cents, total_cents, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEBIDO', ?, ?)
          `).run(id, order.customer, order.phone, order.address, order.notes, order.location, order.change, order.payment, JSON.stringify(items), subtotalCents, deliveryFeeCents, totalCents, now, now);
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        return sendJson(response, 201, { id, status: 'RECEBIDO', subtotalCents, deliveryFeeCents, totalCents, items, createdAt: now });
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/login') {
        if (!loginLimiter(ip)) return sendJson(response, 429, { error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' });
        const body = await readJson(request, 4 * 1024);
        const candidate = typeof body?.password === 'string' ? body.password : '';
        const candidateHash = createHash('sha256').update(candidate).digest();
        if (!timingSafeEqual(candidateHash, passwordHash)) {
          return sendJson(response, 401, { error: 'Senha incorreta.' });
        }
        const token = randomBytes(32).toString('base64url');
        sessions.set(token, { expiresAt: Date.now() + sessionLifetimeMs });
        const secure = request.socket.encrypted ? '; Secure' : '';
        response.setHeader('Set-Cookie', `gelabre_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeMs / 1000}${secure}`);
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/session') {
        return sendJson(response, 200, { authenticated: Boolean(activeSession(request)) });
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/logout') {
        const token = parseCookies(request.headers.cookie).gelabre_session;
        if (token) sessions.delete(token);
        response.setHeader('Set-Cookie', 'gelabre_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return sendJson(response, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/admin/')) {
        if (!activeSession(request)) return sendJson(response, 401, { error: 'Faça login para acessar o painel.' });
        if (request.method === 'GET' && url.pathname === '/api/admin/products') {
          const rows = database.prepare('SELECT * FROM products ORDER BY id').all();
          return sendJson(response, 200, { products: rows.map(publicProduct) });
        }
        if (request.method === 'POST' && url.pathname === '/api/admin/products') {
          const product = normalizeProduct(await readJson(request, 4 * 1024 * 1024));
          const now = new Date().toISOString();
          const result = database.prepare(`
            INSERT INTO products (name, description, price_cents, category, image, quantity, visible, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(product.name, product.description, Math.round(product.price * 100), product.category, product.image, product.quantity, Number(product.visible), now, now);
          const row = database.prepare('SELECT * FROM products WHERE id = ?').get(Number(result.lastInsertRowid));
          return sendJson(response, 201, { product: publicProduct(row) });
        }
        if (request.method === 'POST' && url.pathname === '/api/admin/products/reset') {
          const now = new Date().toISOString();
          database.exec('BEGIN IMMEDIATE');
          try {
            database.exec('DELETE FROM products');
            const insertProduct = database.prepare(`
              INSERT INTO products (name, description, price_cents, category, image, quantity, visible, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const product of exampleProducts) {
              insertProduct.run(product.name, product.description, Math.round(product.price * 100), product.category, product.image, product.quantity, 1, now, now);
            }
            database.exec('COMMIT');
          } catch (error) {
            database.exec('ROLLBACK');
            throw error;
          }
          return sendJson(response, 200, { products: database.prepare('SELECT * FROM products ORDER BY id').all().map(publicProduct) });
        }
        const productMatch = url.pathname.match(/^\/api\/admin\/products\/(\d+)$/);
        if (productMatch && request.method === 'PUT') {
          const body = await readJson(request, 4 * 1024 * 1024);
          const product = normalizeProduct(body);
          const expectedUpdatedAt = requiredText(body.expectedUpdatedAt, 'Versão atual do produto', 40);
          const id = Number(productMatch[1]);
          const result = database.prepare(`
            UPDATE products SET name = ?, description = ?, price_cents = ?, category = ?, image = ?, quantity = ?, visible = ?, updated_at = ?
            WHERE id = ? AND updated_at = ?
          `).run(product.name, product.description, Math.round(product.price * 100), product.category, product.image, product.quantity, Number(product.visible), new Date().toISOString(), id, expectedUpdatedAt);
          if (!result.changes) {
            const exists = database.prepare('SELECT 1 AS found FROM products WHERE id = ?').get(id);
            if (!exists) return sendJson(response, 404, { error: 'Produto não encontrado.' });
            return sendJson(response, 409, { error: 'O produto ou o estoque mudou desde que você abriu a edição. Reabra o produto e tente novamente.' });
          }
          return sendJson(response, 200, { product: publicProduct(database.prepare('SELECT * FROM products WHERE id = ?').get(id)) });
        }
        if (productMatch && request.method === 'DELETE') {
          const result = database.prepare('DELETE FROM products WHERE id = ?').run(Number(productMatch[1]));
          if (!result.changes) return sendJson(response, 404, { error: 'Produto não encontrado.' });
          return sendJson(response, 200, { ok: true });
        }
        if (request.method === 'GET' && url.pathname === '/api/admin/settings') {
          return sendJson(response, 200, { settings: publicSettings(database.prepare('SELECT * FROM store_settings WHERE id = 1').get()) });
        }
        if (request.method === 'PUT' && url.pathname === '/api/admin/settings') {
          const settings = normalizeSettings(await readJson(request, 8 * 1024));
          database.prepare(`
            UPDATE store_settings SET pix_key = ?, merchant = ?, city = ?, pixdesc = ?, whatsapp = ? WHERE id = 1
          `).run(settings.pixKey, settings.merchant, settings.city, settings.pixdesc, settings.whatsapp);
          return sendJson(response, 200, { settings: publicSettings(database.prepare('SELECT * FROM store_settings WHERE id = 1').get()) });
        }
        if (request.method === 'PUT' && url.pathname === '/api/admin/delivery-settings') {
          const settings = normalizeDeliverySettings(await readJson(request, 4 * 1024));
          database.prepare(`
            UPDATE store_settings SET delivery_fee_cents = ?, free_delivery = ? WHERE id = 1
          `).run(settings.deliveryFeeCents, Number(settings.freeDelivery));
          return sendJson(response, 200, { settings });
        }
        if (request.method === 'PUT' && url.pathname === '/api/admin/opening-hours') {
          const body = await readJson(request, 8 * 1024);
          const openingHours = normalizeOpeningHours(body?.openingHours);
          database.prepare('UPDATE store_settings SET opening_hours_json = ? WHERE id = 1').run(JSON.stringify(openingHours));
          return sendJson(response, 200, {
            settings: publicSettings(database.prepare('SELECT * FROM store_settings WHERE id = 1').get())
          });
        }
        if (request.method === 'GET' && url.pathname === '/api/admin/orders') {
          const rows = database.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all();
          return sendJson(response, 200, { orders: rows.map(publicOrder) });
        }
        if (request.method === 'DELETE' && url.pathname === '/api/admin/orders') {
          const body = await readJson(request, 16 * 1024);
          if (!Array.isArray(body?.ids) || body.ids.length < 1 || body.ids.length > 200
            || body.ids.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))
            || new Set(body.ids).size !== body.ids.length) {
            return sendJson(response, 400, { error: 'Selecione de 1 a 200 pedidos válidos para excluir.' });
          }
          const now = new Date().toISOString();
          database.exec('BEGIN IMMEDIATE');
          try {
            const getOrder = database.prepare('SELECT * FROM orders WHERE id = ?');
            const deleteOrder = database.prepare('DELETE FROM orders WHERE id = ?');
            const releaseStock = database.prepare('UPDATE products SET quantity = quantity + ?, updated_at = ? WHERE id = ?');
            for (const id of body.ids) {
              const order = getOrder.get(id);
              if (!order) {
                throw Object.assign(new Error('A lista de pedidos mudou. Atualize o painel e tente novamente.'), { statusCode: 409 });
              }
              if (!['CANCELADO', 'CONCLUIDO'].includes(order.status)) {
                for (const item of JSON.parse(order.items)) {
                  releaseStock.run(item.quantity, now, item.id);
                }
              }
              deleteOrder.run(id);
            }
            database.exec('COMMIT');
          } catch (error) {
            database.exec('ROLLBACK');
            throw error;
          }
          return sendJson(response, 200, { deletedCount: body.ids.length });
        }
        const match = request.method === 'PATCH' && url.pathname.match(/^\/api\/admin\/orders\/([0-9a-f-]{36})\/status$/i);
        if (match) {
          const body = await readJson(request, 4 * 1024);
          if (!orderStatuses.has(body?.status)) return sendJson(response, 400, { error: 'Status de pedido inválido.' });
          const now = new Date().toISOString();
          database.exec('BEGIN IMMEDIATE');
          try {
            const order = findOrder.get(match[1]);
            if (!order) {
              database.exec('ROLLBACK');
              return sendJson(response, 404, { error: 'Pedido não encontrado.' });
            }
            if (order.status !== body.status) {
              const items = JSON.parse(order.items);
              if (order.status === 'CANCELADO') {
                for (const item of items) {
                  const product = database.prepare('SELECT * FROM products WHERE id = ?').get(item.id);
                  if (!product || product.quantity < item.quantity) {
                    throw Object.assign(new Error(`Estoque insuficiente para reativar o pedido (${item.name}).`), { statusCode: 409 });
                  }
                }
                for (const item of items) {
                  database.prepare('UPDATE products SET quantity = quantity - ?, updated_at = ? WHERE id = ?').run(item.quantity, now, item.id);
                }
              } else if (body.status === 'CANCELADO') {
                for (const item of items) {
                  database.prepare('UPDATE products SET quantity = quantity + ?, updated_at = ? WHERE id = ?').run(item.quantity, now, item.id);
                }
              }
              database.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(body.status, now, match[1]);
            }
            database.exec('COMMIT');
          } catch (error) {
            database.exec('ROLLBACK');
            throw error;
          }
          return sendJson(response, 200, { order: publicOrder(findOrder.get(match[1])) });
        }
        return sendJson(response, 404, { error: 'Rota administrativa não encontrada.' });
      }
      if (request.method === 'GET' && await serveStatic(response, url.pathname)) return;
      return sendJson(response, 404, { error: 'Página ou rota não encontrada.' });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error.statusCode) return sendJson(response, error.statusCode, { error: error.message });
      console.error('Falha ao processar solicitação:', error);
      return sendJson(response, 500, { error: 'Não foi possível concluir a solicitação. Tente novamente.' });
    }
  });
  return { server, database };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const adminPassword = process.env.GELABRE_ADMIN_PASSWORD;
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const databasePath = process.env.GELABRE_DB_PATH || join(projectDir, 'data', 'orders.sqlite');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT deve ser um número entre 1 e 65535.');
  const { server, database } = await createApplication({ adminPassword, databasePath });
  server.listen(port, host, () => {
    console.log(`Gelabrê online em http://${host}:${port}`);
    console.log(`Painel de pedidos: http://${host}:${port}/admin`);
    console.log(`Pedidos serão gravados em ${databasePath}`);
  });
  const shutdown = () => server.close(() => {
    database.close();
    process.exit(0);
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
