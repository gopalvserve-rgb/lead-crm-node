/**
 * routes/chat.js — internal team chat (group channels + 1-on-1 DMs).
 *
 * Two flavours of room:
 *   channel — public; everyone implicitly a member. Seeded with one room
 *             named 'team' on schema init.
 *   dm      — direct message; exactly two members.
 *
 * Polling-based — clients call api_chat_messages_list every 4-5s while
 * the chat tab is open. New DMs also fire a Web Push to the recipient
 * so it lands like SMS even when the app is closed.
 */

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const ALL_ROLES = ['admin', 'manager', 'team_leader', 'sales', 'employee'];

/**
 * Read the admin-set list of roles allowed to use the team chat. Default
 * (when never configured) is ALL_ROLES so a fresh install just works.
 * Admin is ALWAYS allowed regardless of config — to keep them from locking
 * themselves out by accident.
 */
async function _allowedRoles() {
  let stored;
  try { stored = await db.getConfig('chat_allowed_roles', null); }
  catch (_) { stored = null; }
  if (!stored) return ALL_ROLES.slice();
  const list = String(stored).split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return ALL_ROLES.slice();
  // Admin always retains access
  if (!list.includes('admin')) list.push('admin');
  return list;
}

async function _ensureCanChat(me) {
  const allowed = await _allowedRoles();
  if (!allowed.includes(me.role)) {
    const err = new Error('Team chat is not enabled for your role. Ask your admin.');
    err.code = 'CHAT_DISABLED';
    throw err;
  }
}

async function _userMap() {
  const users = await db.getAll('users');
  const byId = {}; users.forEach(u => { byId[Number(u.id)] = u; });
  return byId;
}

/**
 * For the DM picker: every active user the caller can chat with, regardless
 * of lead-visibility hierarchy. Returns minimal fields (id, name, role).
 *
 * Why a separate endpoint? CRM.cache.users on the frontend is filtered by
 * the lead-management hierarchy (a sales rep only sees themselves there),
 * so it can't be reused for the chat picker — chat is a team-comms tool,
 * everyone needs to see everyone.
 */
