const { Player } = require('../models');
const { hashPassword, comparePassword } = require('../utils/password');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt');

function sanitizePlayer(player) {
  return {
    id: player.id,
    email: player.email,
    username: player.username,
    role: player.role,
    status: player.status,
    balance: player.balance,
    createdAt: player.createdAt,
  };
}

async function register(req, res, next) {
  try {
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
      return res.status(400).json({ error: 'email, username and password are required' });
    }

    const existingEmail = await Player.findOne({ where: { email } });
    if (existingEmail) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const existingUsername = await Player.findOne({ where: { username } });
    if (existingUsername) {
      return res.status(409).json({ error: 'Username already in use' });
    }

    const passwordHash = await hashPassword(password);

    const player = await Player.create({
      email,
      username,
      passwordHash,
    });

    const payload = { id: player.id, role: player.role };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    res.status(201).json({
      user: sanitizePlayer(player),
      tokens: {
        access: accessToken,
        refresh: refreshToken,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { emailOrUsername, password } = req.body;

    if (!emailOrUsername || !password) {
      return res.status(400).json({ error: 'emailOrUsername and password are required' });
    }

    const player = await Player.findOne({
      where: {
        // naive OR logic; better to separate email / username in UI, but this is convenient
        // Sequelize OR:
        // [Op.or]: [{ email: emailOrUsername }, { username: emailOrUsername }],
      },
    });

    // Because we didn't import Op, simple workaround: try email, then username
    let user = player;
    if (!user) {
      user = await Player.findOne({ where: { username: emailOrUsername } });
    }
    if (!user) {
      user = await Player.findOne({ where: { email: emailOrUsername } });
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await comparePassword(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.status === 'blocked') {
      return res.status(403).json({ error: 'Account is blocked' });
    }

    const payload = { id: user.id, role: user.role };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    res.json({
      user: sanitizePlayer(user),
      tokens: {
        access: accessToken,
        refresh: refreshToken,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    // req.user is populated by auth middleware
    const player = await Player.findByPk(req.user.id);
    if (!player) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: sanitizePlayer(player) });
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken is required' });
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const player = await Player.findByPk(decoded.id);
    if (!player || player.status === 'blocked') {
      return res.status(401).json({ error: 'Invalid or blocked account' });
    }

    const payload = { id: player.id, role: player.role };
    const newAccessToken = signAccessToken(payload);
    const newRefreshToken = signRefreshToken(payload);

    res.json({
      user: sanitizePlayer(player),
      tokens: {
        access: newAccessToken,
        refresh: newRefreshToken,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  register,
  login,
  me,
  refresh,
};
