# Online widget

Enable sharing under site settings, Online widget. Sharing starts off. Separately opt into historical visitor sharing. Online counts distinct visitor IDs active within five minutes among sessions started in the last 30 days. Visitors counts distinct visitor IDs with sessions started in the rolling last 30 days.

GET /api/public/online/:siteId returns only `{ online, visitors }`. Each value is a public number or null when disabled or below the minimum. Missing sites and disabled sharing return an empty 404. The minimum defaults to 3 and cannot be smaller. Rounding defaults on and rounds down to two significant digits. Both metrics use the same privacy settings independently. Counts can be saved and compared by anyone.

Responses cache for 20 seconds in the browser and at the edge. Privacy settings are checked before edge lookup; an already delivered response may remain visible for 20 seconds. Rate limiting permits 120 requests per minute per hashed address across sites; excess requests return 429. Only GET retrieves data. CORS permits every origin. No credentials, cookies, identifiers, or events are sent by the widget.

```html
<script async src="https://YOUR-HOST/js/widget.js"></script>
<datamonster-online site="SITE_ID" theme="auto" powered="true" style="display:inline-block;height:34px"></datamonster-online>
```

The existing tracker loads the widget adapter when the element appears, so tracker users can omit the extra script. The tracker retains its own tracking behavior. Standalone loader attributes `data-site`, `data-theme`, `data-size`, `data-placement`, and `data-powered` also create an element at the script location. Element attributes: site; theme light/dark/auto; size small/medium/large; placement inline/bottom-left/bottom-right; powered true/false. Reserve 34 pixels of height; the pill is as wide as its longest text, so it never changes width while rotating; the credit is a tooltip shown above the pill on hover or keyboard focus and takes no layout space; scale reservations by 0.9 for small and 1.15 for large. Default theme is auto and placement is inline. The snippet includes the owner-selected theme and credit preference. Credit is removable on every plan.

The fixed pill and dot do not move. Its ring pulses every 2.4 seconds; valid metrics alternate after a 3.6-second dwell with a 420ms downward transition. Hidden tabs stop polling and motion. Reduced motion keeps the online metric static (or visitors if only that metric is available). A polite status announces changed public aggregates, never carousel transitions. Failed requests hide stale counts while preserving the reserved slot. Numbers, labels, and the attached credit use the same system font, with tabular numerals to keep updates steady. The optional credit sits inside the rounded surface with theme-specific contrast, hover underline, and a visible keyboard focus ring. Shadow DOM isolates internal styles; no fonts are downloaded.

Write-scope agent tools `enable_online_widget` and `get_online_widget` take site_id and the public install origin, return settings and snippet, and are audit logged. Enable accepts enabled, visitors, threshold, rounding, theme and powered. Omitted enable options preserve saved values. Setting enabled=false disables sharing. The shared tool schemas generate the OpenAPI endpoints.
