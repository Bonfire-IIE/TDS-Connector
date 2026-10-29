/* Isolated UI contract smoke: fixtures are test-only, production pages never use them. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const assert = require('node:assert/strict')
;(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] })
  let activePage
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    activePage = page
    const errors = []; const writes = []; let readonly = false
    page.on('pageerror', e => errors.push(e.message))
    await page.addInitScript(() => sessionStorage.setItem('bonfire_portal_token', 'test-browser-token'))
    const source = { id: 'input', name: '输入文件', kind: 'localfs' }, target = { id: 'output', name: '输出文件', kind: 'oss' }
    const resource = { id: 'resource', source_id: 'input', object_ref: 'input.csv', metadata: { resource_name: '测试资源' }, status: 'registered', revision: 3, version: 1 }
    await page.route('**/portal/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname, method = req.method()
      let value = {}, status = 200
      if (method !== 'GET') writes.push({ path, method, body: req.postDataJSON(), headers: req.headers() })
      if (path === '/portal/onboarding/state') value = { code: 0, data: { onboarded: true } }
      else if (path === '/portal/services/capabilities') value = { services: { di: { roles: readonly ? ['source:read', 'transfer:read'] : ['source:read', 'source:write', 'transfer:read', 'transfer:write'] }, dr: { roles: ['resource:read', 'resource:write', 'resource:publish'] }, ts: { roles: ['admin', 'grant'] } } }
      else if (path.endsWith('/datasources') || path.endsWith('/sources')) value = method === 'GET' ? { items: [source, target] } : { ...source, name: '新数据源' }
      else if (/\/(datasources|sources)\/input\/objects$/.test(path)) value = { items: [{ ref: 'input.csv', name: 'input.csv', kind: 'file' }], next_offset: null }
      else if (path.endsWith('/inspect')) value = path.includes('/dr/') ? { data_items: [{ name: 'id', type: 'string', comment: '' }] } : { columns: ['id'], column_types: { id: 'string' } }
      else if (path.endsWith('/transfers')) value = method === 'GET' ? { items: [], total: 0 } : { id: 'transfer', state: 'created' }
      else if (path.endsWith('/metadata-options')) value = { industries: { I: '信息服务' }, data_types: { table: '结构化表格' }, data_source_types: { '01': '原始取得' }, security_levels: { general_1: '一般一级' }, personal_information_levels: { '0': '不涉及个人信息' }, column_types: ['string'], themes: [] }
      else if (path.endsWith('/resources')) value = method === 'GET' ? { items: [resource], total: 1 } : { ...resource, id: 'new-resource' }
      else if (path.endsWith('/publish')) value = { ...resource, status: 'pending_review' }
      else if (path.endsWith('/admin/summary')) value = { objects: 1, bytes: 10, outbox_pending: 0, dead_jobs: 0 }
      else if (path === '/portal/services/ts/objects') value = { items: [{ id: 'object', state: 'ACTIVE', logical_name: '测试对象' }] }
      else if (path.endsWith('/access')) value = { url: 'https://storage.test/one-time-only', capability_returned: true }
      else { status = 404; value = { error: 'unmocked:' + path } }
      await route.fulfill({ status, json: value })
    })
    const base = process.env.PORTAL_BROWSER_URL || 'http://127.0.0.1:18731'
    async function select(id, label) { await page.locator('#'+id).click(); await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content').getByText(label, { exact: true }).last().click(); await page.waitForTimeout(250) }
    await page.goto(base+'/datasources')
    await page.getByRole('button', { name: '登记数据源', exact: true }).click()
    await page.locator('#name').fill('新数据源'); await page.locator('#path').fill('/data/t1/edge')
    await page.getByRole('button', { name: '确 定' }).click()
    await page.waitForFunction(() => !document.querySelector('.ant-modal'))
    assert.equal(writes.at(-1).path, '/portal/services/di/datasources')
    assert.deepEqual(writes.at(-1).body, { name: '新数据源', kind: 'localfs', config: { path: '/data/t1/edge' } })

    await page.goto(base+'/data-movement')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await select('source_id', '输入文件')
    await page.getByRole('row').filter({ hasText: 'input.csv' }).getByRole('checkbox').check()
    await select('target_id', '输出文件')
    await page.getByRole('button', { name: '探测结构', exact: true }).click()
    await page.locator('#columns_0_name').waitFor()
    await page.getByRole('button', { name: '确 定' }).click()
    await page.waitForFunction(() => !document.querySelector('.ant-modal'))
    assert.equal(writes.at(-1).path, '/portal/services/di/transfers')
    assert.deepEqual(writes.at(-1).body.source_refs, ['input.csv'])
    assert.equal(writes.at(-1).body.mode, 'structured-file')
    assert.ok(writes.at(-1).headers['idempotency-key'])
    assert.ok(!writes.some(v => /transfers\/.+\/run/.test(v.path)), 'create must not auto-run')

    await page.goto(base+'/resources')
    await page.getByRole('button', { name: '申请公开', exact: true }).click()
    await page.waitForTimeout(200)
    assert.equal(writes.at(-1).headers['if-match'], '3')
    await page.getByRole('button', { name: '登记资源', exact: true }).click()
    await select('source_id', '输入文件')
    await page.getByRole('row').filter({ hasText: 'input.csv' }).getByRole('radio').check()
    await page.getByRole('button', { name: '探测字段', exact: true }).click()
    await page.locator('#data_items_0_name').waitFor()
    for (const [id, value] of Object.entries({ resource_name: '新资源', resource_abstract: '测试说明', resource_owner_name: '测试单位', resource_owner_id: 'holder', contact_name: '张三', contact_information: '13800000000' })) await page.locator('#'+id).fill(value)
    for (const [id, value] of Object.entries({ industry_code: '信息服务', data_type: '结构化表格', data_source_type: '原始取得', security_level: '一般一级', personal_information_level: '不涉及个人信息' })) await select(id, value)
    await page.getByRole('button', { name: '确 定' }).click()
    await page.waitForFunction(() => !document.querySelector('.ant-modal'))
    assert.equal(writes.at(-1).path, '/portal/services/dr/resources')
    assert.equal(writes.at(-1).body.data_items[0].name, 'id')
    assert.equal(writes.at(-1).body.metadata.industry_code, 'I')

    await page.goto(base+'/transit-storage')
    await page.getByRole('button', { name: /访\s*问/, exact: true }).click()
    await page.locator('#version_id').fill('v1'); await page.locator('#purpose').fill('analysis')
    await page.getByRole('button', { name: '确 定' }).click()
    await page.getByText('https://storage.test/one-time-only', { exact: true }).waitFor()
    assert.ok(writes.at(-1).headers['idempotency-key'])
    await page.getByRole('button', { name: 'Close' }).click()
    await page.getByText('https://storage.test/one-time-only', { exact: true }).waitFor({ state: 'detached' })
    assert.equal(await page.getByText('https://storage.test/one-time-only', { exact: true }).count(), 0)
    assert.ok(!(await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }))).includes('one-time-only'))

    readonly = true; await page.goto(base+'/datasources')
    await page.getByRole('cell', { name: '输入文件', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '登记数据源', exact: true }).count(), 0)
    assert.deepEqual(errors, [])
    console.log('PASS source registration, transfer create-only/idempotency, DR revision/schema, TS one-shot credential, read-only UI; no browser errors')
  } catch (e) { console.error('Visible form errors:', await activePage.locator('.ant-form-item-explain-error, .ant-alert-message').allTextContents()); console.error('Fields:', await activePage.locator('.ant-modal input').evaluateAll(nodes => nodes.map(n => [n.id,n.value]))); await activePage.screenshot({ path: '/tmp/portal-microservices-browser-failure.png', fullPage: true }); throw e } finally { await browser.close() }
})().catch(e => { console.error(e); process.exit(1) })
