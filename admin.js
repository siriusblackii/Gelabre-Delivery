const statuses = [
  ['RECEBIDO', 'Recebido'],
  ['CONFIRMADO', 'Confirmado'],
  ['EM_PREPARO', 'Em preparo'],
  ['SAIU_PARA_ENTREGA', 'Saiu para entrega'],
  ['CONCLUIDO', 'Concluído'],
  ['CANCELADO', 'Cancelado']
];
let orders = [];
let products = [];
let editingProductId = null;
const openingHoursDays = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const settingsFields = [
  ['pixKey', 'pixkey'],
  ['merchant', 'merchant'],
  ['city', 'city'],
  ['pixdesc', 'pixdesc'],
  ['whatsapp', 'whatsapp']
];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const money = cents => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const productMoney = price => Number(price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function renderOpeningHours(openingHours) {
  document.getElementById('opening-hours-fields').innerHTML = openingHours.map((day, index) => `
    <div class="opening-hour-row">
      <label class="opening-day"><input type="checkbox" data-day-index="${index}" ${day.enabled ? 'checked' : ''}>${openingHoursDays[index]}</label>
      <label class="opening-time"><span>Abre</span><input type="time" data-opening-time="${index}" value="${escapeHtml(day.open)}" ${day.enabled ? '' : 'disabled'}></label>
      <label class="opening-time"><span>Fecha</span><input type="time" data-closing-time="${index}" value="${escapeHtml(day.close)}" ${day.enabled ? '' : 'disabled'}></label>
    </div>`).join('');
}

function readOpeningHoursForm() {
  return openingHoursDays.map((day, index) => ({
    enabled: document.querySelector(`[data-day-index="${index}"]`).checked,
    open: document.querySelector(`[data-opening-time="${index}"]`).value,
    close: document.querySelector(`[data-closing-time="${index}"]`).value
  }));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Não foi possível concluir a solicitação.');
  return result;
}

function showLogin(message = '') {
  document.getElementById('login-panel').hidden = false;
  document.getElementById('orders-panel').hidden = true;
  document.getElementById('header-actions').hidden = true;
  document.getElementById('login-error').textContent = message;
}

function showAdminSection(sectionName) {
  for (const section of document.querySelectorAll('[data-admin-section]')) {
    section.hidden = section.dataset.adminSection !== sectionName;
  }
  for (const button of document.querySelectorAll('[data-admin-tab]')) {
    const selected = button.dataset.adminTab === sectionName;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
}

function showAdminPanel() {
  document.getElementById('login-panel').hidden = true;
  document.getElementById('orders-panel').hidden = false;
  document.getElementById('header-actions').hidden = false;
  showAdminSection('orders');
}

function loadCatalog() {
  return Promise.all([api('/api/admin/products'), api('/api/admin/settings')]).then(([catalog, result]) => {
    products = catalog.products;
    const settings = result.settings;
    renderOpeningHours(settings.openingHours);
    for (const [field, elementId] of settingsFields) {
      document.getElementById(elementId).value = settings[field] || '';
    }
    document.getElementById('delivery-fee').value = (settings.deliveryFeeCents / 100).toFixed(2);
    document.getElementById('free-delivery').checked = settings.freeDelivery;
    renderProducts();
    document.getElementById('product-sync-status').textContent = `Lista atualizada às ${new Date().toLocaleTimeString('pt-BR')}.`;
  }).catch(error => {
    document.getElementById('product-error').textContent = `Não foi possível carregar os dados da loja: ${error.message}`;
  });
}

async function refreshProducts() {
  const button = document.getElementById('refresh-products-button');
  const status = document.getElementById('product-sync-status');
  button.disabled = true;
  status.textContent = 'Atualizando produtos...';
  try {
    const result = await api('/api/admin/products');
    products = result.products;
    renderProducts();
    status.textContent = `Lista atualizada às ${new Date().toLocaleTimeString('pt-BR')}.`;
    document.getElementById('product-error').textContent = '';
  } catch (error) {
    status.textContent = '';
    document.getElementById('product-error').textContent = `Não foi possível atualizar os produtos: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function renderProducts() {
  const list = document.getElementById('product-list');
  if (!products.length) {
    list.innerHTML = '<div class="empty">Nenhum geladinho cadastrado.</div>';
    return;
  }
  list.innerHTML = products.map(product => `
    <article class="product-row">
      <div class="product-info"><strong>${escapeHtml(product.name)}</strong><small>${productMoney(product.price)} · ${product.quantity} disponível · ${product.visible ? 'visível' : 'oculto'}</small></div>
      <div class="product-actions">
        <button class="secondary" type="button" data-action="edit" data-product-id="${escapeHtml(product.id)}">Editar</button>
        <button class="danger" type="button" data-action="delete" data-product-id="${escapeHtml(product.id)}">Excluir</button>
      </div>
    </article>`).join('');
}

function resetProductForm() {
  editingProductId = null;
  document.getElementById('product-form').reset();
  document.getElementById('product-form-title').textContent = 'Adicionar geladinho';
  document.getElementById('save-product-button').textContent = 'Adicionar produto';
  document.getElementById('cancel-edit-button').hidden = true;
  document.getElementById('image-hint').textContent = 'Opcional. Uma nova foto substitui a foto atual.';
}

function editProduct(id) {
  const product = products.find(item => String(item.id) === String(id));
  if (!product) return;
  editingProductId = product.id;
  document.getElementById('product-name').value = product.name;
  document.getElementById('product-price').value = product.price;
  document.getElementById('product-quantity').value = product.quantity;
  document.getElementById('product-visible').checked = product.visible;
  document.getElementById('product-description').value = product.description || '';
  document.getElementById('product-image').value = '';
  document.getElementById('product-form-title').textContent = 'Editar geladinho';
  document.getElementById('save-product-button').textContent = 'Salvar alterações';
  document.getElementById('cancel-edit-button').hidden = false;
  document.getElementById('image-hint').textContent = product.image ? 'A foto atual será mantida se nenhuma nova for escolhida.' : 'Opcional. Escolha uma foto para este produto.';
  document.getElementById('product-name').focus();
}

function readProductImage(file) {
  if (!file) return Promise.resolve(null);
  if (!file.type.startsWith('image/')) return Promise.reject(new Error('Escolha um arquivo de imagem.'));
  if (file.size > 2 * 1024 * 1024) return Promise.reject(new Error('A foto deve ter no máximo 2 MB.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Não foi possível ler a foto escolhida.'));
    reader.readAsDataURL(file);
  });
}

async function saveProduct(event) {
  event.preventDefault();
  const error = document.getElementById('product-error');
  error.textContent = '';
  const name = document.getElementById('product-name').value.trim();
  const rawPrice = document.getElementById('product-price').value;
  const price = Number(rawPrice);
  const description = document.getElementById('product-description').value.trim();
  if (!name || rawPrice === '' || !Number.isFinite(price) || price < 0) {
    error.textContent = 'Informe um nome e um preço válido para o produto.';
    return;
  }
  try {
    const image = await readProductImage(document.getElementById('product-image').files[0]);
    const original = products.find(product => product.id === editingProductId);
    if (editingProductId !== null && !original) throw new Error('O produto não está mais disponível para edição.');
    const product = {
      name,
      description,
      price,
      quantity: Number(document.getElementById('product-quantity').value),
      visible: document.getElementById('product-visible').checked,
      image: image || original?.image || '',
      ...(original ? { expectedUpdatedAt: original.updatedAt } : {})
    };
    if (!Number.isInteger(product.quantity) || product.quantity < 0 || product.quantity > 1000000) {
      throw new Error('Informe uma quantidade inteira entre 0 e 1.000.000.');
    }
    const path = editingProductId === null ? '/api/admin/products' : `/api/admin/products/${editingProductId}`;
    const result = await api(path, { method: editingProductId === null ? 'POST' : 'PUT', body: JSON.stringify(product) });
    if (editingProductId === null) products.push(result.product);
    else products = products.map(item => item.id === editingProductId ? result.product : item);
    resetProductForm();
    renderProducts();
    document.getElementById('product-sync-status').textContent = `Lista atualizada às ${new Date().toLocaleTimeString('pt-BR')}.`;
  } catch (failure) {
    error.textContent = `Não foi possível salvar o produto: ${failure.message}`;
  }
}

function deleteProduct(id) {
  const product = products.find(item => String(item.id) === String(id));
  if (!product || !confirm(`Excluir "${product.name}" do cardápio? Essa ação não pode ser desfeita.`)) return;
  api(`/api/admin/products/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => {
    products = products.filter(item => String(item.id) !== String(id));
    if (String(editingProductId) === String(id)) resetProductForm();
    renderProducts();
  }).catch(error => {
    document.getElementById('product-error').textContent = `Não foi possível salvar a exclusão: ${error.message}`;
  });
}

function saveSettings(event) {
  event.preventDefault();
  const settings = Object.fromEntries(settingsFields
    .map(([field, elementId]) => [field, document.getElementById(elementId).value.trim()]));
  settings.whatsapp = settings.whatsapp.replace(/\D/g, '');
  if (settings.whatsapp && !/^[1-9]\d{7,14}$/.test(settings.whatsapp)) {
    document.getElementById('settings-success').textContent = '';
    document.getElementById('settings-error').textContent = 'Informe o WhatsApp com código do país, DDD e número, entre 8 e 15 dígitos.';
    return;
  }
  api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(settings) }).then(() => {
    document.getElementById('settings-error').textContent = '';
    document.getElementById('settings-success').textContent = 'Dados da loja salvos no servidor.';
  }).catch(error => {
    document.getElementById('settings-success').textContent = '';
    document.getElementById('settings-error').textContent = `Não foi possível salvar os dados: ${error.message}`;
  });
}

