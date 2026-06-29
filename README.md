# BillBook — Offline GST Invoice & Quotation Generator

Pure HTML/CSS/JavaScript. No backend, no build step, no login.

## How to use
1. Put `index.html`, `style.css`, and `script.js` in the same folder (already done).
2. Double-click `index.html` to open it in any browser — Chrome, Safari, Edge — on
   Android, iPhone, or desktop.
3. For PDF export specifically, the **first time** you open the page you need an
   internet connection once, because `jsPDF` and `html2canvas` are loaded from a
   CDN (`cdnjs.cloudflare.com`) in `index.html`. After the browser has cached
   them, PDF export keeps working offline too. Everything else (forms, GST
   maths, live preview, Print, LocalStorage saving) works fully offline from
   the very first load, with zero network calls.
   - If you need 100% no-internet-ever operation, download these two files and
     point the `<script src="...">` tags in `index.html` at your local copies:
     `html2canvas.min.js` and `jspdf.umd.min.js`.

## Where your data lives
Everything is saved in the browser's LocalStorage on that device only:
business profile, bank details, logo, signature, customers, products, and
every saved invoice/quotation. Nothing is sent anywhere. Clearing your
browser's site data (or using a different browser/device) starts fresh.
Use **Settings → Export All Data** to back up to a JSON file you can
re-import later or move to another device.

## Quick tour
- **Business tab** — your shop details, GSTIN, bank details, logo, and
  signature. Tap "Save Business Profile" to keep it permanently.
- **Customer tab** — pick a saved customer or add a new one; also where you
  set invoice/quotation number, dates, place of supply, and switch between
  Exclusive/Inclusive GST mode.
- **Items tab** — add products, search your saved Product Library, choose
  GST% per line; each row shows its live Amount/GST/CGST/SGST/Total.
- **Charges tab** — transport, packing, installation, labour, custom charges,
  discount, and the Terms & Conditions text shown on the invoice.
- **Preview tab** (mobile) / right column (desktop) — the actual invoice,
  updating as you type.
- **Bottom bar** — Save, Preview, PDF, Print, always within thumb's reach.
- **Top-right icons** — start a brand-new invoice, open Settings (numbering,
  product/customer library, backup/restore, erase data), and browse Saved
  Invoices (open, duplicate, or delete any past invoice/quotation).

## GST modes, explained
- **Exclusive**: you type the pre-tax unit price; GST is added on top.
- **Inclusive**: you type the final, tax-included unit price; the base price
  and GST are calculated backwards out of it.
CGST and SGST are always exactly half of the total GST each (standard
intra-state split shown on Indian retail tax invoices).
