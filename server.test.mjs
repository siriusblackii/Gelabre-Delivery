import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, isStoreOpen } from './server.mjs';

async function configureOpeningHours(baseUrl, cookie) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday);
  const minute = Number(values.hour) * 60 + Number(values.minute);
  const toTime = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  const openingHours = Array.from({ length: 7 }, () => ({ enabled: false, open: '09:00', close: '18:00' }));
  openingHours[dayIndex] = { enabled: true, open: toTime(Math.max(0, minute - 1)), close: toTime((minute + 2) % 1440) };
  const response = await fetch(`${baseUrl}/api/admin/opening-hours`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ openingHours })
  });
  assert.equal(response.status, 200);
  return openingHours;
}

test('checks weekly opening hours and overnight closing in Brasília time', () => {
  const openingHours = Array.from({ length: 7 }, () => ({ enabled: false, open: '09:00', close: '18:00' }));
  openingHours[4] = { enabled: true, open: '22:00', close: '02:00' };
  assert.equal(isStoreOpen(openingHours, new Date('2026-10-16T02:30:00.000Z')), true);
  assert.equal(isStoreOpen(openingHours, new Date('2026-10-16T04:00:00.000Z')), true);
  assert.equal(isStoreOpen(openingHours, new Date('2026-10-16T05:00:00.000Z')), false);
});

test('accepts orders, protects the panel, and persists status changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gelabre-backend-'));
  const { server, database } = await createApplication({
    databasePath: join(directory, 'orders.sqlite'),
    adminPassword: 'senha-forte-de-teste'
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'senha-forte-de-teste' })
  });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get('set-cookie').split(';', 1)[0];
  await configureOpeningHours(baseUrl, cookie);

  const orderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: 'Cliente de teste',
      phone: '5591999999999',
      address: 'Rua de teste, 123',
      payment: 'Pix',
      items: [{ id: 101, name: 'Geladinho de morango', price: 12, quantity: 2 }]
    })
  });
  assert.equal(orderResponse.status, 201);
  const orderCreated = await orderResponse.json();
  assert.equal(orderCreated.totalCents, 2400);
  assert.equal(orderCreated.status, 'RECEBIDO');

  const unauthorized = await fetch(`${baseUrl}/api/admin/orders`);
  assert.equal(unauthorized.status, 401);

  const listResponse = await fetch(`${baseUrl}/api/admin/orders`, { headers: { Cookie: cookie } });
  const list = await listResponse.json();
  assert.equal(list.orders.length, 1);
  assert.equal(list.orders[0].customer, 'Cliente de teste');

  const statusResponse = await fetch(`${baseUrl}/api/admin/orders/${orderCreated.id}/status`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'EM_PREPARO' })
  });
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).order.status, 'EM_PREPARO');

  const cancelResponse = await fetch(`${baseUrl}/api/admin/orders/${orderCreated.id}/status`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'CANCELADO' })
  });
  assert.equal(cancelResponse.status, 200);
  const stockAfterCancellation = await fetch(`${baseUrl}/api/admin/products`, { headers: { Cookie: cookie } });
  const productsAfterCancellation = await stockAfterCancellation.json();
  assert.equal(productsAfterCancellation.products.find(product => product.id === 101).quantity, 10);
});

test('rejects malformed orders and cross-origin order submissions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gelabre-backend-'));
  const { server, database } = await createApplication({
    databasePath: join(directory, 'orders.sqlite'),
    adminPassword: 'senha-forte-de-teste'
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const invalidOrder = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer: 'Sem produtos' })
  });
  assert.equal(invalidOrder.status, 400);

  const cardPaymentOrder = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: 'Cliente de teste',
      phone: '5591999999999',
      address: 'Rua de teste, 123',
      payment: 'Cartão na entrega',
      items: [{ id: 101, quantity: 1 }]
    })
  });
  assert.equal(cardPaymentOrder.status, 400);

  const crossOrigin = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(crossOrigin.status, 403);
});