async function saveOpeningHours(event) {
  event.preventDefault();
  const error = document.getElementById('opening-hours-error');
  const success = document.getElementById('opening-hours-success');
  const button = document.getElementById('save-opening-hours-button');
  error.textContent = '';
  success.textContent = '';
  button.disabled = true;
  try {
    const result = await api('/api/admin/opening-hours', {
      method: 'PUT',
      body: JSON.stringify({ openingHours: readOpeningHoursForm() })
    });
    renderOpeningHours(result.settings.openingHours);
    success.textContent = 'Horário de funcionamento salvo e já aplicado à página da loja.';
  } catch (failure) {
    error.textContent = `Não foi possível salvar o horário: ${failure.message}`;
  } finally {
    button.disabled = false;
  }
}

async function saveDeliverySettings(event) {
  event.preventDefault();
  const error = document.getElementById('delivery-settings-error');
  const success = document.getElementById('delivery-settings-success');
  const button = document.getElementById('save-delivery-settings-button');
  error.textContent = '';
  success.textContent = '';
  button.disabled = true;
  try {
    const rawFee = document.getElementById('delivery-fee').value;
    const deliveryFee = rawFee === '' ? 0 : Number(rawFee);
    const result = await api('/api/admin/delivery-settings', {
      method: 'PUT',
      body: JSON.stringify({ deliveryFee, freeDelivery: document.getElementById('free-delivery').checked })
    });
    document.getElementById('delivery-fee').value = (result.settings.deliveryFeeCents / 100).toFixed(2);
    document.getElementById('free-delivery').checked = result.settings.freeDelivery;
    success.textContent = result.settings.freeDelivery
      ? 'Entrega grátis salva. Nenhuma taxa será cobrada nos novos pedidos.'
      : 'Taxa de entrega salva e aplicada aos novos pedidos.';
  } catch (failure) {
    error.textContent = `Não foi possível salvar a taxa de entrega: ${failure.message}`;
  } finally {
    button.disabled = false;
  }
}

