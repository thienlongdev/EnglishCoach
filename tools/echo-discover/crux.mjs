// Optional read-only report. Configure a restricted CrUX API key in the process environment.
const key = process.env.CRUX_API_KEY;
if (!key) throw new Error('Set CRUX_API_KEY to request the public origin report.');
const endpoint = new URL('https://chromeuxreport.googleapis.com/v1/records:queryRecord');
endpoint.searchParams.set('key', key);
const metrics = ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'];
for (const formFactor of ['PHONE', 'DESKTOP']) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origin: 'https://englishcoach.io.vn', formFactor, metrics }) });
  if (response.status === 404) { console.log(formFactor + ': insufficient CrUX coverage'); continue; }
  if (!response.ok) throw new Error('CrUX HTTP ' + response.status);
  const { record } = await response.json();
  console.log(JSON.stringify({ formFactor, period: record.collectionPeriod,
    p75: Object.fromEntries(metrics.map(metric => [metric, record.metrics[metric]?.percentiles?.p75 ?? null])) }));
}