async function api_chat_visibleUsers(token) {
  const me = await authUser(token);
  await _ensureCanChat(me);
  const allowed = await _allowedRoles();
  const users = await db.getAll('users');
  return users
    .filter(u => Number(u.is_active) === 1)
    .filter(u => allowed.includes(u.role))
    .map(u => ({ id: u.id, name: u.name, role: u.role, photo_url: u.photo_url || '' }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Surfaces the current chat-permission config to the client so the nav
 *  entry can hide itself when chat is disabled for the user's role. */
async function api_chat_myAccess(token) {
  const me = await authUser(token);
  const allowed = await _allowedRoles();
  return { allowed_roles: allowed, can_chat: allowed.includes(me.role) };
}

/** Admin-only — read the current allowed-roles list */
async function api_chat_settings_get(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const allowed = await _allowedRoles();
  return { allowed_roles: allowed, all_roles: ALL_ROLES };
}

/** Admin-only — set the allowed-roles list. Pass an array of role strings. */
async function api_chat_settings_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const list = Array.isArray(payload?.allowed_roles) ? payload.allowed_roles : [];
  const cleaned = list
    .map(r => String(r).trim().toLowerCase())
    .filter(r => ALL_ROLES.includes(r));
  // Admin always retained
  if (!cleaned.includes('admin')) cleaned.push('admin');
  await db.setConfig('chat_allowed_roles', cleaned.join(','));
  return { ok: true, allowed_roles: cleaned };
}

/**
 * Find or create the DM room for the calling user + the given otherId.
 * DM rooms are uniquely identified by their two members; we look up
 * existing rooms first to avoid duplicates.
 */
async function _ensureDmRoom(me, otherId) {
  const otherUser = await db.findById('users', otherId);
  if (!otherUser) throw new Error('User not found');
  const all = await db.getAll('chat_rooms');
  const dms = all.filter(r => r.type === 'dm');
  const members = await db.getAll('chat_room_members');
  for (const r of dms) {
    const ms = members.filter(m => Number(m.room_id) === Number(r.id));
    if (ms.length !== 2) continue;
    const ids = ms.map(m => Number(m.user_id)).sort();
    const want = [Number(me.id), Number(otherId)].sort();
    if (ids[0] === want[0] && ids[1] === want[1]) return r;
  }
  const id = await db.insert('chat_rooms', {
    type: 'dm', name: null, created_at: db.nowIso()
  });
  await db.insert('chat_room_members', {
    room_id: id, user_id: me.id, joined_at: db.nowIso()
  });
  await db.insert('chat_room_members', {
    room_id: id, user_id: otherId, joined_at: db.nowIso()
  });
  return await db.findById('chat_rooms', id);
}

async function _ensureChannelMember(roomId, userId) {
  const all = await db.getAll('chat_room_members');
  const existing = all.find(m =>
    Number(m.room_id) === Number(roomId) &&
    Number(m.user_id) === Number(userId)
  );
  if (existing) return existing;
  const id = await db.insert('chat_room_members', {
    room_id: roomId, user_id: userId, joined_at: db.nowIso()
  });
  return await db.findById('chat_room_members', id);
}

/**
 * List every room the calling user can see, with last-message preview +
 * unread count. Channels are visible to everyone; DMs only to their
 * two members. Sorted by most-recent activity descending.
 */
async function api_chat_rooms_list(token) {
  const me = await authUser(token);
  await _ensureCanChat(me);
  const usersById = await _userMap();
  const [rooms, members, messages] = await Promise.all([
    db.getAll('chat_rooms'),
    db.getAll('chat_room_members'),
    db.getAll('chat_messages')
  ]);

  // Most recent message per room — for the preview + sort key
  const latestByRoom = {};
  messages.forEach(m => {
    const cur = latestByRoom[Number(m.room_id)];
    if (!cur || String(m.created_at) > String(cur.created_at)) {
      latestByRoom[Number(m.room_id)] = m;
    }
  });

  const myMemberships = members.filter(m => Number(m.user_id) === Number(me.id));
  const myRoomIds = new Set(myMemberships.map(m => Number(m.room_id)));
  const lastReadByRoom = {};
  myMemberships.forEach(m => {
    lastReadByRoom[Number(m.room_id)] = m.last_read_at || '1970-01-01T00:00:00Z';
  });

  const out = [];
  for (const r of rooms) {
    if (r.type === 'channel') {
      // Auto-join the org-wide channel if the user isn't a member yet
      if (!myRoomIds.has(Number(r.id))) {
        await _ensureChannelMember(r.id, me.id);
        myRoomIds.add(Number(r.id));
        lastReadByRoom[Number(r.id)] = '1970-01-01T00:00:00Z';
      }
    } else if (r.type === 'dm') {
      if (!myRoomIds.has(Number(r.id))) continue;
    }

    const last = latestByRoom[Number(r.id)];
    const lastReadAt = lastReadByRoom[Number(r.id)] || '1970-01-01T00:00:00Z';
    const unread = messages.filter(m =>
      Number(m.room_id) === Number(r.id) &&
      Number(m.user_id) !== Number(me.id) &&
      String(m.created_at) > String(lastReadAt)
    ).length;

    let label = r.name || '';
    let counterpartId = null;
    if (r.type === 'dm') {
      const ms = members.filter(m => Number(m.room_id) === Number(r.id));
      const other = ms.find(m => Number(m.user_id) !== Number(me.id));
      if (other) {
        counterpartId = Number(other.user_id);
        label = usersById[counterpartId]?.name || ('User #' + counterpartId);
      }
    }
    out.push({
      id: r.id,
      type: r.type,
      label,
      counterpart_id: counterpartId,
      last_message: last ? (last.body || '') : '',
      last_message_user: last ? (usersById[Number(last.user_id)]?.name || '') : '',
      last_at: last ? last.created_at : r.created_at,
      unread
    });
  }

  // Channel first, then DMs by most recent activity
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'channel' ? -1 : 1;
    return String(b.last_at).localeCompare(String(a.last_at));
  });
  return out;
}

/**
 * Fetch the last 200 messages of a room, oldest-first so the chat log
 * scrolls naturally. Auto-marks the room as read for the caller.
 */
async function api_chat_messages_list(token, roomId) {
  const me = await authUser(token);
  await _ensureCanChat(me);
  if (!roomId) throw new Error('roomId required');
  // Membership check — channels everyone, DMs only members
  const room = await db.findById('chat_rooms', roomId);
  if (!room) throw new Error('Room not found');
  const memberRow = (await db.getAll('chat_room_members'))
    .find(m => Number(m.room_id) === Number(roomId) &&
               Number(m.user_id) === Number(me.id));
  if (!memberRow && room.type !== 'channel') throw new Error('Forbidden');

  const usersById = await _userMap();
  const all = await db.getAll('chat_messages');
  const rows = all
    .filter(m => Number(m.room_id) === Number(roomId))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(-200);

  // Mark read — but only after we've loaded so we still see correct unread
  // counts during the same load
  if (memberRow) {
    await db.update('chat_room_members', memberRow.id, {
      last_read_at: db.nowIso()
    });
  } else {
    // Channel: ensure membership now exists for read-tracking
    await _ensureChannelMember(roomId, me.id);
    const m = (await db.getAll('chat_room_members'))
      .find(x => Number(x.room_id) === Number(roomId) &&
                 Number(x.user_id) === Number(me.id));
    if (m) await db.update('chat_room_members', m.id, { last_read_at: db.nowIso() });
  }

  return rows.map(m => ({
    id: m.id,
    user_id: m.user_id,
    user_name: usersById[Number(m.user_id)]?.name || 'Unknown',
    body: m.body || '',
    created_at: m.created_at,
    is_mine: Number(m.user_id) === Number(me.id)
  }));
}

