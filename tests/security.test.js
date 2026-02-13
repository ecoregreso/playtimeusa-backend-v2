process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'superlongsecureaccesssecretstring1234567890';
process.env.JWT_REFRESH_SECRET = 'superlongsecurerefreshsecretstring1234567890';
process.env.DATABASE_URL = 'sqlite://:memory:';

const request = require('supertest');
const express = require('express');
const { sequelize, User, RefreshToken, Sequelize, Tenant } = require('../src/models');
const appServer = require('../src/server');
const { buildLimiter } = require('../src/utils/rateLimit');
const { recordFailure, getLock } = require('../src/utils/lockout');
const bcrypt = require('bcryptjs');

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

afterAll(async () => {
  await sequelize.close();
});

describe('Rate limiting', () => {
  test('custom limiter blocks after max hits', async () => {
    const testApp = express();
    testApp.use(express.json());
    const limiter = buildLimiter({ windowMs: 1000, max: 1, message: 'blocked' });
    testApp.post('/test', limiter, (req, res) => res.json({ ok: true }));
    const agent = request(testApp);
    await agent.post('/test');
    const res2 = await agent.post('/test');
    expect(res2.status).toBe(429);
    expect(res2.body.error).toBe('blocked');
  });
});

describe('Lockout logic', () => {
  test('locks after repeated failures', async () => {
    const subject = 'tenantX:user@example.com';
    for (let i = 0; i < 6; i++) {
      await recordFailure({ subjectType: 'user', subjectId: subject, tenantId: null });
    }
    const lock = await getLock('user', subject, null);
    expect(lock.locked).toBe(true);
    expect(lock.lockUntil).not.toBeNull();
  });
});

describe('Refresh rotation and reuse detection', () => {
  let user;
  let refreshToken;
  beforeAll(async () => {
    const passwordHash = await bcrypt.hash('Passw0rd!', 10);
    const tenant = await Tenant.create({ id: '11111111-1111-1111-1111-111111111111', name: 'Test Tenant' });
    user = await User.create({
      email: 'user@example.com',
      username: 'u1',
      passwordHash,
      role: 'player',
      tenantId: tenant.id,
    });
  });

  test('login stores hashed refresh token', async () => {
    const res = await request(appServer)
      .post('/auth/login')
      .send({ emailOrUsername: 'u1', password: 'Passw0rd!', tenantId: user.tenantId });
    expect(res.status).toBe(200);
    refreshToken = res.body.tokens.refreshToken;
    const stored = await RefreshToken.findOne({ where: { userId: user.id } });
    expect(stored).toBeTruthy();
    expect(stored.hashedToken).not.toBe(refreshToken);
  });

  test('refresh rotates and revokes old token', async () => {
    const res = await request(appServer)
      .post('/auth/refresh')
      .send({ refreshToken });
    expect(res.status).toBe(200);
    const revoked = await RefreshToken.findOne({ where: { userId: user.id, revokedReason: 'rotated' } });
    expect(revoked).toBeTruthy();
    refreshToken = res.body.tokens.refreshToken; // new token for reuse test
  });

  test('reuse triggers 401 and revokes all tokens', async () => {
    const res1 = await request(appServer)
      .post('/auth/refresh')
      .send({ refreshToken });
    expect(res1.status).toBe(200);
    // reuse previous token from res1 should be detected
    const reuse = await request(appServer)
      .post('/auth/refresh')
      .send({ refreshToken });
    expect(reuse.status).toBe(401);
    const countRevoked = await RefreshToken.count({ where: { userId: user.id, revokedAt: { [Sequelize.Op.ne]: null } } });
    expect(countRevoked).toBeGreaterThan(0);
  });
});
