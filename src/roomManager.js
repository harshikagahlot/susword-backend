/**
 * In-memory room manager for SusWord.
 * No database — rooms live in server memory only.
 */

const { generateRoomCode } = require('./utils')
const MAX_PLAYERS = 8

// ── In-memory storage ──────────────────────────────────────
const rooms = new Map()           // roomCode → room object
const socketToRoom = new Map()    // socketId → roomCode (lookup index)

// ── Create Room ────────────────────────────────────────────
function createRoom(socketId, playerName) {
  if (!playerName || playerName.trim().length < 2) {
    return { error: 'Name must be at least 2 characters' }
  }

  // Generate unique room code
  let roomCode
  do {
    roomCode = generateRoomCode()
  } while (rooms.has(roomCode))

  const player = {
    id: socketId,
    name: playerName.trim(),
    isHost: true,
  }

  const room = {
    roomCode,
    hostId: socketId,
    players: [player],
    gameState: 'LOBBY',
  }

  rooms.set(roomCode, room)
  socketToRoom.set(socketId, roomCode)

  return { room, player }
}

// ── Join Room ──────────────────────────────────────────────
function joinRoom(socketId, roomCode, playerName) {
  if (!playerName || playerName.trim().length < 2) {
    return { error: 'Name must be at least 2 characters' }
  }

  const code = roomCode?.toUpperCase().trim()
  const room = rooms.get(code)

  if (!room) {
    return { error: 'Room not found. Check the code and try again.' }
  }

  if (room.gameState !== 'LOBBY') {
    return { error: 'Game already in progress' }
  }

  if (room.players.length >= MAX_PLAYERS) {
    return { error: 'Room is full (max 8 players)' }
  }

  const name = playerName.trim()
  const nameTaken = room.players.some(
    p => p.name.toLowerCase() === name.toLowerCase()
  )
  if (nameTaken) {
    return { error: 'That name is already taken in this room' }
  }

  const player = {
    id: socketId,
    name,
    isHost: false,
  }

  room.players.push(player)
  socketToRoom.set(socketId, code)

  return { room, player }
}

// ── Leave Room ─────────────────────────────────────────────
function leaveRoom(socketId) {
  const roomCode = socketToRoom.get(socketId)
  if (!roomCode) return null

  const room = rooms.get(roomCode)
  if (!room) {
    socketToRoom.delete(socketId)
    return null
  }

  const removedPlayer = room.players.find(p => p.id === socketId)
  const removedPlayerName = removedPlayer?.name || 'Unknown'

  // Remove player from room
  room.players = room.players.filter(p => p.id !== socketId)
  socketToRoom.delete(socketId)

  // If room is now empty, delete it
  if (room.players.length === 0) {
    rooms.delete(roomCode)
    return { roomCode, room: null, removedPlayerName }
  }

  // If the host left, assign new host (first remaining player)
  if (room.hostId === socketId) {
    room.hostId = room.players[0].id
    room.players[0].isHost = true
  }

  return { roomCode, room, removedPlayerName }
}

// ── Lookup helpers ─────────────────────────────────────────
function getRoom(roomCode) {
  return rooms.get(roomCode) || null
}

function getRoomBySocketId(socketId) {
  const roomCode = socketToRoom.get(socketId)
  return roomCode ? rooms.get(roomCode) : null
}

module.exports = { createRoom, joinRoom, leaveRoom, getRoom, getRoomBySocketId }