test('shares product visibility and prevents orders exceeding server stock', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gelabre-backend-'));
  const { server, database } = await createApplication({
    databasePath: join(directory, 'orders.sqlite'),
    adminPassword: 'senha-forte-de-teste'
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'senha-forte-de-teste' })
  });
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  await configureOpeningHours(baseUrl, cookie);
  const invalidWhatsApp = await fetch(`${baseUrl}/api/admin/settings`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ whatsapp: '123' })
  });
  assert.equal(invalidWhatsApp.status, 400);
  const invalidDeliveryFee = await fetch(`${baseUrl}/api/admin/delivery-settings`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveryFee: -1, freeDelivery: false, whatsapp: '5591999999999' })
  });
  assert.equal(invalidDeliveryFee.status, 400);
  const validWhatsApp = await fetch(`${baseUrl}/api/admin/settings`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ whatsapp: '+55 (91) 99999-9999' })
  });
  assert.equal(validWhatsApp.status, 200);
  assert.equal((await validWhatsApp.json()).settings.whatsapp, '5591999999999');
  const deliverySettings = await fetch(`${baseUrl}/api/admin/delivery-settings`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveryFee: 4.5, freeDelivery: false, whatsapp: '5591999999999' })
  });
  assert.equal(deliverySettings.status, 200);
  assert.equal((await deliverySettings.json()).settings.deliveryFeeCents, 450);
  const savedSettings = await fetch(`${baseUrl}/api/admin/settings`, { headers: { Cookie: cookie } });
  const storedSettings = (await savedSettings.json()).settings;
  assert.equal(storedSettings.whatsapp, '5591999999999');
  assert.equal(storedSettings.deliveryFeeCents, 450);
  assert.equal(storedSettings.freeDelivery, false);
  const savedStoreDetails = await fetch(`${baseUrl}/api/admin/settings`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pixKey: 'pix-teste', whatsapp: '5591999999999' })
  });
  assert.equal(savedStoreDetails.status, 200);
  const settingsAfterStoreDetails = (await (await fetch(`${baseUrl}/api/admin/settings`, { headers: { Cookie: cookie } })).json()).settings;
  assert.equal(settingsAfterStoreDetails.deliveryFeeCents, 450);

  const newProductResponse = await fetch(`${baseUrl}/api/admin/products`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Geladinho novo de teste',
      description: 'Produto recém-cadastrado',
      price: 7.5,
      quantity: 3,
      visible: true,
      image: ''
    })
  });
  assert.equal(newProductResponse.status, 201);
  const newProduct = (await newProductResponse.json()).product;
  let publicCatalog = await (await fetch(`${baseUrl}/api/products`)).json();
  assert.equal(publicCatalog.products.some(product => product.id === newProduct.id), true);

  const hiddenNewProduct = await fetch(`${baseUrl}/api/admin/products/${newProduct.id}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...newProduct, visible: false, expectedUpdatedAt: newProduct.updatedAt })
  });
  assert.equal(hiddenNewProduct.status, 200);
  publicCatalog = await (await fetch(`${baseUrl}/api/products`)).json();
  assert.equal(publicCatalog.products.some(product => product.id === newProduct.id), false);

  const productUrl = `${baseUrl}/api/admin/products/101`;
  const updateProduct = async product => fetch(productUrl, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(product)
  });
  const currentResponse = await fetch(`${baseUrl}/api/admin/products`, { headers: { Cookie: cookie } });
  const current = (await currentResponse.json()).products.find(product => product.id === 101);
  const hiddenResponse = await updateProduct({ ...current, visible: false, quantity: 1, expectedUpdatedAt: current.updatedAt });
  assert.equal(hiddenResponse.status, 200);
  let publicProducts = await (await fetch(`${baseUrl}/api/products`)).json();
  assert.equal(publicProducts.products.some(product => product.id === 101), false);

  const hiddenProduct = (await (await fetch(`${baseUrl}/api/admin/products`, { headers: { Cookie: cookie } })).json()).products.find(product => product.id === 101);
  const visibleResponse = await updateProduct({ ...hiddenProduct, visible: true, quantity: 1, expectedUpdatedAt: hiddenProduct.updatedAt });
  assert.equal(visibleResponse.status, 200);
  publicProducts = await (await fetch(`${baseUrl}/api/products`)).json();
  const publicProduct = publicProducts.products.find(product => product.id === 101);
  assert.equal(publicProduct.quantity, 1);
  assert.equal(publicProduct.price, 12);

  const makeOrder = quantity => fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: 'Cliente estoque',
      phone: '5591999999999',
      address: 'Rua de teste, 123',
      payment: 'Pix',
      items: [{ id: 101, quantity }]
    })
  });
  const firstPurchase = await makeOrder(1);
  assert.equal(firstPurchase.status, 201);
  const chargedOrder = await firstPurchase.clone().json();
  assert.equal(chargedOrder.subtotalCents, 1200);
  assert.equal(chargedOrder.deliveryFeeCents, 450);
  assert.equal(chargedOrder.totalCents, 1650);
  const staleUpdate = await updateProduct({ ...publicProduct, quantity: 1, expectedUpdatedAt: publicProduct.updatedAt });
  assert.equal(staleUpdate.status, 409);
  const unavailableProducts = await (await fetch(`${baseUrl}/api/products`)).json();
  assert.equal(unavailableProducts.products.some(product => product.id === 101), false);
  const oversoldOrder = await makeOrder(1);
  assert.equal(oversoldOrder.status, 409);

  const resetResponse = await fetch(`${baseUrl}/api/admin/products/reset`, {
    method: 'POST',
    headers: { Cookie: cookie }
  });
  assert.equal(resetResponse.status, 200);
  const resetProducts = (await resetResponse.json()).products;
  assert.equal(resetProducts.some(product => product.id === 101), false);

  const freeDeliverySettings = await fetch(`${baseUrl}/api/admin/delivery-settings`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveryFee: 4.5, freeDelivery: true, whatsapp: '5591999999999' })
  });
  assert.equal(freeDeliverySettings.status, 200);
  const freeDeliveryOrderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: 'Cliente entrega grátis',
      phone: '5591999999999',
      address: 'Rua de teste, 123',
      payment: 'Pix',
      items: [{ id: resetProducts[0].id, quantity: 1 }]
    })
  });
  assert.equal(freeDeliveryOrderResponse.status, 201);
  const freeDeliveryOrder = await freeDeliveryOrderResponse.json();
  assert.equal(freeDeliveryOrder.deliveryFeeCents, 0);
  assert.equal(freeDeliveryOrder.totalCents, freeDeliveryOrder.subtotalCents);

  const cancelOldOrder = await fetch(`${baseUrl}/api/admin/orders/${(await firstPurchase.json()).id}/status`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'CANCELADO' })
  });
  assert.equal(cancelOldOrder.status, 200);
  assert.equal(resetProducts[0].quantity, 10);
});

test('deletes selected orders and releases stock only for unfinished orders', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gelabre-backend-'));
  const { server, database } = await createApplication({
    databasePath: join(directory, 'orders.sqlite'),
    adminPassword: 'senha-forte-de-teste'
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'senha-forte-de-teste' })
  });
  const cookie = loginResponse.headers.get('set-cookie').split(';', 1)[0];
  await configureOpeningHours(baseUrl, cookie);
  const makeOrder = async customer => {
    const response = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer,
        phone: '5591999999999',
        address: 'Rua de teste, 123',
        payment: 'Pix',
        items: [{ id: 101, quantity: 1 }]
      })
    });
    assert.equal(response.status, 201);
    return response.json();
  };
  const unfinishedOrder = await makeOrder('Pedido ainda não concluído');
  const completedOrder = await makeOrder('Pedido concluído');
  const completeResponse = await fetch(`${baseUrl}/api/admin/orders/${completedOrder.id}/status`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'CONCLUIDO' })
  });
  assert.equal(completeResponse.status, 200);

  const deleteResponse = await fetch(`${baseUrl}/api/admin/orders`, {
    method: 'DELETE',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [unfinishedOrder.id, completedOrder.id] })
  });
  assert.equal(deleteResponse.status, 200);
  assert.equal((await deleteResponse.json()).deletedCount, 2);

  const remainingOrders = await fetch(`${baseUrl}/api/admin/orders`, { headers: { Cookie: cookie } });
  assert.deepEqual((await remainingOrders.json()).orders, []);
  const remainingProducts = await fetch(`${baseUrl}/api/admin/products`, { headers: { Cookie: cookie } });
  assert.equal((await remainingProducts.json()).products.find(product => product.id === 101).quantity, 9);

  const invalidDelete = await fetch(`${baseUrl}/api/admin/orders`, {
    method: 'DELETE',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [] })
  });
  assert.equal(invalidDelete.status, 400);
});

test('requires configured opening hours and rejects orders while the store is closed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gelabre-backend-'));
  const { server, database } = await createApplication({
    databasePath: join(directory, 'orders.sqlite'),
    adminPassword: 'senha-forte-de-teste'
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const publicSettings = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.equal(publicSettings.settings.isOpen, false);
  assert.equal(publicSettings.settings.openingHours.length, 7);
  assert.equal(publicSettings.settings.openingHours.some(day => day.enabled), false);

  const order = {
    customer: 'Cliente fora do horário',
    phone: '5591999999999',
    address: 'Rua de teste, 123',
    payment: 'Pix',
    items: [{ id: 101, quantity: 1 }]
  };
  const closedOrder = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(order)
  });
  assert.equal(closedOrder.status, 409);

  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'senha-forte-de-teste' })
  });
  const cookie = loginResponse.headers.get('set-cookie').split(';', 1)[0];
  const invalidHours = Array.from({ length: 7 }, () => ({ enabled: false, open: '09:00', close: '18:00' }));
  invalidHours[0] = { enabled: true, open: '10:00', close: '10:00' };
  const invalidSave = await fetch(`${baseUrl}/api/admin/opening-hours`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ openingHours: invalidHours })
  });
  assert.equal(invalidSave.status, 400);

  await configureOpeningHours(baseUrl, cookie);
  const openSettings = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.equal(openSettings.settings.isOpen, true);
  const acceptedOrder = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(order)
  });
  assert.equal(acceptedOrder.status, 201);
});
