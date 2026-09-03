import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const email = process.env.HIRMOS_E2E_EMAIL;
const password = process.env.HIRMOS_E2E_PASSWORD
  ?? (process.env.HIRMOS_E2E_PASSWORD_FILE
    ? readFileSync(process.env.HIRMOS_E2E_PASSWORD_FILE, 'utf8').trim()
    : undefined);

test.skip(!email || !password, 'HIRMOS_E2E_EMAIL and a password or password file are required');

test('one durable thread can be controlled and transferred between two browsers', async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  let first: Page | null = null;
  let queueBefore: number | null = null;
  try {
    first = await authenticatedPage(firstContext);
    await first.goto('/library');
    await first.getByRole('button', { name: /Canciones/ }).click();
    await expect(first.locator('.library-page .track-results button').first()).toBeVisible();
    queueBefore = await queueSize(first);
    const chosen = first.locator('.library-page .track-results button').first();
    const title = (await chosen.locator('strong').textContent())?.trim();
    await chosen.click();
    await expect(first.locator('.device-pill')).toContainText('Reproduciendo aquí');
    await expect(first.locator('.player-track strong')).toHaveText(title!);
    await expect(first.locator('.player-track .mini-cover')).toHaveCSS('width', '48px');

    const second = await authenticatedPage(secondContext);
    await expect(second.locator('.now-card h2')).toHaveText(title!);
    await expect(second.locator('.device-pill')).toContainText('Control remoto');

    await second.locator('.player-play').click();
    await expect(first.locator('.player-play')).toHaveAttribute('aria-label', 'Reproducir');
    await expect(second.locator('.player-play')).toHaveAttribute('aria-label', 'Reproducir');

    await second.getByRole('button', { name: 'Abrir cola' }).click();
    await second.getByRole('button', { name: /Reproducir aquí/ }).click();
    await expect(second.locator('.device-pill')).toContainText('Reproduciendo aquí');
    await expect(first.locator('.device-pill')).toContainText('Control remoto');

    await expect(second.locator('.queue-list li')).toHaveCount(queueBefore + 1);
    await second.locator('.queue-list li').last().locator('.queue-remove').click();
    await expect(second.locator('.queue-list li')).toHaveCount(queueBefore);
  } finally {
    if (first && queueBefore !== null && !first.isClosed()) {
      await trimQueue(first, queueBefore);
    }
    await firstContext.close();
    await secondContext.close();
  }
});

test('password recovery explains a password shorter than twelve characters', async ({ page }) => {
  await page.goto('/recuperar?token=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  await expect(page.locator('.auth-page')).toHaveCSS('display', 'grid');
  await expect(page.locator('link[rel="stylesheet"]')).not.toHaveAttribute('media', 'print');
  await page.locator('#password').fill('corta');
  await page.locator('#confirm-password').fill('corta');
  await page.getByRole('button', { name: 'Cambiar contraseña' }).click();
  await expect(page.getByText('Debe tener al menos 12 caracteres.')).toBeVisible();
  await expect(page.getByText('Corrige los campos marcados antes de continuar.')).toBeVisible();
});

async function authenticatedPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto('/login');
  await page.locator('#email').fill(email!);
  await page.locator('#password').fill(password!);
  await page.getByRole('button', { name: 'Entrar a Hirmos' }).click();
  await page.waitForURL(/\/$/);
  await expect(page.locator('h1')).toContainText('Hola');
  return page;
}

async function queueSize(page: Page): Promise<number> {
  await page.getByRole('button', { name: 'Abrir cola' }).click();
  const count = await page.locator('.queue-list li').count();
  await page.getByRole('button', { name: 'Cerrar cola' }).click();
  return count;
}

async function trimQueue(page: Page, targetSize: number): Promise<void> {
  await page.getByRole('button', { name: 'Abrir cola' }).click();
  const items = page.locator('.queue-list li');
  while (await items.count() > targetSize) {
    const count = await items.count();
    await items.last().locator('.queue-remove').click();
    await expect(items).toHaveCount(count - 1);
  }
}
