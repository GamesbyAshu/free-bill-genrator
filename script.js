/* =========================================================
   BillBook — script.js
   Offline GST Invoice / Quotation Generator
   Plain HTML/CSS/JS + LocalStorage + jsPDF + html2canvas
   ========================================================= */

/* ---------------------------------------------------------
   1. STORAGE LAYER
   Thin wrapper around LocalStorage with JSON (de)serialisation
   and namespaced keys, so all persistence goes through here.
   --------------------------------------------------------- */
const STORE_KEYS = {
  BUSINESS:   'billbook.business',
  CUSTOMERS:  'billbook.customers',
  PRODUCTS:   'billbook.products',
  INVOICES:   'billbook.invoices',
  SETTINGS:   'billbook.settings',
  DRAFT:      'billbook.draft' // in-progress invoice, auto-saved so refresh doesn't lose work
};

const Store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      console.warn('Store.get failed for', key, e);
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('Store.set failed for', key, e);
      showToast('Storage full or unavailable — could not save.');
      return false;
    }
  },
  remove(key) { localStorage.removeItem(key); }
};

/* ---------------------------------------------------------
   2. CONSTANTS
   --------------------------------------------------------- */
const GST_RATES = [0, 5, 12, 18, 28];

const CHARGE_TYPES = ['Transport', 'Installation', 'Packing', 'Labour', 'Custom Charge'];

const DEFAULT_SETTINGS = {
  invoicePrefix: 'INV-',
  invoiceNext: 1,
  quotePrefix: 'QTN-',
  quoteNext: 1
};

/* ---------------------------------------------------------
   3. APP STATE
   `state` holds the invoice currently being edited.
   This is the single source of truth the preview renders from.
   --------------------------------------------------------- */
let state = {
  business: {
    logo: '', shopName: '', legalName: '', gst: '', phone: '', email: '', website: '', address: '',
    bankName: '', bankAccount: '', bankIFSC: '', bankBranch: '', signature: ''
  },
  customer: {
    id: '', name: '', phone: '', address: '', gst: '', pin: ''
  },
  doc: {
    type: 'invoice',          // 'invoice' | 'quotation'
    number: '',
    date: '',
    dueDate: '',
    placeOfSupply: '',
    gstMode: 'exclusive'       // 'exclusive' | 'inclusive'
  },
  items: [],   // { id, name, hsn, qty, price, gst }
  discount: { type: 'amount', value: 0 },
  charges: [], // { id, label, amount }
  terms: '',
  internalNotes: '',
  // bookkeeping (not edited directly by user)
  savedId: null // set once this invoice has been saved, so "Save" updates rather than duplicates
};

let customers = [];   // customer library
let products  = [];   // product library
let invoices  = [];   // saved invoices
let settings  = { ...DEFAULT_SETTINGS };

let idCounter = 1;
function nextId() { return 'r' + (idCounter++) + '_' + Date.now().toString(36); }

/* ---------------------------------------------------------
   4. UTILITIES
   --------------------------------------------------------- */