function exportMenu() {
  const settings = Object.fromEntries(settingsFields
    .map(([field, elementId]) => [field, document.getElementById(elementId).value]));
  settings.deliveryFee = Number(document.getElementById('delivery-fee').value || 0);
  settings.freeDelivery = document.getElementById('free-delivery').checked;
  settings.openingHours = readOpeningHoursForm();
  const blob = new Blob([JSON.stringify({ products, settings }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'gelabre-cardapio.json';
  link.click();
  URL.revokeObjectURL(url);
}

function resetMenu() {
  if (!confirm('Restaurar os produtos de exemplo? O cardápio atual da loja será substituído.')) return;
  api('/api/admin/products/reset', { method: 'POST' }).then(result => {
    products = result.products;
    resetProductForm();
    renderProducts();
  }).catch(error => {
    document.getElementById('product-error').textContent = `Não foi possível restaurar os exemplos: ${error.message}`;
  });
}

function orderDayKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function orderDayLabel(value) {
  const date = new Date(value);
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dayOffset = Math.round((todayStart - startOfDay) / 86400000);
  const formatted = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(date);
  if (dayOffset === 0) return `Hoje · ${formatted}`;
  if (dayOffset === 1) return `Ontem · ${formatted}`;
  return formatted;
}

function renderOrder(order) {
  return `
    <article class="order">
      <div class="order-head">
        <div><h3>Pedido ${escapeHtml(order.id.slice(0, 8).toUpperCase())}</h3>
          <p>${new Date(order.createdAt).toLocaleString('pt-BR')}</p></div>
        <div class="status-row"><label for="status-${escapeHtml(order.id)}">Status</label>
          <select id="status-${escapeHtml(order.id)}" data-order-id="${escapeHtml(order.id)}">
            ${statuses.map(([value, label]) => `<option value="${value}" ${value === order.status ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="order-info">
        <div><strong>Cliente</strong><p>${escapeHtml(order.customer)} · ${escapeHtml(order.phone)}</p>
          <strong>Endereço</strong><p>${escapeHtml(order.address)}</p>
          ${order.location ? `<p><a href="${escapeHtml(order.location)}" target="_blank" rel="noopener noreferrer">Abrir localização</a></p>` : ''}
        </div>
        <div><strong>Itens</strong><ul class="order-items">${order.items.map(item => `<li>${item.quantity}× ${escapeHtml(item.name)} — ${money(item.unitPriceCents * item.quantity)}</li>`).join('')}</ul>
          <p><strong>Pagamento:</strong> ${escapeHtml(order.payment)}</p>
          ${order.change ? `<p><strong>Troco:</strong> ${escapeHtml(order.change)}</p>` : ''}
          ${order.notes ? `<p><strong>Observações:</strong> ${escapeHtml(order.notes)}</p>` : ''}
          <p>Subtotal: ${money(order.subtotalCents)}</p>
          <p>Taxa de entrega: ${order.deliveryFeeCents ? money(order.deliveryFeeCents) : 'Grátis'}</p>
          <p class="total">Total: ${money(order.totalCents)}</p>
        </div>
      </div>
    </article>`;
}

function renderOrders() {
  const filter = document.getElementById('status-filter').value;
  const visible = orders.filter(order => !filter || order.status === filter);
  const container = document.getElementById('orders');
  document.getElementById('delete-listed-orders-button').disabled = visible.length === 0;
  if (!visible.length) {
    container.innerHTML = '<div class="empty">Nenhum pedido encontrado.</div>';
    return;
  }
  const groups = new Map();
  for (const order of visible) {
    const key = orderDayKey(order.createdAt);
    if (!groups.has(key)) groups.set(key, { label: orderDayLabel(order.createdAt), orders: [] });
    groups.get(key).orders.push(order);
  }
  container.innerHTML = Array.from(groups.values(), group => `
    <section class="order-day">
      <h3 class="order-day-title">${escapeHtml(group.label)}</h3>
      ${group.orders.map(renderOrder).join('')}
    </section>`).join('');
}

async function deleteListedOrders() {
  const filter = document.getElementById('status-filter').value;
  const listedOrders = orders.filter(order => !filter || order.status === filter);
  if (!listedOrders.length) return;
  const dateLabel = filter
    ? `com o status "${statuses.find(([value]) => value === filter)?.[1] || filter}"`
    : 'listados no painel';
  if (!confirm(`Excluir permanentemente ${listedOrders.length} pedido(s) ${dateLabel}? Pedidos ainda não concluídos liberarão o estoque reservado. Esta ação não pode ser desfeita.`)) return;
  const button = document.getElementById('delete-listed-orders-button');
  const error = document.getElementById('orders-error');
  error.textContent = '';
  button.disabled = true;
  try {
    await api('/api/admin/orders', {
      method: 'DELETE',
      body: JSON.stringify({ ids: listedOrders.map(order => order.id) })
    });
    await loadOrders();
  } catch (failure) {
    error.textContent = `Não foi possível excluir os pedidos: ${failure.message}`;
    button.disabled = false;
  }
}

async function loadOrders() {
  const error = document.getElementById('orders-error');
  error.textContent = '';
  try {
    const result = await api('/api/admin/orders');
    orders = result.orders;
    renderOrders();
  } catch (failure) {
    if (failure.message.includes('Faça login')) return showLogin(failure.message);
    error.textContent = failure.message;
  }
}

document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: document.getElementById('password').value })
    });
    document.getElementById('password').value = '';
    showAdminPanel();
    loadCatalog();
    await loadOrders();
  } catch (error) {
    document.getElementById('login-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('.admin-sidebar').addEventListener('click', event => {
  const button = event.target.closest('[data-admin-tab]');
  if (button) showAdminSection(button.dataset.adminTab);
});

document.querySelector('.admin-sidebar').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = Array.from(document.querySelectorAll('[data-admin-tab]'));
  const currentIndex = buttons.indexOf(document.activeElement);
  if (currentIndex < 0) return;
  event.preventDefault();
  const nextIndex = event.key === 'Home' ? 0
    : event.key === 'End' ? buttons.length - 1
      : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[nextIndex].focus();
  showAdminSection(buttons[nextIndex].dataset.adminTab);
});

document.getElementById('orders').addEventListener('change', async event => {
  const select = event.target.closest('select[data-order-id]');
  if (!select) return;
  select.disabled = true;
  document.getElementById('orders-error').textContent = '';
  try {
    await api(`/api/admin/orders/${encodeURIComponent(select.dataset.orderId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: select.value })
    });
    await loadOrders();
  } catch (error) {
    const message = error.message;
    await loadOrders();
    document.getElementById('orders-error').textContent = message;
  } finally {
    select.disabled = false;
  }
});

