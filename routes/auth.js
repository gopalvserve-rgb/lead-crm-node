const db = require('../db/pg');
const { signToken, verifyPassword, authUser, hashPassword } = require('../utils/auth');

async function api_login(email, password) {
  if (!email || !password) throw new Error('Email and password required');
  const user = await db.findOneBy('users', 'email', String(email).toLowerCase().trim());
  if (!user || !user.is_active) throw new Error('Invalid email or password');
  if (!verifyPassword(password, user.password_hash)) throw new Error('Invalid email or password');
  const token = signToken(user);
  return {
    token,
    user: {
      id: user.id, name: user.name, email: user.email,
      role: user.role, parent_id: user.parent_id,
      department: user.department, photo_url: user.photo_url
    }
  };
}

async function api_me(token) {
  const user = await authUser(token);
  return {
    id: user.id, name: user.name, email: user.email,
    role: user.role, parent_id: user.parent_id,
    department: user.department, photo_url: user.photo_url
  };
}

async function api_logout() { return { ok: true }; }

async function api_changePassword(token, oldPassword, newPassword) {
  const user = await authUser(token);
  if (!verifyPassword(oldPassword, user.password_hash)) throw new Error('Old password is wrong');
  await db.update('users', user.id, { password_hash: hashPassword(newPassword) });
  return { ok: true };
}

module.exports = { api_login, api_me, api_logout, api_changePassword };