// Round to 2 decimals safely (avoids floating point artifacts like 12.000000000000002)
function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function formatINR(n) {
  const num = r2(n);
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  // Indian digit grouping (lakh/crore style): use toLocaleString with en-IN
  const parts = abs.toFixed(2).split('.');
  let intPart = parts[0];
  let lastThree = intPart.slice(-3);
  let other = intPart.slice(0, -3);
  if (other !== '') lastThree = ',' + lastThree;
  const formattedInt = other.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + lastThree;
  return sign + '₹' + formattedInt + '.' + parts[1];
}

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function formatDateDisplay(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d} ${months[parseInt(m,10)-1]} ${y}`;
}

function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function showToast(msg, duration = 2200) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.remove('is-visible');
    setTimeout(() => { toast.hidden = true; }, 250);
  }, duration);
}

// Converts a File object to a base64 data URL (for logo/signature storage in LocalStorage)
function fileToDataURL(file, callback) {
  if (!file) return callback(null);
  const reader = new FileReader();
  reader.onload = () => callback(reader.result);
  reader.onerror = () => { showToast('Could not read that image.'); callback(null); };
  reader.readAsDataURL(file);
}

// Number to Indian words (for "Amount in words" on the invoice)
function numberToWordsIndian(num) {
  num = Math.round(Number(num) || 0);
  if (num === 0) return 'Zero';
  const ones = ['', 'One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten',
    'Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['', '', 'Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];

  function twoDigits(n) {
    if (n < 20) return ones[n];
    return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
  }
  function threeDigits(n) {
    if (n < 100) return twoDigits(n);
    return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + twoDigits(n % 100) : '');
  }

  let crore = Math.floor(num / 10000000); num %= 10000000;
  let lakh  = Math.floor(num / 100000);   num %= 100000;
  let thousand = Math.floor(num / 1000);  num %= 1000;
  let hundred = num;

  let out = [];
  if (crore) out.push(threeDigits(crore) + ' Crore');
  if (lakh) out.push(threeDigits(lakh) + ' Lakh');
  if (thousand) out.push(threeDigits(thousand) + ' Thousand');
  if (hundred) out.push(threeDigits(hundred));
  return out.join(' ');
}

/* ---------------------------------------------------------
   5. GST CALCULATION ENGINE
   Two modes, both must produce: amount (base), gstAmount, cgst, sgst, lineTotal.

   EXCLUSIVE MODE  — qty × unitPrice = base amount; GST is added on top.
   INCLUSIVE MODE  — qty × unitPrice = the FINAL (GST-included) amount;
                      base price and GST are extracted out of it.

   CGST and SGST are each exactly half of the total GST (standard intra-state
   split used on Indian tax invoices for non-IGST transactions).
   --------------------------------------------------------- */
function calcLine(item, gstMode) {
  const qty = Number(item.qty) || 0;
  const price = Number(item.price) || 0;
  const gstPct = Number(item.gst) || 0;

  let amount, gstAmount, lineTotal;

  if (gstMode === 'inclusive') {
    // price entered is the FINAL per-unit price (GST included)
    const finalTotal = r2(qty * price);
    const base = r2(finalTotal / (1 + gstPct / 100));
    amount = base;
    gstAmount = r2(finalTotal - base);
    lineTotal = finalTotal;
  } else {
    // exclusive: price is the base (pre-GST) per-unit price
    amount = r2(qty * price);
    gstAmount = r2(amount * (gstPct / 100));
    lineTotal = r2(amount + gstAmount);
  }

  const cgst = r2(gstAmount / 2);
  const sgst = r2(gstAmount - cgst); // avoids rounding mismatch (sgst absorbs remainder)

  return { qty, price, gstPct, amount, gstAmount, cgst, sgst, lineTotal };
}

// Computes a full breakdown for every item, plus invoice-level totals,
// discount application, charges, and grand total.
// This is the single function the live preview and PDF export both depend on.
function computeInvoiceTotals() {
  const gstMode = state.doc.gstMode;
  const lineResults = state.items.map(item => ({ item, calc: calcLine(item, gstMode) }));

  const totalQty   = lineResults.reduce((s, l) => s + l.calc.qty, 0);
  const subtotal   = r2(lineResults.reduce((s, l) => s + l.calc.amount, 0));
  const cgstTotal  = r2(lineResults.reduce((s, l) => s + l.calc.cgst, 0));
  const sgstTotal  = r2(lineResults.reduce((s, l) => s + l.calc.sgst, 0));
  const gstTotal   = r2(cgstTotal + sgstTotal);

  // Discount is applied on (subtotal + GST) i.e. on the pre-charges invoice value.
  // This matches common shopkeeper practice of discounting the billed amount.
  const preDiscountTotal = r2(subtotal + gstTotal);
  let discountAmount = 0;
  if (state.discount.value > 0) {
    if (state.discount.type === 'percent') {
      discountAmount = r2(preDiscountTotal * (Number(state.discount.value) / 100));
    } else {
      discountAmount = r2(Number(state.discount.value));
    }
  }
  discountAmount = Math.min(discountAmount, preDiscountTotal); // never negative total

  const chargesTotal = r2(state.charges.reduce((s, c) => s + (Number(c.amount) || 0), 0));

  const grandTotalRaw = r2(preDiscountTotal - discountAmount + chargesTotal);
  const grandTotal = Math.round(grandTotalRaw); // round to nearest rupee for the headline total
  const roundOff = r2(grandTotal - grandTotalRaw);

  // GST rate-wise summary (e.g. "18% GST on ₹4,200 base") for the tax summary table
  const gstByRate = {};
  lineResults.forEach(({ calc }) => {
    const key = calc.gstPct;
    if (!gstByRate[key]) gstByRate[key] = { rate: key, base: 0, cgst: 0, sgst: 0, total: 0 };
    gstByRate[key].base += calc.amount;
    gstByRate[key].cgst += calc.cgst;
    gstByRate[key].sgst += calc.sgst;
    gstByRate[key].total += calc.gstAmount;
  });
  const gstSummaryRows = Object.values(gstByRate)
    .map(row => ({ rate: row.rate, base: r2(row.base), cgst: r2(row.cgst), sgst: r2(row.sgst), total: r2(row.total) }))
    .sort((a, b) => a.rate - b.rate);

  return {
    lineResults, totalQty, subtotal, cgstTotal, sgstTotal, gstTotal,
    discountAmount, chargesTotal, grandTotal, roundOff, gstSummaryRows,
    preDiscountTotal
  };
}

/* ---------------------------------------------------------
   6. ITEM ROW MANAGEMENT
   --------------------------------------------------------- */
function addItem(prefill) {
  const item = {
    id: nextId(),
    name: prefill?.name || '',
    hsn: prefill?.hsn || '',
    qty: prefill?.qty ?? 1,
    price: prefill?.price ?? '',
    gst: prefill?.gst ?? 18
  };
  state.items.push(item);
  renderItems();
  scheduleAutosave();
  renderInvoicePreview();
}

function removeItem(id) {
  state.items = state.items.filter(i => i.id !== id);
  renderItems();
  scheduleAutosave();
  renderInvoicePreview();
}

function updateItem(id, field, value) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  item[field] = value;
  scheduleAutosave();
  renderInvoicePreview();
  // Update only this row's calculated breakdown text without a full re-render (keeps focus/cursor intact)
  updateItemBreakdownDisplay(id);
}

function updateItemBreakdownDisplay(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  const row = document.querySelector(`.item-card[data-id="${id}"]`);
  if (!row) return;
  const calc = calcLine(item, state.doc.gstMode);
  const bd = row.querySelector('.item-card__breakdown');
  if (bd) bd.innerHTML = itemBreakdownHTML(calc);
}

function itemBreakdownHTML(calc) {
  return `
    <span>Amount: <b>${formatINR(calc.amount)}</b></span>
    <span>GST: <b>${formatINR(calc.gstAmount)}</b></span>
    <span>CGST: <b>${formatINR(calc.cgst)}</b></span>
    <span>SGST: <b>${formatINR(calc.sgst)}</b></span>
    <span>Total: <b>${formatINR(calc.lineTotal)}</b></span>
  `;
}

// Renders all item rows into #itemsList. Called on tab switch, item add/remove, or mode change.
function renderItems() {
  const list = document.getElementById('itemsList');
  if (!state.items.length) {
    list.innerHTML = `<p class="saved-empty" style="padding:18px 6px;">No products added yet. Tap “+ Add Product” below.</p>`;
    return;
  }
  const inclusive = state.doc.gstMode === 'inclusive';
  const priceLabel = inclusive ? 'Final Price / Unit (incl. GST)' : 'Unit Price (₹)';

  list.innerHTML = state.items.map((item, idx) => {
    const calc = calcLine(item, state.doc.gstMode);
    return `
    <div class="item-card" data-id="${item.id}">
      <div class="item-card__top">
        <span class="item-card__index">${idx + 1}</span>
        <div class="field item-card__name-field">
          <input type="text" value="${escapeHTML(item.name)}" placeholder="Product / service name" data-field="name" data-id="${item.id}">
        </div>
        <button class="btn btn--icon-sm" type="button" data-action="remove-item" data-id="${item.id}" title="Remove item" aria-label="Remove item">
          <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>
        </button>
      </div>
      <div class="item-card__grid">
        <label class="field">
          <span>HSN/SAC</span>
          <input type="text" value="${escapeHTML(item.hsn)}" placeholder="HSN code" data-field="hsn" data-id="${item.id}">
        </label>
        <label class="field">
          <span>Quantity</span>
          <input type="number" value="${item.qty}" min="0" step="any" inputmode="decimal" data-field="qty" data-id="${item.id}">
        </label>
        <label class="field">
          <span>${priceLabel}</span>
          <input type="number" value="${item.price}" min="0" step="0.01" inputmode="decimal" placeholder="0.00" data-field="price" data-id="${item.id}">
        </label>
        <label class="field">
          <span>GST %</span>
          <select data-field="gst" data-id="${item.id}">
            ${GST_RATES.map(r => `<option value="${r}" ${Number(item.gst) === r ? 'selected' : ''}>${r}%</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="item-card__breakdown">${itemBreakdownHTML(calc)}</div>
    </div>
  `;
  }).join('');
}

/* ---------------------------------------------------------
   7. CHARGES ROW MANAGEMENT
   --------------------------------------------------------- */
function addCharge(prefill) {
  state.charges.push({
    id: nextId(),
    label: prefill?.label || CHARGE_TYPES[0],
    amount: prefill?.amount ?? ''
  });
  renderCharges();
  scheduleAutosave();
  renderInvoicePreview();
}

function removeCharge(id) {
  state.charges = state.charges.filter(c => c.id !== id);
  renderCharges();
  scheduleAutosave();
  renderInvoicePreview();
}

function updateCharge(id, field, value) {
  const charge = state.charges.find(c => c.id === id);
  if (!charge) return;
  charge[field] = value;
  scheduleAutosave();
  renderInvoicePreview();
}

