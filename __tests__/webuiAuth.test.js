import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import express from 'express'
import webuiAuth from '../lib/webuiAuth.cjs'

// @vitest-environment node

let tmpDataDir

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gss-auth-test-'))
  vi.stubEnv('GSS_DATA_DIR', tmpDataDir)
  vi.stubEnv('GSS_WEBUI_AUTH_DISABLED', undefined)
  vi.stubEnv('GSS_WEBUI_PASSWORD', undefined)
  // 清空配置（删文件 + 重置模块内缓存，防止测试间状态污染）
  webuiAuth._resetForTest()
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('webuiAuth 密码哈希', () => {
  it('verifyPassword 接受正确密码、拒绝错误密码', () => {
    const salt = crypto.randomBytes(16).toString('hex')
    const hash = webuiAuth.hashPassword('secret123', salt)
    expect(webuiAuth.verifyPassword('secret123', salt, hash)).toBe(true)
    expect(webuiAuth.verifyPassword('wrong', salt, hash)).toBe(false)
    expect(webuiAuth.verifyPassword('secret123', '', hash)).toBe(false)
  })

  it('hashPassword 每次相同输入产出相同结果（确定性）', () => {
    const salt = 'aabbccdd'
    expect(webuiAuth.hashPassword('pw', salt)).toBe(webuiAuth.hashPassword('pw', salt))
  })
})

describe('webuiAuth token 签发/验证', () => {
  it('signToken → verifyToken 往返成功，且含未来过期时间', () => {
    const token = webuiAuth.signToken()
    const payload = webuiAuth.verifyToken(token)
    expect(payload).not.toBeNull()
    expect(payload.v).toBe(1)
    expect(payload.exp).toBeGreaterThan(Date.now())
  })

  it('verifyToken 拒绝篡改的 token', () => {
    const token = webuiAuth.signToken()
    const tampered = token.slice(0, -3) + (token.endsWith('abc') ? 'xyz' : 'abc')
    expect(webuiAuth.verifyToken(tampered)).toBeNull()
  })

  it('verifyToken 拒绝乱串/null/undefined', () => {
    expect(webuiAuth.verifyToken('not-a-token')).toBeNull()
    expect(webuiAuth.verifyToken('')).toBeNull()
    expect(webuiAuth.verifyToken(null)).toBeNull()
    expect(webuiAuth.verifyToken(undefined)).toBeNull()
  })

  it('secret 持久化：两次调用 signToken 用同一 secret（重启不失效）', () => {
    const t1 = webuiAuth.signToken()
    // 模拟重启：清空缓存（secret 已落盘）
    const configPath = path.join(tmpDataDir, 'webui-config.json')
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    expect(cfg.secret).toBeTruthy()
    expect(webuiAuth.verifyToken(t1)).not.toBeNull()
  })
})

describe('webuiAuth 配置存取', () => {
  it('未配置时 isEnabled 为 false', () => {
    expect(webuiAuth.isEnabled()).toBe(false)
  })

  it('启用并设置密码后 isEnabled 为 true，密码可验证', () => {
    const salt = crypto.randomBytes(16).toString('hex')
    webuiAuth.writeConfig({ enabled: true, salt, passwordHash: webuiAuth.hashPassword('mypw', salt) })
    expect(webuiAuth.isEnabled()).toBe(true)
    const cfg = webuiAuth.readConfig()
    expect(webuiAuth.verifyPassword('mypw', cfg.salt, cfg.passwordHash)).toBe(true)
  })

  it('GSS_WEBUI_PASSWORD env 强制启用且优先于配置文件', () => {
    vi.stubEnv('GSS_WEBUI_PASSWORD', 'envpw')
    expect(webuiAuth.isEnabled()).toBe(true)
  })

  it('GSS_WEBUI_AUTH_DISABLED=1 完全禁用（Electron 场景）', () => {
    const salt = crypto.randomBytes(16).toString('hex')
    webuiAuth.writeConfig({ enabled: true, salt, passwordHash: webuiAuth.hashPassword('mypw', salt) })
    vi.stubEnv('GSS_WEBUI_AUTH_DISABLED', '1')
    expect(webuiAuth.isEnabled()).toBe(false)
  })
})

describe('webuiAuth 中间件', () => {
  function buildApp() {
    const app = express()
    app.use(express.json())
    // 中间件必须最先注册（Express 按注册顺序执行）
    app.use('/api', webuiAuth.middleware)
    app.use('/api/auth', webuiAuth.router())
    app.get('/api/health', (req, res) => res.json({ status: 'ok' }))
    app.get('/api/projects', (req, res) => res.json({ ok: true }))
    return app
  }

  it('未启用时全部放行', async () => {
    await request(buildApp()).get('/api/projects').expect(200, { ok: true })
  })

  it('启用后无 token 访问业务 API 返回 401', async () => {
    const salt = crypto.randomBytes(16).toString('hex')
    webuiAuth.writeConfig({ enabled: true, salt, passwordHash: webuiAuth.hashPassword('pw123', salt) })
    await request(buildApp()).get('/api/projects').expect(401)
  })

  it('启用后带有效 token 放行', async () => {
    const salt = crypto.randomBytes(16).toString('hex')
    webuiAuth.writeConfig({ enabled: true, salt, passwordHash: webuiAuth.hashPassword('pw123', salt) })
    const login = await request(buildApp()).post('/api/auth/login').send({ password: 'pw123' }).expect(200)
    const token = login.body.token
    expect(token).toBeTruthy()
    await request(buildApp()).get('/api/projects').set('Authorization', `Bearer ${token}`).expect(200)
  })

  it('健康检查始终放行（NSSM 探活）', async () => {
    const salt = crypto.randomBytes(16).toString('hex')
    webuiAuth.writeConfig({ enabled: true, salt, passwordHash: webuiAuth.hashPassword('pw123', salt) })
    await request(buildApp()).get('/api/health').expect(200)
  })
})