document.getElementById('refresh-button').addEventListener('click', () => {
  loadOrders();
  loadCatalog();
});
document.getElementById('delete-listed-orders-button').addEventListener('click', deleteListedOrders);
document.getElementById('refresh-products-button').addEventListener('click', refreshProducts);
document.getElementById('status-filter').addEventListener('change', renderOrders);
document.getElementById('logout-button').addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST' });
    showLogin();
  } catch (error) {
    document.getElementById('orders-error').textContent = error.message;
  }
});

document.getElementById('product-form').addEventListener('submit', saveProduct);
document.getElementById('cancel-edit-button').addEventListener('click', resetProductForm);
document.getElementById('product-list').addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  if (button.dataset.action === 'edit') editProduct(button.dataset.productId);
  if (button.dataset.action === 'delete') deleteProduct(button.dataset.productId);
});
document.getElementById('settings-form').addEventListener('submit', saveSettings);
document.getElementById('opening-hours-form').addEventListener('submit', saveOpeningHours);
document.getElementById('opening-hours-fields').addEventListener('change', event => {
  const checkbox = event.target.closest('input[type="checkbox"][data-day-index]');
  if (!checkbox) return;
  const index = checkbox.dataset.dayIndex;
  document.querySelector(`[data-opening-time="${index}"]`).disabled = !checkbox.checked;
  document.querySelector(`[data-closing-time="${index}"]`).disabled = !checkbox.checked;
});
document.getElementById('delivery-settings-form').addEventListener('submit', saveDeliverySettings);
document.getElementById('export-menu-button').addEventListener('click', exportMenu);
document.getElementById('reset-menu-button').addEventListener('click', resetMenu);

api('/api/admin/session').then(result => {
  if (result.authenticated) {
    showAdminPanel();
    loadCatalog();
    return loadOrders();
  }
}).catch(error => showLogin(error.message));