async function api_chat_send(token, payload) {
  const me = await authUser(token);
  await _ensureCanChat(me);
  const p = payload || {};
  let roomId = p.room_id;
  if (!roomId && p.user_id) {
    // Convenience: caller passed user_id to start a DM — find/create the room
    const room = await _ensureDmRoom(me, p.user_id);
    roomId = room.id;
  }
  if (!roomId) throw new Error('room_id or user_id required');
  if (!p.body || !String(p.body).trim()) throw new Error('Message body is empty');

  const room = await db.findById('chat_rooms', roomId);
  if (!room) throw new Error('Room not found');

  // Membership check
  if (room.type === 'dm') {
    const m = (await db.getAll('chat_room_members'))
      .find(x => Number(x.room_id) === Number(roomId) &&
                 Number(x.user_id) === Number(me.id));
    if (!m) throw new Error('Forbidden');
  } else if (room.type === 'channel') {
    await _ensureChannelMember(roomId, me.id);
  }

  const id = await db.insert('chat_messages', {
    room_id: roomId, user_id: me.id,
    body: String(p.body).slice(0, 4000),
    created_at: db.nowIso()
  });

  // Push notification to the other DM party (or to nobody for channel —
  // we'd spam the whole org otherwise; channel notifications could be a
  // future opt-in feature)
  try {
    if (room.type === 'dm') {
      const members = (await db.getAll('chat_room_members'))
        .filter(m => Number(m.room_id) === Number(roomId));
      const other = members.find(m => Number(m.user_id) !== Number(me.id));
      if (other) {
        const push = require('./push');
        await push.sendPushToUser(other.user_id, {
          title: '💬 ' + (me.name || 'Teammate'),
          body: String(p.body).slice(0, 160),
          // Deep-link straight to this conversation. The chat tab parses the
          // ?room= param and auto-opens the matching room so the recipient
          // lands inside the DM with one tap.
          url: '/#/teamchat?room=' + roomId,
          tag: 'chat-' + roomId
        });
      }
    }
  } catch (e) {
    // non-fatal — message still saved
    console.warn('[chat] push notify failed:', e.message);
  }

  return { id, room_id: roomId };
}

async function api_chat_markRead(token, roomId) {
  const me = await authUser(token);
  const memberRow = (await db.getAll('chat_room_members'))
    .find(m => Number(m.room_id) === Number(roomId) &&
               Number(m.user_id) === Number(me.id));
  if (memberRow) {
    await db.update('chat_room_members', memberRow.id, {
      last_read_at: db.nowIso()
    });
  }
  return { ok: true };
}

/**
 * Compact summary used by the global topbar bell — total unread chat
 * messages across all the user's rooms. Cheap enough to call alongside
 * the existing api_notifications_mine on every page navigation.
 */
async function api_chat_unreadCount(token) {
  const me = await authUser(token);
  const [rooms, members, messages] = await Promise.all([
    db.getAll('chat_rooms'),
    db.getAll('chat_room_members'),
    db.getAll('chat_messages')
  ]);
  const myMemberships = members.filter(m => Number(m.user_id) === Number(me.id));
  let total = 0;
  for (const m of myMemberships) {
    const lastReadAt = m.last_read_at || '1970-01-01T00:00:00Z';
    const room = rooms.find(r => Number(r.id) === Number(m.room_id));
    if (!room) continue;
    total += messages.filter(msg =>
      Number(msg.room_id) === Number(room.id) &&
      Number(msg.user_id) !== Number(me.id) &&
      String(msg.created_at) > String(lastReadAt)
    ).length;
  }
  return { unread: total };
}

module.exports = {
  api_chat_rooms_list, api_chat_messages_list, api_chat_send,
  api_chat_markRead, api_chat_unreadCount,
  api_chat_visibleUsers, api_chat_myAccess,
  api_chat_settings_get, api_chat_settings_save
};
