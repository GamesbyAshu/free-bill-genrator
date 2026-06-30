# Free Bill Generator — Offline GST Invoice & Quotation Generator
freebillgenerator.com

Pure HTML/CSS/JavaScript. No backend, no build step, no login.

## How to use
1. Put all files (`index.html`, `style.css`, `script.js`, `robots.txt`,
   `sitemap.xml`) in the **root** of your hosting for freebillgenerator.com —
   don't nest them in a subfolder, or the SEO/canonical URLs will be wrong.
2. Open `index.html` in any browser — Chrome, Safari, Edge — on Android,
   iPhone, or desktop.
3. For PDF export specifically, the **first time** you open the page you need
   an internet connection once, because `jsPDF` and `html2canvas` are loaded
   from a CDN (`cdnjs.cloudflare.com`) in `index.html`. After the browser has
   cached them, PDF export keeps working offline too. Everything else (forms,
   GST maths, live preview, Print, LocalStorage saving) works fully offline
   from the very first load.

## Getting it to actually show up on Google
A brand-new domain showing nothing on Google for weeks/months after launch is
normal — it's not necessarily broken. A few things that genuinely help:

1. **Submit to Google Search Console** (free, search-console at Google) —
   add the `freebillgenerator.com` property, verify ownership, then submit
   `https://www.freebillgenerator.com/sitemap.xml`. This is the single
   biggest lever — Google mostly won't find/index a new site on its own
   for a while without this nudge.
2. **Get at least one external link** pointing to the site (a business
   directory listing, a social media bio link, a mention on Reddit/a forum
   answering a relevant question). New domains with zero backlinks rank very
   slowly even with perfect on-page SEO.
3. **Replace the placeholder OG image.** `index.html` currently references
   `https://www.freebillgenerator.com/og-image.png` for social-share previews
   — upload an actual 1200×630px PNG/JPG at that path, or remove those two
   `og:image`/`twitter:image` lines if you don't have one yet.
4. **Indexing takes time even when everything is correct** — typically days
   to a few weeks for a small new site, not minutes. Search Console's URL
   Inspection tool lets you request indexing manually to speed this up.
5. Don't change the page's core wording/H1 too often in the first few weeks
   — Google needs a stable signal of what the page is about.

What's already done for you in this build: descriptive `<title>` and meta
description, Open Graph + Twitter card tags, a canonical URL, JSON-LD
structured data describing this as a free software application, a real
crawlable content section at the bottom of the page (features, how-to steps,
and an FAQ) so Google has actual text to match against search queries, plus
`robots.txt` and `sitemap.xml`.

## Logo / favicon files
A logo has been designed and generated for you, using the app's teal ₹ mark:
- `favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png` — browser tab icon
  and what Google Search shows next to your site in results.
- `favicon-192x192.png`, `favicon-512x512.png` — Android/PWA home-screen icon,
  also referenced by `manifest.json`.
- `apple-touch-icon.png` — iOS "Add to Home Screen" icon.
- `og-image.png` (1200×630) — the banner shown when this link is shared on
  WhatsApp, Facebook, Twitter/X, LinkedIn, or in some Google rich previews.
All of these **must sit at the root of your domain** alongside `index.html` —
the same place as everything else.

Want to swap in your own logo later? Replace these same filenames with your
own images at the same dimensions (square for the favicons, 1200×630 for
`og-image.png`), keep them at the domain root, then in **Google Search
Console** use the URL Inspection tool to "Request Indexing" on the homepage
again so Google notices the change. The favicon specifically can take Google
1–2 weeks to refresh in search results even after you update it — that's
normal and not a sign anything's broken.

## Google Analytics
A GA4 tag (`G-M5LYJSQEDV`) is already wired into `<head>`. Once the site is
live, check Google Analytics Realtime view while browsing the page yourself
to confirm it's firing.

## Where your data lives
Everything is saved in the browser's LocalStorage on that device only:
business profile, bank details, logo, signature, customers, products, and
every saved invoice/quotation. Nothing is sent anywhere except anonymous
Analytics page-view events. Clearing your browser's site data (or using a
different browser/device) starts fresh. Use **Settings → Export All Data**
to back up to a JSON file you can re-import later or move to another device.

## Quick tour
- **Business tab** — your shop details, GSTIN, bank details, logo, and
  signature. Tap "Save Business Profile" to keep it permanently.
- **Customer tab** — pick a saved customer or add a new one; also where you
  set invoice/quotation number, dates, place of supply, and switch between
  Exclusive/Inclusive GST mode.
- **Items tab** — add products, search your saved Product Library, type any
  GST% you need; each row shows its live Amount/GST/CGST/SGST/Total.
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
intra-state split shown on Indian retail tax invoices). GST% itself is a free
text field — enter any rate, not just the standard 5/12/18/28 slabs.