describe('webuiAuth HTTP 全流程（supertest 起真实 app）', () => {
  function buildFullApp() {
    const app = express()
    app.use(express.json())
    // 中间件必须最先注册（Express 按注册顺序执行）
    app.use('/api', webuiAuth.middleware)
    app.use('/api/auth', webuiAuth.router())
    // 模拟业务 API
    app.get('/api/projects', (req, res) => res.json({ list: [] }))
    return app
  }

  it('status 未启用时返回 enabled:false', async () => {
    const res = await request(buildFullApp()).get('/api/auth/status').expect(200)
    expect(res.body).toEqual({ enabled: false, authenticated: false })
  })

  it('首次开启：匿名 PATCH config 设置密码 → 登录 → 访问业务 API', async () => {
    const app = buildFullApp()
    // 1. 开启
    await request(app).patch('/api/auth/config').send({ enabled: true, password: 'firstpw' }).expect(200)
    expect(webuiAuth.isEnabled()).toBe(true)
    // 2. status 显示已启用
    const status = await request(app).get('/api/auth/status').expect(200)
    expect(status.body.enabled).toBe(true)
    // 3. 无 token 访问业务 → 401
    await request(app).get('/api/projects').expect(401)
    // 4. 登录
    const login = await request(app).post('/api/auth/login').send({ password: 'firstpw' }).expect(200)
    expect(login.body.token).toBeTruthy()
    // 5. 带 token 访问业务 → 200
    await request(app).get('/api/projects').set('Authorization', `Bearer ${login.body.token}`).expect(200)
  })

  it('登录密码错误返回 401 BAD_CREDENTIALS', async () => {
    const app = buildFullApp()
    await request(app).patch('/api/auth/config').send({ enabled: true, password: 'goodpw' }).expect(200)
    const res = await request(app).post('/api/auth/login').send({ password: 'wrongpw' }).expect(401)
    expect(res.body.code).toBe('BAD_CREDENTIALS')
  })

  it('已启用后改密码需 currentPassword；错误拒绝', async () => {
    const app = buildFullApp()
    await request(app).patch('/api/auth/config').send({ enabled: true, password: 'firstpw' }).expect(200)
    const login = await request(app).post('/api/auth/login').send({ password: 'firstpw' }).expect(200)
    const token = login.body.token
    const auth = { Authorization: `Bearer ${token}` }

    // 错误 currentPassword → 400
    const bad = await request(app)
      .patch('/api/auth/config')
      .set(auth)
      .send({ enabled: true, password: 'newpw', currentPassword: 'nope' })
      .expect(400)
    expect(bad.body.code).toBe('CURRENT_PASSWORD_REQUIRED')

    // 正确 currentPassword → 成功
    await request(app)
      .patch('/api/auth/config')
      .set(auth)
      .send({ enabled: true, password: 'newpw', currentPassword: 'firstpw' })
      .expect(200)

    // 旧密码失效，新密码可登录
    await request(app).post('/api/auth/login').send({ password: 'firstpw' }).expect(401)
    await request(app).post('/api/auth/login').send({ password: 'newpw' }).expect(200)
  })

  it('已启用后关闭需 currentPassword；成功后业务 API 放行', async () => {
    const app = buildFullApp()
    await request(app).patch('/api/auth/config').send({ enabled: true, password: 'firstpw' }).expect(200)
    const login = await request(app).post('/api/auth/login').send({ password: 'firstpw' }).expect(200)
    const auth = { Authorization: `Bearer ${login.body.token}` }

    // 无 currentPassword 关闭 → 400
    const bad = await request(app).patch('/api/auth/config').set(auth).send({ enabled: false }).expect(400)
    expect(bad.body.code).toBe('CURRENT_PASSWORD_REQUIRED')

    // 正确关闭
    await request(app)
      .patch('/api/auth/config')
      .set(auth)
      .send({ enabled: false, currentPassword: 'firstpw' })
      .expect(200)
    expect(webuiAuth.isEnabled()).toBe(false)
    // 关闭后无需 token
    await request(app).get('/api/projects').expect(200)
  })

  it('密码过短（<4）拒绝开启', async () => {
    const res = await request(buildFullApp())
      .patch('/api/auth/config')
      .send({ enabled: true, password: 'ab' })
      .expect(400)
    expect(res.body.code).toBe('PASSWORD_TOO_SHORT')
  })

  it('未启用时 PATCH enabled:false 幂等返回', async () => {
    const res = await request(buildFullApp()).patch('/api/auth/config').send({ enabled: false }).expect(200)
    expect(res.body).toEqual({ enabled: false })
  })

  it('GSS_WEBUI_PASSWORD env 存在时拒绝 PATCH config（403）', async () => {
    vi.stubEnv('GSS_WEBUI_PASSWORD', 'envpw')
    const res = await request(buildFullApp())
      .patch('/api/auth/config')
      .send({ enabled: false })
      .expect(403)
    expect(res.body.code).toBe('ENV_CONTROLLED')
    // env 密码可直接登录
    const login = await request(buildFullApp()).post('/api/auth/login').send({ password: 'envpw' }).expect(200)
    expect(login.body.token).toBeTruthy()
  })
})