function renderCharges() {
  const list = document.getElementById('chargesList');
  if (!state.charges.length) {
    list.innerHTML = `<p class="saved-empty" style="padding:10px 6px;">No extra charges added.</p>`;
    return;
  }
  list.innerHTML = state.charges.map(c => `
    <div class="charge-row" data-id="${c.id}">
      <select data-field="label" data-id="${c.id}">
        ${CHARGE_TYPES.map(t => `<option ${c.label === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
      <input type="number" min="0" step="0.01" inputmode="decimal" placeholder="Amount ₹" value="${c.amount}" data-field="amount" data-id="${c.id}">
      <button class="btn btn--icon-sm" type="button" data-action="remove-charge" data-id="${c.id}" aria-label="Remove charge">
        <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>
      </button>
    </div>
  `).join('');
}

/* ---------------------------------------------------------
   8. INVOICE PREVIEW RENDERER
   Builds the printable invoice document HTML from `state` and
   the computed totals. This exact markup is what gets printed
   and what html2canvas rasterises for the PDF.
   --------------------------------------------------------- */
function buildInvoiceHTML() {
  const totals = computeInvoiceTotals();
  const b = state.business;
  const c = state.customer;
  const d = state.doc;
  const isQuotation = d.type === 'quotation';

  const docLabel = isQuotation ? 'QUOTATION' : 'TAX INVOICE';
  const numberLabel = isQuotation ? 'Quotation No.' : 'Invoice No.';

  // ---- Masthead: logo + business identity + doc title ----
  const logoHTML = b.logo
    ? `<img class="invoice__logo" src="${b.logo}" alt="Logo">`
    : '';

  const brandMetaLines = [];
  if (b.address) brandMetaLines.push(escapeHTML(b.address).replace(/\n/g, '<br>'));
  const contactBits = [];
  if (b.phone) contactBits.push('Ph: ' + escapeHTML(b.phone));
  if (b.email) contactBits.push(escapeHTML(b.email));
  if (b.website) contactBits.push(escapeHTML(b.website));
  if (contactBits.length) brandMetaLines.push(contactBits.join(' &nbsp;|&nbsp; '));

  const masthead = `
    <div class="invoice__masthead">
      <div class="invoice__brand">
        ${logoHTML}
        <div>
          <div class="invoice__brand-name">${escapeHTML(b.shopName || 'Your Shop Name')}</div>
          ${b.legalName ? `<div class="invoice__brand-legal">${escapeHTML(b.legalName)}</div>` : ''}
          <div class="invoice__brand-meta">${brandMetaLines.join('<br>')}</div>
        </div>
      </div>
      <div class="invoice__doctitle">
        <h2>${docLabel}</h2>
        ${b.gst ? `<div class="gstin-badge">GSTIN: ${escapeHTML(b.gst)}</div>` : ''}
      </div>
    </div>
  `;

  // ---- Meta strip: number / date / due date / place of supply ----
  const metaStrip = `
    <div class="invoice__meta-strip">
      <div class="invoice__meta-block"><span class="label">${numberLabel}</span><span class="value">${escapeHTML(d.number || '—')}</span></div>
      <div class="invoice__meta-block"><span class="label">Date</span><span class="value">${formatDateDisplay(d.date)}</span></div>
      ${!isQuotation ? `<div class="invoice__meta-block"><span class="label">Due Date</span><span class="value">${formatDateDisplay(d.dueDate)}</span></div>` : ''}
      ${d.placeOfSupply ? `<div class="invoice__meta-block"><span class="label">Place of Supply</span><span class="value">${escapeHTML(d.placeOfSupply)}</span></div>` : ''}
    </div>
  `;

  // ---- Parties: seller (recap) + customer ----
  const customerLines = [];
  if (c.address) customerLines.push(escapeHTML(c.address).replace(/\n/g, '<br>'));
  const custContact = [];
  if (c.phone) custContact.push('Ph: ' + escapeHTML(c.phone));
  if (c.pin) custContact.push('PIN: ' + escapeHTML(c.pin));
  if (custContact.length) customerLines.push(custContact.join(' &nbsp;|&nbsp; '));
  if (c.gst) customerLines.push('GSTIN: ' + escapeHTML(c.gst));
  if (c.id) customerLines.push('Customer ID: ' + escapeHTML(c.id));

  const parties = `
    <div class="invoice__parties">
      <div class="invoice__party">
        <span class="label">Billed By</span>
        <div class="name">${escapeHTML(b.shopName || 'Your Shop Name')}</div>
        <div class="line">${escapeHTML(b.address || '').replace(/\n/g, '<br>')}</div>
        ${b.gst ? `<div class="line">GSTIN: ${escapeHTML(b.gst)}</div>` : ''}
      </div>
      <div class="invoice__party">
        <span class="label">Billed To</span>
        <div class="name">${escapeHTML(c.name || 'Customer Name')}</div>
        <div class="line">${customerLines.join('<br>')}</div>
      </div>
    </div>
  `;

  // ---- Items table ----
  const rows = totals.lineResults.map(({ item, calc }, idx) => `
    <tr>
      <td class="center">${idx + 1}</td>
      <td>
        <div class="pname">${escapeHTML(item.name || 'Untitled item')}</div>
        ${item.hsn ? `<div class="psub">HSN/SAC: ${escapeHTML(item.hsn)}</div>` : ''}
      </td>
      <td class="num">${calc.qty}</td>
      <td class="num">${formatINR(calc.price)}</td>
      <td class="center">${calc.gstPct}%</td>
      <td class="num">${formatINR(calc.amount)}</td>
      <td class="num">${formatINR(calc.gstAmount)}</td>
      <td class="num">${formatINR(calc.lineTotal)}</td>
    </tr>
  `).join('') || `<tr><td colspan="8" style="text-align:center;color:#999;padding:14px;">No items added</td></tr>`;

  const itemsTable = `
    <table class="invoice__table">
      <thead>
        <tr>
          <th class="center" style="width:5%">#</th>
          <th style="width:30%">Item</th>
          <th class="num" style="width:8%">Qty</th>
          <th class="num" style="width:13%">Rate</th>
          <th class="center" style="width:8%">GST</th>
          <th class="num" style="width:12%">Amount</th>
          <th class="num" style="width:12%">GST Amt</th>
          <th class="num" style="width:12%">Total</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  // ---- GST summary table (rate-wise CGST/SGST breakup) ----
  const gstSummary = totals.gstSummaryRows.length ? `
    <table class="invoice__gst-summary">
      <caption>GST Summary</caption>
      <thead>
        <tr><th>Rate</th><th>Taxable Value</th><th>CGST</th><th>SGST</th><th>Total Tax</th></tr>
      </thead>
      <tbody>
        ${totals.gstSummaryRows.map(row => `
          <tr>
            <td>${row.rate}%</td>
            <td>${formatINR(row.base)}</td>
            <td>${formatINR(row.cgst)}</td>
            <td>${formatINR(row.sgst)}</td>
            <td>${formatINR(row.total)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : '';

  // ---- Bank details ----
  const bank = (b.bankName || b.bankAccount || b.bankIFSC) ? `
    <div class="invoice__bank">
      <span class="label">Bank Details</span>
      ${b.bankName ? `<div class="row"><span>Bank Name</span><span>${escapeHTML(b.bankName)}</span></div>` : ''}
      ${b.bankAccount ? `<div class="row"><span>Account No.</span><span>${escapeHTML(b.bankAccount)}</span></div>` : ''}
      ${b.bankIFSC ? `<div class="row"><span>IFSC Code</span><span>${escapeHTML(b.bankIFSC)}</span></div>` : ''}
      ${b.bankBranch ? `<div class="row"><span>Branch</span><span>${escapeHTML(b.bankBranch)}</span></div>` : ''}
    </div>
  ` : '';

  // ---- Terms ----
  const terms = state.terms ? `
    <div class="invoice__terms">
      <span class="label">Terms &amp; Conditions</span>
      ${escapeHTML(state.terms)}
    </div>
  ` : '';

  // ---- Totals box ----
  const discountRow = totals.discountAmount > 0 ? `
    <tr class="discount"><td>Discount${state.discount.type === 'percent' ? ' (' + state.discount.value + '%)' : ''}</td><td>− ${formatINR(totals.discountAmount)}</td></tr>
  ` : '';
  const chargesRows = state.charges.filter(c => Number(c.amount) > 0).map(c => `
    <tr><td>${escapeHTML(c.label)}</td><td>${formatINR(c.amount)}</td></tr>
  `).join('');
  const roundOffRow = Math.abs(totals.roundOff) > 0.004 ? `
    <tr><td>Round Off</td><td>${totals.roundOff > 0 ? '+' : ''}${formatINR(totals.roundOff)}</td></tr>
  ` : '';

  const totalsBox = `
    <table class="invoice__totals">
      <tr><td>Subtotal</td><td>${formatINR(totals.subtotal)}</td></tr>
      <tr><td>CGST</td><td>${formatINR(totals.cgstTotal)}</td></tr>
      <tr><td>SGST</td><td>${formatINR(totals.sgstTotal)}</td></tr>
      ${discountRow}
      ${chargesRows}
      ${roundOffRow}
      <tr class="grand"><td>Grand Total</td><td>${formatINR(totals.grandTotal)}</td></tr>
    </table>
    <div class="invoice__amount-words"><b>In words:</b> Rupees ${numberToWordsIndian(totals.grandTotal)} Only</div>
  `;

  // ---- Footer: signature ----
  const sigHTML = b.signature
    ? `<img src="${b.signature}" alt="Signature">`
    : `<div class="sig-line"></div>`;

  const footer = `
    <div class="invoice__footer">
      <div class="muted-block" style="font-size:9.5px;color:#999;max-width:260px;">
        ${isQuotation ? 'This is a quotation and not a demand for payment. Prices valid for 15 days unless stated otherwise.' : 'This is a computer-generated invoice.'}
      </div>
      <div class="invoice__sig">
        ${sigHTML}
        <div class="sig-label">${b.signature ? '' : '&nbsp;'}</div>
        <div class="sig-for">For ${escapeHTML(b.shopName || 'Your Shop Name')}</div>
        <div class="sig-label">Authorized Signatory</div>
      </div>
    </div>
    <div class="invoice__bottom-strip">Generated with BillBook — Total Quantity: ${totals.totalQty} | Thank you for your business</div>
  `;

  return `
    ${masthead}
    ${metaStrip}
    ${parties}
    ${itemsTable}
    <div class="invoice__bottom">
      <div class="invoice__notes-col">
        ${gstSummary}
        ${bank}
        ${terms}
      </div>
      <div class="invoice__totals-col">
        ${totalsBox}
      </div>
    </div>
    ${footer}
  `;
}

// Renders the invoice into BOTH the desktop side-panel and (if active) the mobile preview tab.
function renderInvoicePreview() {
  const html = buildInvoiceHTML();
  const desktopRoot = document.getElementById('invoiceRoot');
  if (desktopRoot) {
    desktopRoot.innerHTML = html;
    desktopRoot.classList.toggle('invoice--quotation', state.doc.type === 'quotation');
  }
  // mobile preview tab gets its own clone so html2canvas always exports from #invoiceRoot (desktop, full width)
  const mobileScroll = document.getElementById('invoiceScrollMobile');
  if (mobileScroll) {
    if (!mobileScroll.querySelector('.invoice')) {
      mobileScroll.innerHTML = `<div class="invoice"></div>`;
    }
    const mobileInvoice = mobileScroll.querySelector('.invoice');
    mobileInvoice.innerHTML = html;
    mobileInvoice.classList.toggle('invoice--quotation', state.doc.type === 'quotation');
  }
}

/* ---------------------------------------------------------
   9. FORM <-> STATE SYNC
   --------------------------------------------------------- */

// Pulls current values from the business/bank form fields into state.business
function readBusinessForm() {
  state.business.shopName  = document.getElementById('bizShopName').value.trim();
  state.business.legalName = document.getElementById('bizLegalName').value.trim();
  state.business.gst       = document.getElementById('bizGST').value.trim().toUpperCase();
  state.business.phone     = document.getElementById('bizPhone').value.trim();
  state.business.email     = document.getElementById('bizEmail').value.trim();
  state.business.website   = document.getElementById('bizWebsite').value.trim();
  state.business.address   = document.getElementById('bizAddress').value.trim();
  state.business.bankName    = document.getElementById('bankName').value.trim();
  state.business.bankAccount = document.getElementById('bankAccount').value.trim();
  state.business.bankIFSC    = document.getElementById('bankIFSC').value.trim().toUpperCase();
  state.business.bankBranch  = document.getElementById('bankBranch').value.trim();
}

function writeBusinessForm() {
  const b = state.business;
  document.getElementById('bizShopName').value  = b.shopName || '';
  document.getElementById('bizLegalName').value = b.legalName || '';
  document.getElementById('bizGST').value       = b.gst || '';
  document.getElementById('bizPhone').value     = b.phone || '';
  document.getElementById('bizEmail').value     = b.email || '';
  document.getElementById('bizWebsite').value   = b.website || '';
  document.getElementById('bizAddress').value   = b.address || '';
  document.getElementById('bankName').value     = b.bankName || '';
  document.getElementById('bankAccount').value  = b.bankAccount || '';
  document.getElementById('bankIFSC').value     = b.bankIFSC || '';
  document.getElementById('bankBranch').value   = b.bankBranch || '';
  setLogoPreview(b.logo);
  setSigPreview(b.signature);
}

function setLogoPreview(dataUrl) {
  const img = document.getElementById('logoPreview');
  const placeholder = document.getElementById('logoPlaceholder');
  if (dataUrl) { img.src = dataUrl; img.hidden = false; placeholder.hidden = true; }
  else { img.hidden = true; placeholder.hidden = false; }
}
function setSigPreview(dataUrl) {
  const img = document.getElementById('sigPreview');
  const placeholder = document.getElementById('sigPlaceholder');
  if (dataUrl) { img.src = dataUrl; img.hidden = false; placeholder.hidden = true; }
  else { img.hidden = true; placeholder.hidden = false; }
}

// Pulls customer + invoice-detail fields into state
function readCustomerForm() {
  state.customer.name    = document.getElementById('custName').value.trim();
  state.customer.id      = document.getElementById('custId').value.trim();
  state.customer.phone   = document.getElementById('custPhone').value.trim();
  state.customer.gst     = document.getElementById('custGST').value.trim().toUpperCase();
  state.customer.pin     = document.getElementById('custPin').value.trim();
  state.customer.address = document.getElementById('custAddress').value.trim();

  state.doc.type          = document.getElementById('docType').value;
  state.doc.number        = document.getElementById('docNumber').value.trim();
  state.doc.date          = document.getElementById('docDate').value;
  state.doc.dueDate       = document.getElementById('docDueDate').value;
  state.doc.placeOfSupply = document.getElementById('placeOfSupply').value.trim();
  state.doc.gstMode       = document.getElementById('gstMode').value;
}

function writeCustomerForm() {
  const c = state.customer;
  document.getElementById('custName').value    = c.name || '';
  document.getElementById('custId').value       = c.id || '';
  document.getElementById('custPhone').value    = c.phone || '';
  document.getElementById('custGST').value      = c.gst || '';
  document.getElementById('custPin').value      = c.pin || '';
  document.getElementById('custAddress').value  = c.address || '';

  document.getElementById('docType').value          = state.doc.type;
  document.getElementById('docNumber').value        = state.doc.number;
  document.getElementById('docDate').value          = state.doc.date;
  document.getElementById('docDueDate').value       = state.doc.dueDate;
  document.getElementById('placeOfSupply').value    = state.doc.placeOfSupply;
  document.getElementById('gstMode').value          = state.doc.gstMode;
  updateDocTypeLabels();
}

function readChargesAndTermsForm() {
  state.discount.type  = document.getElementById('discountType').value;
  state.discount.value = parseFloat(document.getElementById('discountValue').value) || 0;
  state.terms          = document.getElementById('termsText').value;
  state.internalNotes  = document.getElementById('internalNotes').value;
}

function writeChargesAndTermsForm() {
  document.getElementById('discountType').value  = state.discount.type;
  document.getElementById('discountValue').value = state.discount.value || '';
  document.getElementById('termsText').value     = state.terms || '';
  document.getElementById('internalNotes').value = state.internalNotes || '';
}

function updateDocTypeLabels() {
  const isQuote = state.doc.type === 'quotation';
  document.getElementById('docNumberLabel').textContent = isQuote ? 'Quotation Number' : 'Invoice Number';
  document.getElementById('gstModeHint').textContent =
    (state.doc.gstMode === 'inclusive' ? 'Inclusive' : 'Exclusive') + ' GST mode — switch in Customer tab';
}

/* ---------------------------------------------------------
   10. DRAFT AUTOSAVE
   The in-progress invoice (not yet explicitly "Saved" to the
   invoice list) is continuously persisted so a refresh or an
   accidental tab close doesn't lose work.
   --------------------------------------------------------- */
const scheduleAutosave = debounce(() => {
  Store.set(STORE_KEYS.DRAFT, state);
}, 400);

/* ---------------------------------------------------------
   11. INVOICE NUMBERING
   --------------------------------------------------------- */
function generateDocNumber(type) {
  if (type === 'quotation') {
    const num = settings.quotePrefix + String(settings.quoteNext).padStart(4, '0');
    return num;
  }
  const num = settings.invoicePrefix + String(settings.invoiceNext).padStart(4, '0');
  return num;
}

// Called only when the number is actually consumed (on first Save of a NEW invoice),
// so re-opening the app or switching doc type doesn't burn numbers needlessly.
function commitDocNumberIfNew() {
  if (state.savedId) return; // editing an existing saved invoice — don't bump counters
  if (state.doc.type === 'quotation') settings.quoteNext += 1;
  else settings.invoiceNext += 1;
  Store.set(STORE_KEYS.SETTINGS, settings);
  writeSettingsForm();
}

/* ---------------------------------------------------------
   12. SAVED INVOICES — CRUD (open / edit / duplicate / delete)
   --------------------------------------------------------- */
function saveCurrentInvoice() {
  readBusinessForm();
  readCustomerForm();
  readChargesAndTermsForm();

  if (!state.items.length) {
    showToast('Add at least one product before saving.');
    return;
  }
  if (!state.customer.name) {
    showToast('Enter a customer name before saving.');
    return;
  }

  const totals = computeInvoiceTotals();
  const isNew = !state.savedId;

  if (isNew) {
    state.savedId = nextId();
    commitDocNumberIfNew();
  }

  const record = {
    id: state.savedId,
    savedAt: new Date().toISOString(),
    docType: state.doc.type,
    docNumber: state.doc.number,
    docDate: state.doc.date,
    customerName: state.customer.name,
    grandTotal: totals.grandTotal,
    state: JSON.parse(JSON.stringify(state)) // deep snapshot
  };

  const idx = invoices.findIndex(inv => inv.id === record.id);
  if (idx >= 0) invoices[idx] = record; else invoices.unshift(record);

  Store.set(STORE_KEYS.INVOICES, invoices);
  showToast(isNew ? 'Invoice saved.' : 'Invoice updated.');
  renderSavedList();

  // Also persist the customer/products used into their libraries automatically
  // so the user doesn't lose them if they forget to tap "Save to library".
  autoSaveCustomerFromState();
}

function loadInvoiceIntoState(record) {
  state = JSON.parse(JSON.stringify(record.state));
  // make sure savedId always matches the record we loaded (defensive)
  state.savedId = record.id;
  hydrateFormsFromState();
  renderItems();
  renderCharges();
  renderInvoicePreview();
  closeDrawer('saved');
  showToast('Invoice loaded for editing.');
  switchTab('business');
}

function duplicateInvoice(id) {
  const record = invoices.find(inv => inv.id === id);
  if (!record) return;
  const cloned = JSON.parse(JSON.stringify(record.state));
  cloned.savedId = null; // becomes a brand-new invoice on next Save
  cloned.doc.number = generateDocNumber(cloned.doc.type);
  cloned.doc.date = todayISO();
  state = cloned;
  hydrateFormsFromState();
  renderItems();
  renderCharges();
  renderInvoicePreview();
  closeDrawer('saved');
  showToast('Duplicated as a new invoice — remember to Save.');
  switchTab('business');
}

function deleteInvoice(id) {
  if (!confirm('Delete this saved invoice? This cannot be undone.')) return;
  invoices = invoices.filter(inv => inv.id !== id);
  Store.set(STORE_KEYS.INVOICES, invoices);
  renderSavedList();
  showToast('Invoice deleted.');
}

function renderSavedList(filterText) {
  const list = document.getElementById('savedList');
  let items = invoices;
  if (filterText) {
    const f = filterText.toLowerCase();
    items = items.filter(inv =>
      (inv.docNumber || '').toLowerCase().includes(f) ||
      (inv.customerName || '').toLowerCase().includes(f)
    );
  }
  if (!items.length) {
    list.innerHTML = `<p class="saved-empty">No saved invoices yet.<br>Fill in a document and tap Save.</p>`;
    return;
  }
  list.innerHTML = items.map(inv => `
    <div class="saved-card">
      <div class="saved-card__top">
        <span class="saved-card__num">${escapeHTML(inv.docNumber || 'Untitled')} <span style="font-weight:500;color:var(--ink-soft);font-size:11px;">${inv.docType === 'quotation' ? 'QUOTATION' : 'INVOICE'}</span></span>
        <span class="saved-card__date">${formatDateDisplay(inv.docDate)}</span>
      </div>
      <div class="saved-card__cust">${escapeHTML(inv.customerName || 'No customer')}</div>
      <div class="saved-card__amount">${formatINR(inv.grandTotal)}</div>
      <div class="saved-card__actions">
        <button class="btn btn--ghost" data-action="open-invoice" data-id="${inv.id}">Open</button>
        <button class="btn btn--secondary" data-action="duplicate-invoice" data-id="${inv.id}">Duplicate</button>
        <button class="btn btn--danger" data-action="delete-invoice" data-id="${inv.id}">Delete</button>
      </div>
    </div>
  `).join('');
}

/* ---------------------------------------------------------
   13. CUSTOMER LIBRARY
   --------------------------------------------------------- */
function autoSaveCustomerFromState() {
  if (!state.customer.name) return;
  const existingIdx = customers.findIndex(c =>
    c.name.toLowerCase() === state.customer.name.toLowerCase() &&
    (c.phone || '') === (state.customer.phone || '')
  );
  const record = { ...state.customer, id: state.customer.id || nextId() };
  if (existingIdx >= 0) customers[existingIdx] = record;
  else customers.push(record);
  Store.set(STORE_KEYS.CUSTOMERS, customers);
  populateCustomerSelect();
  renderCustomerLibrary();
}

function saveCustomerToLibrary() {
  readCustomerForm();
  if (!state.customer.name) {
    showToast('Enter a customer name first.');
    return;
  }
  autoSaveCustomerFromState();
  showToast('Customer saved to library.');
}

function populateCustomerSelect() {
  const select = document.getElementById('customerSelect');
  const current = select.value;
  select.innerHTML = `<option value="">— New customer —</option>` +
    customers.map(c => `<option value="${c.id}">${escapeHTML(c.name)}${c.phone ? ' — ' + escapeHTML(c.phone) : ''}</option>`).join('');
  if (customers.some(c => c.id === current)) select.value = current;
}

function onCustomerSelected(id) {
  if (!id) return;
  const c = customers.find(c => c.id === id);
  if (!c) return;
  state.customer = { ...c };
  writeCustomerForm();
  scheduleAutosave();
  renderInvoicePreview();
}

function renderCustomerLibrary() {
  const list = document.getElementById('customerLibraryList');
  if (!list) return;
  if (!customers.length) {
    list.innerHTML = `<p class="saved-empty" style="padding:10px 0;">No saved customers yet.</p>`;
    return;
  }
  list.innerHTML = customers.map(c => `
    <div class="library-item">
      <div class="library-item__main">
        <div class="library-item__title">${escapeHTML(c.name)}</div>
        <div class="library-item__meta">${escapeHTML(c.phone || '')}${c.gst ? ' · ' + escapeHTML(c.gst) : ''}</div>
      </div>
      <button class="btn btn--icon-sm" data-action="delete-customer" data-id="${c.id}" aria-label="Delete customer">
        <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>
      </button>
    </div>
  `).join('');
}

function deleteCustomerFromLibrary(id) {
  customers = customers.filter(c => c.id !== id);
  Store.set(STORE_KEYS.CUSTOMERS, customers);
  populateCustomerSelect();
  renderCustomerLibrary();
  showToast('Customer removed from library.');
}

/* ---------------------------------------------------------
   14. PRODUCT LIBRARY
   --------------------------------------------------------- */
function saveProductToLibrary(p) {
  const existingIdx = products.findIndex(x => x.name.toLowerCase() === p.name.toLowerCase());
  const record = { id: p.id || nextId(), name: p.name, hsn: p.hsn || '', price: Number(p.price) || 0, gst: Number(p.gst) || 0 };
  if (existingIdx >= 0) products[existingIdx] = record; else products.push(record);
  Store.set(STORE_KEYS.PRODUCTS, products);
  renderProductLibrary();
}

function deleteProductFromLibrary(id) {
  products = products.filter(p => p.id !== id);
  Store.set(STORE_KEYS.PRODUCTS, products);
  renderProductLibrary();
  showToast('Product removed from library.');
}

function renderProductLibrary() {
  const list = document.getElementById('productLibraryList');
  if (!list) return;
  if (!products.length) {
    list.innerHTML = `<p class="saved-empty" style="padding:10px 0;">No saved products yet.</p>`;
    return;
  }
  list.innerHTML = products.map(p => `
    <div class="library-item">
      <div class="library-item__main">
        <div class="library-item__title">${escapeHTML(p.name)}</div>
        <div class="library-item__meta">${p.hsn ? 'HSN ' + escapeHTML(p.hsn) + ' · ' : ''}${formatINR(p.price)} · ${p.gst}% GST</div>
      </div>
      <button class="btn btn--icon-sm" data-action="delete-product" data-id="${p.id}" aria-label="Delete product">
        <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>
      </button>
    </div>
  `).join('');
}

function searchProducts(query) {
  const resultsBox = document.getElementById('productSearchResults');
  const q = query.trim().toLowerCase();
  if (!q) { resultsBox.hidden = true; resultsBox.innerHTML = ''; return; }
  const matches = products.filter(p => p.name.toLowerCase().includes(q)).slice(0, 8);
  if (!matches.length) {
    resultsBox.innerHTML = `<div class="product-search__item"><span>No matching products. It will be added as new.</span></div>`;
    resultsBox.hidden = false;
    return;
  }
  resultsBox.innerHTML = matches.map(p => `
    <div class="product-search__item" data-action="pick-product" data-id="${p.id}">
      <b>${escapeHTML(p.name)}</b>
      <span>${formatINR(p.price)} · ${p.gst}%</span>
    </div>
  `).join('');
  resultsBox.hidden = false;
}

function pickProductFromSearch(id) {
  const p = products.find(p => p.id === id);
  if (!p) return;
  addItem({ name: p.name, hsn: p.hsn, qty: 1, price: p.price, gst: p.gst });
  document.getElementById('productSearch').value = '';
  document.getElementById('productSearchResults').hidden = true;
  showToast(`Added "${p.name}" from library.`);
}

function promptAddLibraryProduct() {
  const name = prompt('Product name:');
  if (!name) return;
  const price = parseFloat(prompt('Unit price (₹):', '0')) || 0;
  const gstInput = prompt('GST % (0, 5, 12, 18, 28):', '18');
  const gst = GST_RATES.includes(Number(gstInput)) ? Number(gstInput) : 18;
  const hsn = prompt('HSN/SAC code (optional):', '') || '';
  saveProductToLibrary({ name, price, gst, hsn });
  showToast('Product added to library.');
}

/* ---------------------------------------------------------
   15. PDF EXPORT (html2canvas + jsPDF)
   Renders the #invoiceRoot node (full-resolution, unscaled)
   to a canvas, then drops that image into an A4 jsPDF page.
   If the invoice content is taller than one A4 page, it is
   split across multiple pages automatically.
   --------------------------------------------------------- */
async function downloadInvoicePDF() {
  const node = document.getElementById('invoiceRoot');
  const previewCol = document.querySelector('.preview-col');
  if (!node) { showToast('Preview not ready yet.'); return; }
  if (typeof html2canvas === 'undefined' || typeof window.jspdf === 'undefined') {
    showToast('PDF library failed to load — check your internet connection once, then it works offline.');
    return;
  }

  showToast('Generating PDF…', 4000);

  // #invoiceRoot lives inside .preview-col, which is display:none on mobile
  // viewports (the side-by-side preview is desktop-only there). An element
  // with no layout box can't be captured by html2canvas, so force it visible
  // off-screen for the duration of the capture, then restore exactly as it was.
  const prevColCSSText = previewCol ? previewCol.style.cssText : '';
  if (previewCol) {
    previewCol.style.cssText = 'display:block !important; position:absolute; left:-9999px; top:0; visibility:visible;';
  }

  // Temporarily force the un-scaled, full-width version for crisp capture
  const prevTransform = node.style.transform;
  node.style.transform = 'none';

  try {
    const canvas = await html2canvas(node, {
      scale: 2.2,              // high-res for crisp text in the PDF
      useCORS: true,
      backgroundColor: '#ffffff',
      windowWidth: node.scrollWidth
    });

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();   // 210mm
    const pageHeight = pdf.internal.pageSize.getHeight(); // 297mm

    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    const imgData = canvas.toDataURL('image/jpeg', 0.95);

    if (imgHeight <= pageHeight) {
      pdf.addImage(imgData, 'JPEG', 0, 0, imgWidth, imgHeight);
    } else {
      // Multi-page split: slice the tall canvas into page-height chunks
      let heightLeft = imgHeight;
      let position = 0;
      let firstPage = true;
      while (heightLeft > 0) {
        if (!firstPage) pdf.addPage();
        pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
        position -= pageHeight;
        firstPage = false;
      }
    }

    const filename = `${state.doc.number || (state.doc.type === 'quotation' ? 'Quotation' : 'Invoice')}.pdf`;
    pdf.save(filename);
    showToast('PDF downloaded.');
  } catch (err) {
    console.error(err);
    showToast('Could not generate PDF. Please try again.');
  } finally {
    node.style.transform = prevTransform;
    if (previewCol) previewCol.style.cssText = prevColCSSText;
  }
}

/* ---------------------------------------------------------
   16. PRINT
   Uses the browser's native print dialog. The @media print
   rules in style.css hide everything except #invoiceRoot.
   --------------------------------------------------------- */
function printInvoice() {
  window.print();
}

/* ---------------------------------------------------------
   17. SETTINGS (numbering, library management, data import/export)
   --------------------------------------------------------- */
function writeSettingsForm() {
  document.getElementById('settingInvoicePrefix').value = settings.invoicePrefix;
  document.getElementById('settingInvoiceNext').value   = settings.invoiceNext;
  document.getElementById('settingQuotePrefix').value   = settings.quotePrefix;
  document.getElementById('settingQuoteNext').value     = settings.quoteNext;
}

function readSettingsForm() {
  settings.invoicePrefix = document.getElementById('settingInvoicePrefix').value || 'INV-';
  settings.invoiceNext   = parseInt(document.getElementById('settingInvoiceNext').value, 10) || 1;
  settings.quotePrefix   = document.getElementById('settingQuotePrefix').value || 'QTN-';
  settings.quoteNext     = parseInt(document.getElementById('settingQuoteNext').value, 10) || 1;
  Store.set(STORE_KEYS.SETTINGS, settings);
}

function exportAllData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    business: state.business,
    customers, products, invoices, settings
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `billbook-backup-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Backup exported.');
}

function importAllData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.business) { state.business = data.business; Store.set(STORE_KEYS.BUSINESS, state.business); }
      if (Array.isArray(data.customers)) { customers = data.customers; Store.set(STORE_KEYS.CUSTOMERS, customers); }
      if (Array.isArray(data.products)) { products = data.products; Store.set(STORE_KEYS.PRODUCTS, products); }
      if (Array.isArray(data.invoices)) { invoices = data.invoices; Store.set(STORE_KEYS.INVOICES, invoices); }
      if (data.settings) { settings = { ...DEFAULT_SETTINGS, ...data.settings }; Store.set(STORE_KEYS.SETTINGS, settings); }

      writeBusinessForm();
      populateCustomerSelect();
      renderCustomerLibrary();
      renderProductLibrary();
      renderSavedList();
      writeSettingsForm();
      renderInvoicePreview();
      showToast('Data imported successfully.');
    } catch (e) {
      console.error(e);
      showToast('That file could not be read as a valid backup.');
    }
  };
  reader.readAsText(file);
}

function clearAllData() {
  if (!confirm('This will permanently erase ALL saved data on this device — business profile, customers, products, and saved invoices. Continue?')) return;
  if (!confirm('Are you absolutely sure? This cannot be undone.')) return;
  Object.values(STORE_KEYS).forEach(k => Store.remove(k));
  location.reload();
}

/* ---------------------------------------------------------
   18. TAB NAVIGATION (mobile)
   --------------------------------------------------------- */
function switchTab(tabName) {
  document.querySelectorAll('.tab-nav__btn').forEach(btn =>
    btn.classList.toggle('is-active', btn.dataset.tab === tabName)
  );
  document.querySelectorAll('.panel[data-panel]').forEach(panel =>
    panel.classList.toggle('is-hidden', panel.dataset.panel !== tabName)
  );
  if (tabName === 'preview') renderInvoicePreview();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------------------------------------------------------
   19. DRAWERS (Saved invoices / Settings)
   --------------------------------------------------------- */
function openDrawer(which) {
  const drawer = document.getElementById(which === 'saved' ? 'savedDrawer' : 'settingsDrawer');
  const backdrop = document.getElementById(which === 'saved' ? 'drawerBackdrop' : 'settingsBackdrop');
  drawer.hidden = false;
  backdrop.hidden = false;
  document.body.style.overflow = 'hidden';
  if (which === 'saved') renderSavedList();
  if (which === 'settings') { renderProductLibrary(); renderCustomerLibrary(); writeSettingsForm(); }
}

function closeDrawer(which) {
  const drawer = document.getElementById(which === 'saved' ? 'savedDrawer' : 'settingsDrawer');
  const backdrop = document.getElementById(which === 'saved' ? 'drawerBackdrop' : 'settingsBackdrop');
  drawer.hidden = true;
  backdrop.hidden = true;
  document.body.style.overflow = '';
}

/* ---------------------------------------------------------
   20. NEW INVOICE / RESET CURRENT DOCUMENT
   --------------------------------------------------------- */
function startNewInvoice(skipConfirm) {
  if (!skipConfirm && (state.items.length || state.customer.name)) {
    if (!confirm('Start a new invoice? Unsaved changes to the current one will be lost.')) return;
  }
  const business = state.business; // keep business profile loaded
  state = {
    business,
    customer: { id: '', name: '', phone: '', address: '', gst: '', pin: '' },
    doc: {
      type: 'invoice',
      number: generateDocNumber('invoice'),
      date: todayISO(),
      dueDate: '',
      placeOfSupply: '',
      gstMode: 'exclusive'
    },
    items: [],
    discount: { type: 'amount', value: 0 },
    charges: [],
    terms: Store.get(STORE_KEYS.SETTINGS, {}).defaultTerms || document.getElementById('termsText')?.value || '',
    internalNotes: '',
    savedId: null
  };
  document.getElementById('customerSelect').value = '';
  hydrateFormsFromState();
  renderItems();
  renderCharges();
  renderInvoicePreview();
  Store.set(STORE_KEYS.DRAFT, state);
  switchTab('business');
}

/* ---------------------------------------------------------
   21. HYDRATION — push `state` into every form field at once
   (used after loading a saved invoice, duplicating, or boot)
   --------------------------------------------------------- */
function hydrateFormsFromState() {
  writeBusinessForm();
  writeCustomerForm();
  writeChargesAndTermsForm();
}

/* ---------------------------------------------------------
   22. EVENT WIRING
   --------------------------------------------------------- */
function wireEvents() {

  // ---- Tab nav ----
  document.getElementById('tabNav').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-nav__btn');
    if (btn) switchTab(btn.dataset.tab);
  });

  // ---- App bar ----
  document.getElementById('btnNewInvoice').addEventListener('click', () => startNewInvoice(false));
  document.getElementById('btnSettings').addEventListener('click', () => openDrawer('settings'));
  document.getElementById('btnSavedInvoices').addEventListener('click', () => openDrawer('saved'));

  // ---- Business form: live-bind every input to state + autosave + preview ----
  const businessFieldIds = ['bizShopName','bizLegalName','bizGST','bizPhone','bizEmail','bizWebsite','bizAddress','bankName','bankAccount','bankIFSC','bankBranch'];
  businessFieldIds.forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      readBusinessForm();
      scheduleAutosave();
      renderInvoicePreview();
    });
  });
  document.getElementById('btnSaveBusiness').addEventListener('click', () => {
    readBusinessForm();
    Store.set(STORE_KEYS.BUSINESS, state.business);
    showToast('Business profile saved permanently.');
    renderInvoicePreview();
  });

  // ---- Logo upload ----
  document.getElementById('logoInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    fileToDataURL(file, (dataUrl) => {
      if (!dataUrl) return;
      state.business.logo = dataUrl;
      setLogoPreview(dataUrl);
      Store.set(STORE_KEYS.BUSINESS, state.business);
      renderInvoicePreview();
      showToast('Logo updated.');
    });
  });
  document.getElementById('btnRemoveLogo').addEventListener('click', () => {
    state.business.logo = '';
    setLogoPreview('');
    Store.set(STORE_KEYS.BUSINESS, state.business);
    renderInvoicePreview();
  });

  // ---- Signature upload ----
  document.getElementById('sigInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    fileToDataURL(file, (dataUrl) => {
      if (!dataUrl) return;
      state.business.signature = dataUrl;
      setSigPreview(dataUrl);
      Store.set(STORE_KEYS.BUSINESS, state.business);
      renderInvoicePreview();
      showToast('Signature updated.');
    });
  });
  document.getElementById('btnRemoveSig').addEventListener('click', () => {
    state.business.signature = '';
    setSigPreview('');
    Store.set(STORE_KEYS.BUSINESS, state.business);
    renderInvoicePreview();
  });

  // ---- Customer form ----
  const customerFieldIds = ['custName','custId','custPhone','custGST','custPin','custAddress'];
  customerFieldIds.forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      readCustomerForm();
      scheduleAutosave();
      renderInvoicePreview();
    });
  });
  document.getElementById('customerSelect').addEventListener('change', (e) => onCustomerSelected(e.target.value));
  document.getElementById('btnSaveCustomer').addEventListener('click', saveCustomerToLibrary);

  // ---- Invoice detail fields ----
  ['docType','docNumber','docDate','docDueDate','placeOfSupply'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      readCustomerForm();
      updateDocTypeLabels();
      scheduleAutosave();
      renderInvoicePreview();
    });
  });
  document.getElementById('docType').addEventListener('change', () => {
    readCustomerForm();
    updateDocTypeLabels();
    scheduleAutosave();
    renderInvoicePreview();
  });
  document.getElementById('gstMode').addEventListener('change', () => {
    readCustomerForm();
    updateDocTypeLabels();
    renderItems();      // price label text depends on mode
    scheduleAutosave();
    renderInvoicePreview();
  });

  // ---- Items ----
  document.getElementById('btnAddItem').addEventListener('click', () => addItem());
  document.getElementById('itemsList').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.field && t.dataset.id) updateItem(t.dataset.id, t.dataset.field, t.value);
  });
  document.getElementById('itemsList').addEventListener('change', (e) => {
    const t = e.target;
    if (t.tagName === 'SELECT' && t.dataset.field && t.dataset.id) updateItem(t.dataset.id, t.dataset.field, t.value);
  });
  document.getElementById('itemsList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="remove-item"]');
    if (btn) removeItem(btn.dataset.id);
  });

  // ---- Product quick-search ----
  const productSearchInput = document.getElementById('productSearch');
  productSearchInput.addEventListener('input', debounce(() => searchProducts(productSearchInput.value), 150));
  document.getElementById('productSearchResults').addEventListener('click', (e) => {
    const item = e.target.closest('[data-action="pick-product"]');
    if (item) pickProductFromSearch(item.dataset.id);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.product-search')) {
      document.getElementById('productSearchResults').hidden = true;
    }
  });

  // ---- Discount ----
  document.getElementById('discountType').addEventListener('change', () => { readChargesAndTermsForm(); scheduleAutosave(); renderInvoicePreview(); });
  document.getElementById('discountValue').addEventListener('input', () => { readChargesAndTermsForm(); scheduleAutosave(); renderInvoicePreview(); });

  // ---- Charges ----
  document.getElementById('btnAddCharge').addEventListener('click', () => addCharge());
  document.getElementById('chargesList').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.field && t.dataset.id) updateCharge(t.dataset.id, t.dataset.field, t.value);
  });
  document.getElementById('chargesList').addEventListener('change', (e) => {
    const t = e.target;
    if (t.tagName === 'SELECT' && t.dataset.field && t.dataset.id) updateCharge(t.dataset.id, t.dataset.field, t.value);
  });
  document.getElementById('chargesList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="remove-charge"]');
    if (btn) removeCharge(btn.dataset.id);
  });

  // ---- Terms / notes ----
  document.getElementById('termsText').addEventListener('input', () => { readChargesAndTermsForm(); scheduleAutosave(); renderInvoicePreview(); });
  document.getElementById('internalNotes').addEventListener('input', () => { readChargesAndTermsForm(); scheduleAutosave(); });

  // ---- Bottom action bar ----
  document.getElementById('btnSave').addEventListener('click', saveCurrentInvoice);
  document.getElementById('btnPreviewTab').addEventListener('click', () => {
    if (window.matchMedia('(min-width: 980px)').matches) {
      document.querySelector('.preview-col').scrollIntoView({ behavior: 'smooth' });
    } else {
      switchTab('preview');
    }
  });
  document.getElementById('btnDownloadPDF').addEventListener('click', downloadInvoicePDF);
  document.getElementById('btnPrint').addEventListener('click', printInvoice);

  // ---- Saved invoices drawer ----
  document.getElementById('btnCloseSavedDrawer').addEventListener('click', () => closeDrawer('saved'));
  document.getElementById('drawerBackdrop').addEventListener('click', () => closeDrawer('saved'));
  document.getElementById('savedSearch').addEventListener('input', debounce((e) => renderSavedList(e.target.value), 120));
  document.getElementById('savedList').addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-action="open-invoice"]');
    const dupBtn  = e.target.closest('[data-action="duplicate-invoice"]');
    const delBtn  = e.target.closest('[data-action="delete-invoice"]');
    if (openBtn) { const r = invoices.find(i => i.id === openBtn.dataset.id); if (r) loadInvoiceIntoState(r); }
    if (dupBtn)  duplicateInvoice(dupBtn.dataset.id);
    if (delBtn)  deleteInvoice(delBtn.dataset.id);
  });

  // ---- Settings drawer ----
  document.getElementById('btnCloseSettingsDrawer').addEventListener('click', () => closeDrawer('settings'));
  document.getElementById('settingsBackdrop').addEventListener('click', () => closeDrawer('settings'));
  ['settingInvoicePrefix','settingInvoiceNext','settingQuotePrefix','settingQuoteNext'].forEach(id => {
    document.getElementById(id).addEventListener('input', readSettingsForm);
  });
  document.getElementById('btnAddLibraryProduct').addEventListener('click', promptAddLibraryProduct);
  document.getElementById('productLibraryList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="delete-product"]');
    if (btn) deleteProductFromLibrary(btn.dataset.id);
  });
  document.getElementById('customerLibraryList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="delete-customer"]');
    if (btn) deleteCustomerFromLibrary(btn.dataset.id);
  });
  document.getElementById('btnExportData').addEventListener('click', exportAllData);
  document.getElementById('importDataInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importAllData(file);
  });
  document.getElementById('btnClearAllData').addEventListener('click', clearAllData);

  // ---- Keyboard: Esc closes drawers ----
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeDrawer('saved'); closeDrawer('settings'); }
  });
}

/* ---------------------------------------------------------
   23. BOOT SEQUENCE
   Loads everything from LocalStorage, restores the last draft
   (if any), wires up events, and renders the initial preview.
   --------------------------------------------------------- */
function boot() {
  // Load persisted libraries / settings
  customers = Store.get(STORE_KEYS.CUSTOMERS, []);
  products  = Store.get(STORE_KEYS.PRODUCTS, []);
  invoices  = Store.get(STORE_KEYS.INVOICES, []);
  settings  = { ...DEFAULT_SETTINGS, ...Store.get(STORE_KEYS.SETTINGS, {}) };

  const savedBusiness = Store.get(STORE_KEYS.BUSINESS, null);
  const draft = Store.get(STORE_KEYS.DRAFT, null);

  if (draft) {
    // Resume exactly where the user left off
    state = draft;
    // Always trust the freshest saved business profile over a stale draft copy,
    // in case the user edited their profile from elsewhere and the draft is older.
    if (savedBusiness) state.business = { ...state.business, ...savedBusiness };
  } else {
    if (savedBusiness) state.business = savedBusiness;
    state.doc.number = generateDocNumber('invoice');
    state.doc.date = todayISO();
  }

  // Defensive defaults in case an older draft format is missing fields
  state.items = state.items || [];
  state.charges = state.charges || [];
  state.discount = state.discount || { type: 'amount', value: 0 };
  state.doc = state.doc || { type: 'invoice', number: '', date: todayISO(), dueDate: '', placeOfSupply: '', gstMode: 'exclusive' };
  state.customer = state.customer || { id:'', name:'', phone:'', address:'', gst:'', pin:'' };

  hydrateFormsFromState();
  populateCustomerSelect();
  renderItems();
  renderCharges();
  renderInvoicePreview();
  wireEvents();

  // Set default date if blank (fresh installs)
  if (!document.getElementById('docDate').value) {
    document.getElementById('docDate').value = todayISO();
    state.doc.date = todayISO();
  }
}

document.addEventListener('DOMContentLoaded', boot);
