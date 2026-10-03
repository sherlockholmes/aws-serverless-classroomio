export async function getCloudflarePdfBuffer(html: string, styles?: string): Promise<Buffer> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiKey = process.env.CLOUDFLARE_RENDERING_API_KEY;
  if (!accountId || !apiKey) throw new Error('Cloudflare Browser Rendering is not configured');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/pdf`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ html, addStyleTag: [{ content: styles ?? '' }] })
  });
  if (!response.ok) throw new Error(`Cloudflare PDF rendering failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function getCloudflarePngBuffer(html: string, styles?: string): Promise<Buffer> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiKey = process.env.CLOUDFLARE_RENDERING_API_KEY;
  if (!accountId || !apiKey) throw new Error('Cloudflare Browser Rendering is not configured');
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/screenshot`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        html,
        addStyleTag: styles ? [{ content: styles }] : undefined,
        viewport: { width: 1100, height: 780, deviceScaleFactor: 2 },
        screenshotOptions: { type: 'png', omitBackground: false, fullPage: false }
      })
    }
  );
  if (!response.ok) throw new Error(`Cloudflare PNG rendering failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
