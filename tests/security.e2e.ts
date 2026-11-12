import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'

test('the editor cannot be embedded by another origin', async ({ page }) => {
  const messages: string[] = []
  page.on('console', message => messages.push(message.text()))
  // A separate loopback origin reproduces framing without an external website.
  // Use a real local server: fulfilling a fabricated network request makes
  // Chromium classify the parent as public and block it before CSP is checked.
  const parent = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Connection': 'close' })
    response.end('<!doctype html><iframe title="embedded editor" src="http://127.0.0.1:5173/"></iframe>')
  })
  try {
    await new Promise<void>(resolve => parent.listen(0, '127.0.0.1', resolve))
    const address = parent.address()
    if (!address || typeof address === 'string') throw new Error('No local test server')
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await expect.poll(() => messages.some(message => /frame-ancestors|X-Frame-Options/i.test(message))).toBe(true)
    await expect(page.frameLocator('iframe').getByRole('textbox', { name: '歌詞エディター', exact: true })).toHaveCount(0)
  } finally { await new Promise<void>((resolve, reject) => parent.close(error => error ? reject(error) : resolve())) }
})
