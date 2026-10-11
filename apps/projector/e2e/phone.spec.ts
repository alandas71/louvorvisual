import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { open, stage } from './helpers';

async function selectFirst(page: Page, id: string, offset = 0) {
  const previous = await page.evaluate(() => window.__lvSession?.sessionId ?? null);
  await page.evaluate(({id, offset}) => window.__lvMock.emit('phone.command',{id,command:{type:'select',arrangementId:window.__lvMock.phoneSongs()[offset]!.arrangementId,setlistId:null,itemId:null}}), {id, offset});
  await expect.poll(() => page.evaluate(() => window.__lvSession?.sessionId ?? null)).not.toBe(previous);
  await expect(stage(page)).toHaveAttribute('data-status','ready');
}

async function command(page: Page, type: 'start'|'next'|'previous'|'black'|'normal'|'end', id: string, sessionId?: string) {
  await page.evaluate(({type,id,sessionId}) => window.__lvMock.emit('phone.command',{id,command:{type,sessionId:sessionId ?? window.__lvSession.sessionId}}),{type,id,sessionId});
  await expect.poll(() => page.evaluate(id => window.__lvMock.requests.find(request => request.method === 'phone.ack' && (request.params as {id:string}).id === id)?.params, id)).toMatchObject({id});
}

test('celular escolhe, inicia, avança e apaga a saída limpa; sessão antiga é recusada', async ({ page }) => {
  await open(page);
  await selectFirst(page,'11111111-1111-4111-8111-111111111111');
  await expect(page.getByTestId('ready-dialog')).toHaveCount(0);
  await command(page,'start','22222222-2222-4222-8222-222222222222');
  await expect(stage(page)).toHaveAttribute('data-overlay','none');
  await command(page,'next','33333333-3333-4333-8333-333333333333');
  await expect(stage(page)).toHaveAttribute('data-slide-index','1');
  await command(page,'black','44444444-4444-4444-8444-444444444444');
  await expect.poll(() => page.evaluate(() => window.__lvMock.phonePresentation.visualMode)).toBe('black');
  await command(page,'normal','55555555-5555-4555-8555-555555555555');
  await expect.poll(() => page.evaluate(() => window.__lvMock.phonePresentation.visualMode)).toBe('normal');
  const oldSession = await page.evaluate(() => window.__lvSession.sessionId);
  await selectFirst(page,'66666666-6666-4666-8666-666666666666',1);
  await command(page,'next','77777777-7777-4777-8777-777777777777',oldSession);
  await expect.poll(() => page.evaluate(() => window.__lvMock.requests.find(request => request.method === 'phone.ack' && (request.params as {id:string}).id.startsWith('7777'))?.params)).toMatchObject({ok:false});
  await expect(stage(page)).toHaveAttribute('data-slide-index','0');
  await command(page,'end','88888888-8888-4888-8888-888888888888');
  await expect(page.getByTestId('app')).toHaveAttribute('data-screen','home');
});

test('pareamento é navegável pelo controle do projetor', async ({ page }) => {
  await open(page);
  await page.getByTestId('card-phone').click();
  await expect(page.getByTestId('phone-code')).toContainText('123456');
  await page.getByTestId('phone-close').click();
  await expect(page.getByTestId('app')).toHaveAttribute('data-screen','home');
});

test('painel móvel pareia e controla a apresentação com prévia', async ({ page, context }) => {
  await open(page);
  const phone = await context.newPage();
  await phone.setViewportSize({width:390,height:844});
  const base = '../android/app/src/main/assets/phone/';
  await phone.route('**/phone-test/', async route => route.fulfill({contentType:'text/html',body:await readFile(base+'index.html','utf8')}));
  await phone.route('**/controller.js', async route => route.fulfill({contentType:'text/javascript',body:await readFile(base+'controller.js','utf8')}));
  await phone.route('**/pair', route => route.fulfill({json:{token:'test-token'}}));
  await phone.route('**/status', async route => route.fulfill({json:{foreground:true,presentation:await page.evaluate(() => window.__lvMock.phonePresentation)}}));
  await phone.route('**/library?**', async route => route.fulfill({json:{items:await page.evaluate(() => window.__lvMock.phoneSongs()),nextCursor:null}}));
  await phone.route('**/command', async route => {
    const event = route.request().postDataJSON();
    await page.evaluate(event => window.__lvMock.emit('phone.command',event),event);
    await page.waitForFunction(id => window.__lvMock.requests.some(request=>request.method==='phone.ack'&&(request.params as {id:string}).id===id),event.id);
    const answer = await page.evaluate(id=>window.__lvMock.requests.find(request=>request.method==='phone.ack'&&(request.params as {id:string}).id===id)!.params,event.id);
    await route.fulfill({json:answer});
  });
  await phone.goto('/phone-test/');
  await phone.getByLabel('Código de 6 dígitos').fill('123456');
  await phone.getByRole('button',{name:'Conectar',exact:true}).click();
  await phone.locator('#library button').first().click();
  await expect(phone.getByRole('button',{name:'Iniciar apresentação',exact:true})).toBeEnabled();
  await phone.getByRole('button',{name:'Iniciar apresentação',exact:true}).click();
  await expect(stage(page)).toHaveAttribute('data-status','running');
  await phone.getByRole('button',{name:'Próximo →',exact:true}).click();
  await expect(stage(page)).toHaveAttribute('data-slide-index','1');
  await expect(phone.locator('#preview')).not.toBeEmpty();
  expect(await phone.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
